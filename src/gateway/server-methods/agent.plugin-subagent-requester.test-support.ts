import { it, vi } from "vitest";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { registerPluginSubagentRunFromGateway } from "./agent-subagent-registration.js";
import { withPluginSubagentTestState } from "./agent.spawned-child.test-support.js";
import { expectRecordFields, requireValue } from "./agent.test-harness.js";

export function registerPluginSubagentRequesterLineageTest(): void {
  it("registers host-owned requester lineage for plugin subagent completion", async () => {
    await withPluginSubagentTestState("openclaw-gateway-plugin-subagent-requester-", async () => {
      const childSessionKey = "agent:work:subagent:plugin-completion";
      const requester = {
        sessionKey: "agent:main:telegram:direct:123",
        origin: {
          channel: "telegram",
          to: "telegram:123",
          accountId: "work",
          threadId: 42,
        },
      } as const;

      await registerPluginSubagentRunFromGateway({
        assertCurrent: vi.fn(),
        cfg: {
          session: { mainKey: "main", scope: "per-sender" },
          agents: {
            list: [{ id: "main", default: true }, { id: "work" }],
          },
        },
        runId: "plugin-subagent-current-requester",
        childSessionKey,
        task: "background plugin subagent task",
        requester,
        pluginId: "memory-core",
      });

      const run = requireValue(
        getSubagentRunByChildSessionKey(childSessionKey),
        "expected requester-bound plugin subagent run",
      );
      expectRecordFields(run, {
        controllerSessionKey: "agent:work:main",
        requesterSessionKey: requester.sessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: requester.sessionKey,
        requesterOrigin: requester.origin,
        label: "plugin:memory-core",
      });
      expectRecordFields(run.completion, { required: true });
    });
  });
}
