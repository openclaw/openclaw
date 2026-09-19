import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewaySessionStoreReadSources } from "./session-utils-store-sources.js";

it("bounds roster reads per preparation and observes later mutable fleet changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const agentIds = ["main", ...Array.from({ length: 47 }, (_, i) => `worker-${i}`)];
    let entryReads = 0;
    const entries = new Proxy(Object.fromEntries(agentIds.map((agentId) => [agentId, {}])), {
      get(target, property, receiver) {
        if (Object.hasOwn(target, property)) {
          entryReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries } };
    const prepare = () =>
      prepareGatewaySessionStoreReadSources({
        cfg,
        currentSource: { agentId: database.agentId, path: database.path },
        env: state.env,
        registryPath: openOpenClawStateDatabase().path,
      });

    const first = prepare();
    expect(Object.keys(first.sources)).toEqual(agentIds);
    expect(entryReads).toBeLessThan(agentIds.length * 16);

    entries.added = {};
    entryReads = 0;
    expect(Object.keys(prepare().sources)).toEqual([...agentIds, "added"]);
    expect(entryReads).toBeLessThan((agentIds.length + 1) * 16);
    expect(Object.keys(first.sources)).toEqual(agentIds);
  });
});

it("binds source addresses before asynchronous callers yield", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const currentSource = { agentId: database.agentId, path: database.path };
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const env = { ...state.env };
    const prepared = prepareGatewaySessionStoreReadSources({
      cfg,
      currentSource,
      env,
      registryPath: openOpenClawStateDatabase().path,
    });

    await Promise.resolve();
    cfg.session = { store: path.join(state.stateDir, "moved", "{agentId}", "sessions.json") };
    env.OPENCLAW_STATE_DIR = state.path("different-state");

    expect(prepared.sources.main).toEqual([currentSource]);
    expect(() => prepared.assertCurrent()).not.toThrow();
  });
});
