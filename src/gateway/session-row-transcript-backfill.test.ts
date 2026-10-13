import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  waitForSessionTranscriptIndexReconcile,
} from "../config/sessions/session-transcript-reconcile.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { backfillSessionRowTranscriptFields } from "./session-row-transcript-backfill.js";
import { readSessionRowTranscriptFields } from "./session-row-transcript-backfill.worker.js";

const generateConversationLabelWithFallback = vi.hoisted(() => vi.fn());
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback,
}));
vi.mock("../agents/utility-model.js", () => ({
  resolveUtilityModelRefForAgent: () => undefined,
}));

beforeEach(() => {
  generateConversationLabelWithFallback.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

type BackfillParams = Parameters<typeof backfillSessionRowTranscriptFields>[0];

function sessionDatabaseOptions(params: BackfillParams) {
  return {
    agentId: params.agentId,
    path: resolveSqliteTargetFromSessionStorePath(params.storePath, {
      agentId: params.agentId,
    }).path,
  };
}

async function withColdStore(params: BackfillParams, read: () => Promise<void>) {
  const options = sessionDatabaseOptions(params);
  await waitForSessionTranscriptIndexReconcile(options);
  await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
  expect(getOpenClawAgentDatabaseIfOpen(options) === undefined).toBe(true);
  const opened: Array<{
    database: ReturnType<typeof nodeSqlite.openNodeSqliteDatabase>;
    readOnly: boolean;
  }> = [];
  const actualOpen = nodeSqlite.openNodeSqliteDatabase;
  const observe = vi
    .spyOn(nodeSqlite, "openNodeSqliteDatabase")
    .mockImplementation((location, opts) => {
      const database = actualOpen(location, opts);
      if (
        nodeSqlite.resolveSqliteFilesystemPath(database.location() ?? "") ===
        nodeSqlite.resolveSqliteFilesystemPath(options.path)
      ) {
        opened.push({ database, readOnly: opts?.readOnly === true });
      }
      return database;
    });
  try {
    await read();
    expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(false);
    expect(getOpenClawAgentDatabaseIfOpen(options) === undefined).toBe(true);
    expect(opened.every(({ readOnly }) => readOnly)).toBe(true);
  } finally {
    observe.mockRestore();
    // Failed pre-fix assertions must still join any accidentally admitted rebuild.
    await waitForSessionTranscriptIndexReconcile(options);
    await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
  }
  expect(opened.every(({ database }) => !database.isOpen)).toBe(true);
}

async function withSession(
  run: (params: BackfillParams) => Promise<void>,
  messages: Array<Record<string, unknown>> = [
    { role: "user", content: "Investigate why the gateway times out" },
    { role: "assistant", content: "**Found** the slow query" },
  ],
  entry: Partial<InternalSessionEntry> = {},
) {
  await withOpenClawTestState({ label: "session-row-backfill" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const params = {
      agentId: "main",
      storePath: state.statePath("sessions.json"),
      sessionKey: "agent:main:dashboard:legacy",
      sessionId: "legacy-session",
      lifecycleRevision: "legacy-lifecycle",
    };
    await sessionAccessor.persistSessionTranscriptTurn(params, {
      messages: messages.map((message) => ({ message })),
      touchSessionEntry: false,
    });
    await sessionAccessor.replaceSessionEntry(params, {
      sessionId: params.sessionId,
      lifecycleRevision: params.lifecycleRevision,
      status: "done",
      updatedAt: 12,
      lastActivityAt: 11,
      lastInteractionAt: 10,
      ...entry,
    });
    await run({
      ...params,
      sessionEntry: expectDefined(sessionAccessor.loadSessionEntry(params), "seeded session entry"),
    });
  });
}

describe("session row transcript backfill", () => {
  it("reads a cold preview without admitting a writer or changing legacy metadata", async () => {
    await withSession(
      async (params) => {
        await withColdStore(params, async () => {
          const hostSql = observeHostDataSql();
          try {
            await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual({
              lastMessagePreview: "Found the slow query",
            });
            for (const statement of hostSql.calls) {
              expect(statement).not.toHaveBeenCalled();
            }
          } finally {
            hostSql.restore();
          }
          expect(sessionAccessor.loadSessionEntryReadOnly(params)).toEqual(params.sessionEntry);
          expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
        });
      },
      [
        { role: "user", content: "Internal relay", provenance: { kind: "inter_session" } },
        { role: "user", content: "Investigate why the gateway times out" },
        { role: "assistant", content: "**Found** the slow query" },
      ],
    );
  });

  it.each([
    "current",
    "unavailable",
    "absent",
    "runtime alias",
    "media-only rewrite",
    "hidden rewrite",
    "silent rewrite",
  ] as const)(
    "reads optional terminal fallback fields without writer admission (%s)",
    async (storage) => {
      const alias = storage === "runtime alias";
      const mediaRewrite = storage === "media-only rewrite" || storage === "hidden rewrite";
      const silentRewrite = storage === "silent rewrite";
      const preview = alias
        ? "Finished on equivalent runtime"
        : mediaRewrite
          ? "MEDIA:./proof.png"
          : silentRewrite
            ? "NO_REPLY"
            : "Finished with fallback";
      await withSession(
        async (seeded) => {
          if (alias) {
            cliBackendsTesting.setDepsForTest({
              resolvePluginSetupCliBackend: () => undefined,
              resolveRuntimeCliBackends: () => [
                {
                  id: "synthetic-cli",
                  modelProvider: "unit-test",
                  pluginId: "synthetic-runtime",
                  config: { command: "synthetic-cli" },
                },
              ],
            });
          }
          const params = {
            ...seeded,
            ...(storage === "absent" ? { storePath: `${seeded.storePath}.missing.sqlite` } : {}),
            model: alias
              ? { selectedProvider: "synthetic-cli", selectedModel: "same", config: {} }
              : { selectedProvider: "unit-test", selectedModel: "selected" },
          };
          const options = sessionDatabaseOptions(params);
          if (storage === "unavailable") {
            await waitForSessionTranscriptIndexReconcile(options);
            openOpenClawAgentDatabase(options)
              .db.prepare(
                "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
              )
              .run(params.sessionId);
          }
          if (storage === "absent") {
            expect(fs.existsSync(options.path)).toBe(false);
          }
          try {
            await withColdStore(params, async () => {
              const hostSql = observeHostDataSql();
              try {
                await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual(
                  storage === "media-only rewrite"
                    ? { fallbackModel: { provider: "unit-test", model: "fallback" } }
                    : storage === "current"
                      ? {
                          lastMessagePreview: "Finished with fallback",
                          fallbackModel: { provider: "unit-test", model: "fallback" },
                        }
                      : alias
                        ? { lastMessagePreview: preview }
                        : {},
                );
                for (const statement of hostSql.calls) {
                  expect(statement).not.toHaveBeenCalled();
                }
              } finally {
                hostSql.restore();
              }
              if (storage === "unavailable") {
                expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(false);
                expect(
                  withOpenClawAgentDatabaseReadOnly(
                    ({ db }) =>
                      db
                        .prepare(
                          "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
                        )
                        .get(params.sessionId),
                    options,
                  ),
                ).toEqual({ found: true, value: { needs_rebuild: 1 } });
              }
              if (storage === "absent") {
                expect(fs.existsSync(options.path)).toBe(false);
              }
            });
          } finally {
            if (alias) {
              cliBackendsTesting.resetDepsForTest();
            }
          }
        },
        [
          {
            role: "assistant",
            content: preview,
            ...(mediaRewrite || silentRewrite
              ? {
                  openclawDisplayContent: [
                    {
                      type: "image",
                      url: "/api/chat/media/outgoing/proof.png",
                      mimeType: "image/png",
                    },
                  ],
                }
              : {}),
            ...(storage === "hidden rewrite" ? { display: false } : {}),
            provider: "unit-test",
            model: alias ? "same" : "fallback",
            stopReason: "stop",
            __openclaw: { runId: "terminal-run" },
          },
        ],
        {
          lastRunId: "terminal-run",
          fallbackNotice: {
            kind: "active",
            selectedModel: alias ? "synthetic-cli/same" : "unit-test/selected",
            activeModel: alias ? "unit-test/same" : "unit-test/fallback",
          },
        },
      );
    },
  );

  it("reads preview and terminal facts once and sees the next committed transcript", async () => {
    await withSession(
      async (params) => {
        const reads = observeSqliteReadSql(nodeSqlite.requireNodeSqlite().StatementSync.prototype);
        const read = () => {
          reads.queries.length = 0;
          const fields = readSessionRowTranscriptFields({ ...params, includeTerminalModel: true });
          expect(
            reads.queries.filter((sql) => sql.includes('from "transcript_events" as "event"')),
          ).toHaveLength(1);
          expect(
            reads.queries.filter(
              (sql) =>
                sql.includes('from "session_transcript_active_events" as "active"') &&
                sql.includes('as "serialized_bytes"'),
            ),
          ).toHaveLength(1);
          return fields;
        };
        try {
          expect(read()).toEqual({
            lastMessagePreview: "First terminal reply",
            terminalModel: { modelProvider: "unit-test", model: "fallback" },
          });
          await sessionAccessor.persistSessionTranscriptTurn(params, {
            messages: [
              {
                message: {
                  role: "assistant",
                  content: "Next terminal reply",
                  provider: "unit-test",
                  model: "next-fallback",
                  stopReason: "stop",
                  __openclaw: { runId: "terminal-run" },
                },
              },
            ],
            touchSessionEntry: false,
          });
          expect(read()).toEqual({
            lastMessagePreview: "Next terminal reply",
            terminalModel: { modelProvider: "unit-test", model: "next-fallback" },
          });
        } finally {
          reads.restore();
        }
      },
      [
        {
          role: "assistant",
          content: "First terminal reply",
          provider: "unit-test",
          model: "fallback",
          stopReason: "stop",
          __openclaw: { runId: "terminal-run" },
        },
      ],
      {
        lastRunId: "terminal-run",
        fallbackNotice: {
          kind: "active",
          selectedModel: "unit-test/selected",
          activeModel: "unit-test/fallback",
        },
      },
    );
  });

  it("reads terminal facts beyond the preview budget without showing an older preview", async () => {
    await withSession(
      async (params) => {
        expect(readSessionRowTranscriptFields({ ...params, includeTerminalModel: true })).toEqual({
          terminalModel: { modelProvider: "unit-test", model: "fallback" },
        });
      },
      [
        { role: "assistant", content: "Older preview" },
        {
          role: "assistant",
          content: "x".repeat(70 * 1024),
          provider: "unit-test",
          model: "fallback",
          stopReason: "stop",
          __openclaw: { runId: "terminal-run" },
        },
      ],
      {
        lastRunId: "terminal-run",
        fallbackNotice: {
          kind: "active",
          selectedModel: "unit-test/selected",
          activeModel: "unit-test/fallback",
        },
      },
    );
  });

  it("does not parse oversized bodies or name a session from an incomplete prefix", async () => {
    const oversized = `oversized-title-payload ${"x".repeat(70 * 1024)}`;
    await withSession(
      async (params) => {
        const parse = JSON.parse;
        let oversizedParses = 0;
        vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
          if (text.includes("oversized-title-payload")) {
            oversizedParses++;
          }
          return parse(text, reviver);
        });
        expect(readSessionRowTranscriptFields(params)).toEqual({
          lastMessagePreview: "Latest reply",
        });
        expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBeUndefined();
        expect(oversizedParses).toBe(0);
      },
      [
        { role: "user", content: oversized },
        { role: "user", content: "A later task must not become the title" },
        { role: "assistant", content: "Latest reply" },
      ],
    );
  });

  it("keeps an explicit title and omits a preview when its newest message is oversized", async () => {
    await withSession(
      async (params) => {
        await sessionAccessor.patchSessionEntryCore(params, () => ({ displayName: "My title" }));
        await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual({});
        expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBe("My title");
        expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
      },
      [
        { role: "user", content: "Old user prompt" },
        { role: "assistant", content: "Old reply" },
        { role: "assistant", content: "x".repeat(70 * 1024) },
      ],
    );
  });
});
