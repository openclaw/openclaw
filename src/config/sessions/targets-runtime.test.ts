import path from "node:path";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { replaceSessionEntry } from "./session-accessor.js";
import {
  listKnownSessionStoreAgentIdsAsync,
  resolveAllAgentSessionStoreTargetsAsync,
  resolveExistingAgentSessionStoreTargetsAsync,
} from "./targets-runtime.js";

it("discovers committed owners and stores without executing host SQL", async () => {
  await withOpenClawTestState({ label: "target-discovery-worker" }, async (state) => {
    const storePath = path.join(state.root, "shared.sqlite");
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      },
    };
    const write = (agentId: string) =>
      replaceSessionEntry(
        { agentId, env: state.env, storePath, sessionKey: `agent:${agentId}:main` },
        { sessionId: `${agentId}-session`, updatedAt: 1 },
      );
    await write("main");
    expect(await resolveExistingAgentSessionStoreTargetsAsync(cfg, "ops", state)).toEqual([]);
    await write("ops");
    const observed = observeHostDataSql();
    try {
      expect(await resolveExistingAgentSessionStoreTargetsAsync(cfg, "ops", state)).toEqual([
        { agentId: "ops", storePath },
      ]);
      expect(await listKnownSessionStoreAgentIdsAsync(cfg, state)).toEqual(["main", "ops"]);
      expect(await resolveAllAgentSessionStoreTargetsAsync(cfg, state)).toContainEqual({
        agentId: "main",
        storePath,
      });
      expect(observed.queries).toEqual([]);
    } finally {
      observed.restore();
    }
  });
});
