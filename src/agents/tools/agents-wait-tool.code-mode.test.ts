import { describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { collectorRun } from "./agents-wait-tool.test-support.js";

const registry = vi.hoisted(() => ({ records: new Map<string, SubagentRunRecord>() }));

vi.mock("../subagents/registry/subagent-registry.js", () => ({
  prepareSubagentRunsByRunIds: async (runIds: readonly string[]) => ({
    consume: <T>(consume: (runs: ReadonlyMap<string, SubagentRunRecord>) => T) => ({
      ready: true as const,
      value: consume(
        new Map(
          runIds.flatMap((runId) => {
            const entry = registry.records.get(runId);
            return entry ? [[runId, entry] as const] : [];
          }),
        ),
      ),
    }),
  }),
}));

vi.mock("../subagents/registry/subagent-registry-state.js", () => ({
  onSubagentRegistryPersisted: () => () => {},
}));

import { codeModeSwarmHandlers } from "../code-mode-swarm.runtime.js";

describe("Code Mode agentWait ownership", () => {
  it("authorizes only the run's own collectors when the policy key differs", async () => {
    registry.records.set("owned", collectorRun("owned", "agent:main:main", { status: "done" }));
    registry.records.set(
      "foreign",
      collectorRun("foreign", "agent:main:telegram:default:direct:456", { status: "done" }),
    );
    const config = { tools: { swarm: true } };
    const wait = (runId: string) =>
      codeModeSwarmHandlers.agentWait({
        request: { id: `bridge:agentWait:${runId}`, method: "agentWait", args: [runId] },
        ctx: {
          config,
          runtimeConfig: config,
          agentId: "main",
          sessionKey: "agent:main:telegram:default:direct:123",
          runSessionKey: "agent:main:main",
        },
      });

    await expect(wait("owned")).resolves.toMatchObject({ runId: "owned", status: "done" });
    await expect(wait("foreign")).rejects.toThrow("agents.run not_owner: foreign");
  });
});
