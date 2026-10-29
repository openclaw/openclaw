import { expect, it } from "vitest";
import {
  getSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { registerPluginSubagentRunFromGateway } from "./agent-subagent-registration.js";
import {
  seedPersistedSubagentRunForAgentTest,
  withPluginSubagentTestState,
} from "./agent.spawned-child.test-support.js";
import { expectRecordFields, requireValue } from "./agent.test-harness.js";

export function registerPluginSubagentRequesterLineageCase() {
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
      const sessionEntry = { sessionId: "plugin-completion-session", updatedAt: 1 };

      await registerPluginSubagentRunFromGateway({
        assertCurrent: () => sessionEntry,
        cfg: {
          session: { mainKey: "main", scope: "per-sender" },
          agents: {
            entries: { main: {}, work: {} },
          },
        },
        runId: "plugin-subagent-current-requester",
        childSessionKey,
        childAgentId: "work",
        task: "background plugin subagent task",
        requester,
        pluginId: "memory-core",
      });

      const run = requireValue(
        await getSubagentRunByChildSessionKey(childSessionKey),
        "expected requester-bound plugin subagent run",
      );
      expectRecordFields(run, {
        childSessionIdentity: { sessionId: sessionEntry.sessionId },
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

export function registerPluginSubagentFollowupAdoptionCase() {
  it("still adopts the paused owner for a default follow-up after a requester-bound sibling", async () => {
    await withPluginSubagentTestState(
      "openclaw-gateway-plugin-subagent-mixed-delivery-",
      async () => {
        const childSessionKey = "agent:work:subagent:plugin-yield-mixed-delivery";
        const sessionEntry = { sessionId: "plugin-yield-session", updatedAt: 1 };
        const originalRequester = "agent:main:telegram:direct:777";
        const cfg = {
          session: { mainKey: "main", scope: "per-sender" as const },
          agents: { entries: { main: {}, work: {} } },
        };
        await seedPersistedSubagentRunForAgentTest({
          runId: "plugin-subagent-paused",
          childSessionKey,
          childAgentId: "work",
          childSessionIdentity: { sessionId: sessionEntry.sessionId },
          requesterSessionKey: originalRequester,
          requesterDisplayKey: originalRequester,
          task: "wait for the remote job",
          endedAt: 2_000,
          pauseReason: "sessions_yield",
          expectsCompletionMessage: true,
        });

        // A requester-bound follow-up lands at a higher generation than the paused
        // owner, so it becomes the newest row for this session.
        await registerPluginSubagentRunFromGateway({
          assertCurrent: () => sessionEntry,
          cfg,
          runId: "plugin-subagent-sibling",
          childSessionKey,
          childAgentId: "work",
          task: "deliver to me instead",
          requester: {
            sessionKey: "agent:main:telegram:direct:555",
            origin: { channel: "telegram", to: "telegram:555", accountId: "work" },
          },
          pluginId: "memory-core",
        });

        await registerPluginSubagentRunFromGateway({
          assertCurrent: () => sessionEntry,
          cfg,
          runId: "plugin-subagent-default-followup",
          childSessionKey,
          childAgentId: "work",
          task: "the remote job finished",
          pluginId: "memory-core",
        });

        // Adoption selects the newest *paused* row, not the newest row overall.
        // Matching on generation alone would pick the sibling, decline adoption,
        // and leave the original requester parked behind a row that can never
        // announce. The sibling's own liveness is irrelevant to that choice.
        const requesterRuns = listSubagentRunsForRequester(originalRequester);
        expect(requesterRuns.map((entry) => entry.runId)).toEqual([
          "plugin-subagent-default-followup",
        ]);
        expectRecordFields(requireValue(requesterRuns[0], "expected adopted run"), {
          childSessionKey,
          task: "the remote job finished",
          pauseReason: undefined,
        });
      },
    );
  });
}
