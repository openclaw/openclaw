import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

// Retained-tail pages select positions through a JSON array binding, which must expand on
// PostgreSQL as well as SQLite. The public reader runs the full worker and projection path.
describe.skipIf(!connection)("PostgreSQL context-engine reset-window reads", () => {
  let root: string;
  let suiteEnv: NodeJS.ProcessEnv;
  const client = new pg.Client({ connectionString: connection });
  const scope = (sessionId: string) => ({
    agentId: "main",
    env: suiteEnv,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(root, "shared", "shared.sqlite"),
  });

  // Drains every page the way a context engine would, returning entry ids.
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

  beforeAll(async () => {
    root = directories.make("reset-window-postgres-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    suiteEnv = { ...process.env };
    setRuntimeConfigSnapshot({});
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: prefix },
    });
    await client.connect();
    withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: suiteEnv }));
  });

  afterAll(async () => {
    if (!connection) {
      return;
    }
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
  });

  it("drains the retained tail, then the post-reset suffix, after a preserve-tail reset", async () => {
    const target = scope("preserve-tail");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    for (const [eventId, message] of [
      ["old-0", { role: "user", content: "q0" }],
      ["old-1", { role: "assistant", content: "a1" }],
      ["old-2", { role: "user", content: "q2" }],
      ["old-3", { role: "assistant", content: "a3" }],
      ["old-4", { role: "user", content: "q4" }],
      [
        "old-5",
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
          stopReason: "toolUse",
        },
      ],
      [
        "old-6",
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "paired" }],
          isError: false,
        },
      ],
      [
        "old-7",
        {
          role: "toolResult",
          toolCallId: "orphan-call",
          toolName: "read",
          content: [{ type: "text", text: "orphan" }],
          isError: false,
        },
      ],
      ["old-8", { role: "assistant", content: "a8" }],
      ["old-9", { role: "user", content: "q9" }],
      ["old-10", { role: "assistant", content: "a10" }],
    ] as const) {
      await appendSessionTranscriptMessageByIdentity({ ...target, eventId, message });
    }
    // A reset that keeps the tail from old-4, as a preserve-tail session reset records it.
    const manager = await SessionManager.openAsync(target, root);
    await manager.appendResetBoundaryAsync("idle", "old-4");
    await appendSessionTranscriptMessageByIdentity({
      ...target,
      eventId: "new-user",
      message: { role: "user", content: "new" },
    });

    // The default start is unchanged and still includes pre-reset history.
    await expect(drain({ ...target, maxMessages: 4 })).resolves.toEqual([
      "old-0",
      "old-1",
      "old-2",
      "old-3",
      "old-4",
      "old-5",
      "old-6",
      "old-7",
      "old-8",
      "old-9",
      "old-10",
      "new-user",
    ]);
    // Same scenario as the SQLite SDK test: the retained tail (without the orphan result),
    // then the suffix. Small pages force retained positions through the array binding.
    await expect(drain({ ...target, maxMessages: 4, start: "reset-window" })).resolves.toEqual([
      "old-4",
      "old-5",
      "old-6",
      "old-8",
      "old-9",
      "old-10",
      "new-user",
    ]);
  });
});
