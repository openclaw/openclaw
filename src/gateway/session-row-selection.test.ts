import { expect, it } from "vitest";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

it("rejects duplicate ordinary keys introduced after store admission before filtering or pagination", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const primary = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const secondary = state.statePath("secondary.sqlite");
    const key = "agent:main:original";
    for (const [storePath, sessionKey] of [
      [primary, key],
      [secondary, "agent:main:other"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey },
        { sessionId: sessionKey, updatedAt: Date.now() },
      );
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      const opts = { configuredAgentsOnly: true };
      expect((await listProjectedSessions({ projection, opts })).sessions).toHaveLength(2);
      const duplicate = { agentId: "main", storePath: secondary, sessionKey: key };
      replaceSessionEntrySync(duplicate, { sessionId: "duplicate", updatedAt: Date.now() + 1 });
      await expect(
        listProjectedSessions({ projection, opts: { ...opts, limit: 1, offset: 1 } }),
      ).rejects.toThrow("duplicate rows resolve to canonical session key");
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: secondary,
        archiveTranscript: false,
        target: { canonicalKey: key, storeKeys: [key] },
      });
      const result = await listProjectedSessions({ projection, opts });
      expect(result.sessions.map((row) => row.key).toSorted()).toEqual([key, "agent:main:other"]);
    } finally {
      projection.dispose();
    }
  });
});
