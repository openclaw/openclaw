import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  appendTranscriptEvent,
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { appendSessionTranscriptMessageByIdentity } from "../../plugin-sdk/session-transcript-runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const prefix = `resetplace_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const directories = useAutoCleanupTempDirTracker(afterAll);

// Retained-tail pages select positions through a JSON array binding, which must expand on
// PostgreSQL as well as SQLite. The public reader runs the full worker and projection path.
describe.skipIf(!connection)(
  "PostgreSQL preserve-tail reset with a placed background result",
  () => {
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

    beforeAll(async () => {
      root = directories.make("reset-placement-postgres-");
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
        await dropPostgresTestSchemas(client, prefix);
      } finally {
        await client.end();
        clearRuntimeConfigSnapshot();
        resetDatabaseEngineSelectionForTest();
        vi.unstubAllEnvs();
      }
    });

    it.each(["idle", "daily"] as const)(
      "keeps the tail through a %s reset after a background result was placed",
      async (reason) => {
        // The reset resolves its database from the process environment, not the scope.
        vi.stubEnv("OPENCLAW_STATE_DIR", root);
        vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
        const target = scope(`placed-${reason}`);
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const append = (eventId: string, message: Record<string, unknown>) =>
          appendSessionTranscriptMessageByIdentity({ ...target, eventId, message });
        await append("user-1", { role: "user", content: "start the job" });
        await append("assistant-1", { role: "assistant", content: "started" });
        // A background job's result waits outside model context until the next request places it.
        await append("result-1", {
          role: "assistant",
          content: [{ type: "text", text: "job finished" }],
          provider: "openclaw",
          model: "automation-result",
          stopReason: "stop",
          excludeFromContext: true,
          openclawModelPlacement: "pending",
        });
        await expect(
          appendTranscriptEvent(target, {
            type: "custom",
            id: "placement-1",
            parentId: "result-1",
            timestamp: new Date(4).toISOString(),
            customType: BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
            data: { afterEntryId: "result-1", resultEntryIds: ["result-1"] },
          }),
        ).resolves.toBe(true);
        await append("user-2", { role: "user", content: "what did it say?" });
        await append("assistant-2", { role: "assistant", content: "it finished" });

        await resetSessionEntryLifecycle({
          storePath: target.storePath,
          target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
          buildNextEntry: () => ({ sessionId: target.sessionId, updatedAt: 20 }),
          resetBoundary: { context: "preserve-tail", reason, cwd: root },
        });

        const events = await loadTranscriptEvents(target);
        const boundary = events.find(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "reset",
        );
        expect(boundary).toMatchObject({
          reason,
          parentId: "assistant-2",
          firstKeptEntryId: "user-1",
        });
      },
    );
  },
);
