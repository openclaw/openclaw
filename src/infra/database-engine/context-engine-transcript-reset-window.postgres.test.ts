import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { SessionManager } from "../../plugin-sdk/agent-sessions.js";
import {
  readSessionTranscriptVisibleMessageDelta,
  type SessionTranscriptVisibleMessageDeltaParams,
} from "../../plugin-sdk/context-engine-transcript-runtime.js";
import { appendSessionTranscriptMessageByIdentity } from "../../plugin-sdk/session-transcript-runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const prefix = `resetwindow_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const directories = useAutoCleanupTempDirTracker(afterAll);

// Small pages exercise PostgreSQL's retained-position array binding through the public reader.
async function drain(params: SessionTranscriptVisibleMessageDeltaParams) {
  const ids: string[] = [];
  let cursor = params.cursor;
  for (;;) {
    const next = await readSessionTranscriptVisibleMessageDelta({ ...params, cursor });
    if (next.kind !== "page") {
      throw new Error(`expected a transcript page, got ${next.kind}`);
    }
    ids.push(...next.entries.map((entry) => entry.entryId));
    cursor = next.cursor;
    if (!next.hasMore) {
      return ids;
    }
  }
}

it.skipIf(!connection)(
  "drains PostgreSQL retained-tail pages and the post-reset suffix",
  async () => {
    const root = directories.make("reset-window-postgres-");
    const client = new pg.Client({ connectionString: connection });
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    const suiteEnv = { ...process.env };
    setRuntimeConfigSnapshot({});
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: prefix },
    });
    try {
      await client.connect();
      withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: suiteEnv }));
      const target = {
        agentId: "main",
        env: suiteEnv,
        sessionId: "preserve-tail",
        sessionKey: "agent:main:preserve-tail",
        storePath: path.join(root, "shared", "shared.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const toolResult = (toolCallId: string, text: string) =>
        ({
          role: "toolResult",
          toolCallId,
          toolName: "read",
          content: [{ type: "text", text }],
          isError: false,
        }) as const;
      const messages = [
        { role: "user", content: "q0" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "a3" },
        { role: "user", content: "q4" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
          stopReason: "toolUse",
        },
        toolResult("call-1", "paired"),
        toolResult("orphan-call", "orphan"),
        { role: "assistant", content: "a8" },
        { role: "user", content: "q9" },
        { role: "assistant", content: "a10" },
      ] as const;
      for (const [index, message] of messages.entries()) {
        await appendSessionTranscriptMessageByIdentity({
          ...target,
          eventId: `old-${index}`,
          message,
        });
      }
      // A reset that keeps the tail from old-4, as a preserve-tail session reset records it.
      const manager = await SessionManager.openAsync(target, root);
      await manager.appendResetBoundaryAsync("idle", "old-4");
      await appendSessionTranscriptMessageByIdentity({
        ...target,
        eventId: "new-user",
        message: { role: "user", content: "new" },
      });

      await expect(drain({ ...target, maxMessages: 4 })).resolves.toEqual([
        ...Array.from({ length: 11 }, (_, index) => `old-${index}`),
        "new-user",
      ]);
      // The retained tail excludes the orphan result but keeps the paired tool call/result.
      await expect(drain({ ...target, maxMessages: 4, start: "reset-window" })).resolves.toEqual([
        "old-4",
        "old-5",
        "old-6",
        "old-8",
        "old-9",
        "old-10",
        "new-user",
      ]);
    } finally {
      try {
        await cleanupSessionStateForTest({ stateDir: root });
        const schemas = await client.query<{ nspname: string }>(
          "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
          [prefix.length + 1, `${prefix}_`],
        );
        for (const { nspname } of schemas.rows) {
          await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
        }
      } finally {
        await client.end();
        clearRuntimeConfigSnapshot();
        resetDatabaseEngineSelectionForTest();
        vi.unstubAllEnvs();
      }
    }
  },
);
