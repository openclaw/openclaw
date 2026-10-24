import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
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

afterEach(() => {
  vi.restoreAllMocks();
});

type BackfillParams = Parameters<typeof backfillSessionRowTranscriptFields>[0];

const fallbackEntry = {
  lastRunId: "terminal-run",
  fallbackNotice: {
    kind: "active",
    selectedModel: "unit-test/selected",
    activeModel: "unit-test/fallback",
  },
} satisfies Partial<InternalSessionEntry>;
const terminalModel = (model = "fallback") => ({
  runId: "terminal-run",
  modelProvider: "unit-test",
  model,
});
const terminalMessage = (content: string, model = "fallback") => ({
  role: "assistant",
  content,
  provider: "unit-test",
  model,
  stopReason: "stop",
  __openclaw: { runId: "terminal-run" },
});
const assistantPreview = (text: string) => ({
  lastMessagePreview: text,
  lastAssistantMessage: { text, timestamp: expect.any(Number) },
});

function readFacts(params: BackfillParams) {
  return readSessionRowDatabaseFacts({
    kind: "session-row-facts",
    database: sessionDatabaseOptions(params),
    env: process.env,
    sessionKeys: [params.sessionKey],
  }).rows[0];
}

async function withoutHostSql(run: () => Promise<void>) {
  const hostSql = observeHostDataSql();
  try {
    await run();
    for (const statement of hostSql.calls) {
      expect(statement).not.toHaveBeenCalled();
    }
  } finally {
    hostSql.restore();
  }
}

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
  it("rebuilds cached heartbeat acknowledgements and retains the conversational assistant reply", async () => {
    await withSession(
      async (params) => {
        const options = sessionDatabaseOptions(params);
        const fields = expectDefined(backfillInDatabase(params), "seeded transcript fields");
        runOpenClawAgentWriteTransaction(({ db }) => {
          db.prepare("UPDATE session_windows SET row_transcript_json = ? WHERE session_id = ?").run(
            JSON.stringify({
              ...fields,
              lastMessagePreview: "HEARTBEAT_OK",
              lastAssistantMessage: { text: "HEARTBEAT_OK", timestamp: 200 },
            }),
            params.sessionId,
          );
        }, options);
        expect(readFacts(params)?.transcriptAssistantMessage).toBe("unknown");
        await expect(backfillSessionRowTranscriptFields(params)).resolves.toMatchObject({
          lastAssistantMessage: { text: "The rollout is verified.", timestamp: 100 },
        });
        await withColdStore(params, async () => {
          expect(readFacts(params)?.transcriptAssistantMessage).toEqual({
            text: "The rollout is verified.",
            timestamp: 100,
          });
        });
        await sessionAccessor.persistSessionTranscriptTurn(params, {
          messages: [
            {
              message: {
                role: "assistant",
                content: "HEARTBEAT_OK",
                timestamp: 300,
                provenance: { kind: "inter_session", sourceTool: "sessions_send" },
              },
            },
          ],
          touchSessionEntry: false,
        });
        await expect(backfillSessionRowTranscriptFields(params)).resolves.toMatchObject({
          lastAssistantMessage: { text: "HEARTBEAT_OK", timestamp: 300 },
        });
      },
      [
        { role: "user", content: "Verify the rollout." },
        { role: "assistant", content: "The rollout is verified.", timestamp: 100 },
        {
          role: "user",
          content: "[OpenClaw heartbeat poll]",
          provenance: { kind: "internal_system", sourceTool: "heartbeat" },
        },
        { role: "assistant", content: "HEARTBEAT_OK", timestamp: 200 },
      ],
    );
  });

  it.each([
    "current",
    "unavailable",
    "absent",
    "media-only rewrite",
    "hidden rewrite",
    "silent rewrite",
  ] as const)(
    "backfills optional terminal fallback fields off the host thread (%s)",
    async (storage) => {
      const mediaRewrite = storage === "media-only rewrite" || storage === "hidden rewrite";
      const silentRewrite = storage === "silent rewrite";
      const preview = mediaRewrite
        ? "MEDIA:./proof.png"
        : silentRewrite
          ? "NO_REPLY"
          : "Finished with fallback";
      await withSession(
        async (seeded) => {
          const params = {
            ...seeded,
            ...(storage === "absent" ? { storePath: `${seeded.storePath}.missing.sqlite` } : {}),
            model: { selectedProvider: "unit-test", selectedModel: "selected" },
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
          await withColdStore(params, async () => {
            await withoutHostSql(async () => {
              await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual(
                storage === "media-only rewrite"
                  ? { fallbackModel: { provider: "unit-test", model: "fallback" } }
                  : storage === "current"
                    ? {
                        ...assistantPreview("Finished with fallback"),
                        fallbackModel: { provider: "unit-test", model: "fallback" },
                      }
                    : storage === "unavailable" || storage === "absent"
                      ? undefined
                      : {},
              );
            });
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
        },
        [
          {
            ...terminalMessage(preview),
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
          },
        ],
        fallbackEntry,
      );
    },
  );

  it("refreshes preview and terminal facts after the next committed transcript", async () => {
    await withSession(
      async (params) => {
        expect(backfillInDatabase(params)).toMatchObject({
          lastMessagePreview: "First terminal reply",
          terminalModel: terminalModel(),
        });
        await sessionAccessor.persistSessionTranscriptTurn(params, {
          messages: [{ message: terminalMessage("Next terminal reply", "next-fallback") }],
          touchSessionEntry: false,
        });
        expect(readFacts(params)).toMatchObject({
          transcriptPreview: "Next terminal reply",
          transcriptTerminalModel: terminalModel("next-fallback"),
        });
        expect(backfillInDatabase(params)).toMatchObject({
          lastMessagePreview: "Next terminal reply",
          terminalModel: terminalModel("next-fallback"),
        });
      },
      [terminalMessage("First terminal reply")],
      fallbackEntry,
    );
  });

  it("reuses a completed backfill after reopening and invalidates an equal-mtime legacy import", async () => {
    await withSession(async (params) => {
      const options = sessionDatabaseOptions(params);
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
      expect(readFacts(params)?.transcriptPreview).toBeUndefined();
      await withColdStore(params, async () => {
        await withoutHostSql(async () => {
          await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual(
            assistantPreview("Found the slow query"),
          );
        });
        expect(sessionAccessor.loadSessionEntryReadOnly(params)).toEqual(params.sessionEntry);
      });

      await withColdStore(params, async () => {
        const reads = observeSqliteReadSql(nodeSqlite.requireNodeSqlite().StatementSync.prototype);
        try {
          expect(readFacts(params)).toMatchObject({
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
      expect(readFacts(params)?.transcriptPreview).toBeUndefined();
      await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual({
        lastMessagePreview: "Imported next",
      });
      expect(readFacts(params)?.transcriptPreview).toBe("Imported next");
      // Legacy events without a message or record timestamp cannot rank an agent's reply.
      expect(readFacts(params)?.transcriptAssistantMessage).toBeNull();
    });
  });

  it("reads terminal facts beyond the preview budget without showing older text or changing the title", async () => {
    await withSession(
      async (params) => {
        expect(backfillInDatabase(params)).toMatchObject({
          lastMessagePreview: null,
          lastAssistantMessage: null,
          terminalModel: terminalModel(),
        });
        await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual({});
        expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBe("My title");
      },
      [{ role: "assistant", content: "Older preview" }, terminalMessage("x".repeat(70 * 1024))],
      { ...fallbackEntry, displayName: "My title" },
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
});
