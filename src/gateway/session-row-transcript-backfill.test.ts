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
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import { readSessionRowDatabaseFacts } from "../config/sessions/session-entry-read.worker.js";
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
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { backfillSessionRowTranscriptFields } from "./session-row-transcript-backfill.js";
import { backfillSessionRowTranscriptFieldsInDatabase } from "./session-row-transcript-backfill.worker.js";

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
  try {
    await read();
    expect(getOpenClawAgentDatabaseIfOpen(options) === undefined).toBe(true);
  } finally {
    await waitForSessionTranscriptIndexReconcile(options);
    await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
  }
}

function backfillInDatabase(params: BackfillParams) {
  return runOpenClawAgentWriteTransaction(
    (database) => backfillSessionRowTranscriptFieldsInDatabase(database, params),
    sessionDatabaseOptions(params),
  );
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
  it("backfills a cold preview off the host thread without changing legacy metadata", async () => {
    await withSession(
      async (params) => {
        await withColdStore(params, async () => {
          const hostSql = observeHostDataSql();
          try {
            await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual({
              lastMessagePreview: "Found the slow query",
              lastAssistantMessage: { text: "Found the slow query", timestamp: expect.any(Number) },
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
    "backfills optional terminal fallback fields off the host thread (%s)",
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
                          lastAssistantMessage: {
                            text: "Finished with fallback",
                            timestamp: expect.any(Number),
                          },
                          fallbackModel: { provider: "unit-test", model: "fallback" },
                        }
                      : alias
                        ? {
                            lastMessagePreview: preview,
                            lastAssistantMessage: { text: preview, timestamp: expect.any(Number) },
                          }
                        : storage === "unavailable" || storage === "absent"
                          ? undefined
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
          const fields = backfillInDatabase(params);
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
          expect(read()).toMatchObject({
            lastMessagePreview: "First terminal reply",
            terminalModel: { runId: "terminal-run", modelProvider: "unit-test", model: "fallback" },
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
          expect(
            readSessionRowDatabaseFacts({
              kind: "session-row-facts",
              database: sessionDatabaseOptions(params),
              env: process.env,
              sessionKeys: [params.sessionKey],
            }).rows[0],
          ).toMatchObject({
            transcriptPreview: "Next terminal reply",
            transcriptTerminalModel: {
              runId: "terminal-run",
              modelProvider: "unit-test",
              model: "next-fallback",
            },
          });
          expect(read()).toMatchObject({
            lastMessagePreview: "Next terminal reply",
            terminalModel: {
              runId: "terminal-run",
              modelProvider: "unit-test",
              model: "next-fallback",
            },
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

  it("reuses a completed backfill after reopening and invalidates an equal-mtime legacy import", async () => {
    await withSession(async (params) => {
      const options = sessionDatabaseOptions(params);
      const readFacts = () =>
        readSessionRowDatabaseFacts({
          kind: "session-row-facts",
          database: options,
          env: process.env,
          sessionKeys: [params.sessionKey],
        }).rows[0];
      const transcriptMtimeMs = runOpenClawAgentWriteTransaction(({ db }) => {
        db.prepare(
          "UPDATE session_windows SET row_transcript_json = NULL, row_transcript_updated_at = NULL WHERE session_id = ?",
        ).run(params.sessionId);
        const row = db
          .prepare("SELECT transcript_updated_at FROM session_windows WHERE session_id = ?")
          .get(params.sessionId);
        if (typeof row?.transcript_updated_at !== "number") {
          throw new Error("Seeded transcript has no mutation timestamp");
        }
        return row.transcript_updated_at;
      }, options);
      expect(readFacts()?.transcriptPreview).toBeUndefined();
      await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual({
        lastMessagePreview: "Found the slow query",
        lastAssistantMessage: { text: "Found the slow query", timestamp: expect.any(Number) },
      });

      await withColdStore(params, async () => {
        const reads = observeSqliteReadSql(nodeSqlite.requireNodeSqlite().StatementSync.prototype);
        try {
          expect(readFacts()).toMatchObject({
            transcriptPreview: "Found the slow query",
            transcriptTerminalModel: null,
          });
          expect(
            reads.queries.filter(
              (sql) =>
                sql.includes('from "transcript_events" as "event"') ||
                sql.includes('from "session_transcript_active_events" as "active"'),
            ),
          ).toEqual([]);
        } finally {
          reads.restore();
        }
      });

      await importSqliteSessionRowsBatch([
        {
          ...params,
          entry: params.sessionEntry,
          transcriptMtimeMs,
          readTranscriptEvents: (append) => {
            append({
              type: "message",
              message: { role: "assistant", content: "Imported next" },
            });
          },
        },
      ]);
      expect(
        openOpenClawAgentDatabase(options)
          .db.prepare("SELECT transcript_updated_at FROM session_windows WHERE session_id = ?")
          .get(params.sessionId),
      ).toEqual({ transcript_updated_at: transcriptMtimeMs });
      expect(readFacts()?.transcriptPreview).toBeUndefined();
      await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual({
        lastMessagePreview: "Imported next",
      });
      expect(readFacts()?.transcriptPreview).toBe("Imported next");
      // Legacy events without a message or record timestamp cannot rank an agent's reply.
      expect(readFacts()?.transcriptAssistantMessage).toBeNull();
    });
  });

  it("reads terminal facts beyond the preview budget without showing an older preview", async () => {
    await withSession(
      async (params) => {
        expect(backfillInDatabase(params)).toMatchObject({
          lastMessagePreview: null,
          lastAssistantMessage: null,
          terminalModel: { runId: "terminal-run", modelProvider: "unit-test", model: "fallback" },
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

  it("omits assistant previews outside the bounded message tail", async () => {
    await withSession(
      async (params) => {
        expect(backfillInDatabase(params)).toMatchObject({
          lastMessagePreview: "Followup 20",
          lastAssistantMessage: null,
        });
      },
      [
        { role: "assistant", content: "Older answer", timestamp: 100 },
        ...Array.from({ length: 21 }, (_, index) => ({
          role: "user",
          content: `Followup ${index}`,
        })),
      ],
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
        expect(backfillInDatabase(params)).toMatchObject({
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
