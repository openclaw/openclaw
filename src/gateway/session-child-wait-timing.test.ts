import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { projectSubagentStatus } from "../../ui/src/pages/chat/chat-subagent-wait.ts";
import * as subagents from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { createResidentSessionRowReader } from "./session-row-projection.test-support.js";

it("recovers the current child-wait clock from persisted lifecycle without transcript discovery", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env, root }) => {
    const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    await subagents.resetSubagentRegistryForTests({ persist: false });
    const reader = createResidentSessionRowReader();
    const parentKey = "agent:main:dashboard:wait-parent";
    const childKey = "agent:main:dashboard:wait-child";
    const parentSessionId = "wait-parent-session";
    const childRunId = "wait-child-run";
    const childTarget = { sessionKey: childKey, sessionId: "wait-child-session", agentId: "main" };
    const startedAt = Date.now();
    const at = (seconds: number) => startedAt + seconds * 1_000;
    const initialRun = "initial-parent-run",
      nextRun = "announcement-parent-run";
    let childClaim: string | undefined;
    const lifecycle = (runId: string, phase: "start" | "end", timestamp: number, yielded = false) =>
      persistGatewaySessionLifecycleEvent({
        sessionKey: parentKey,
        agentId: "main",
        event: {
          sessionId: parentSessionId,
          runId,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          ts: timestamp,
          data: {
            phase,
            ...(phase === "start" ? { startedAt: timestamp } : { endedAt: timestamp }),
            ...(yielded ? { yielded: true, livenessState: "paused", stopReason: "end_turn" } : {}),
          },
        },
      });
    const readWait = async () => {
      const parent = expectDefined(await reader.row(parentKey), "persisted parent row");
      const child = expectDefined(await reader.row(childKey), "persisted child row");
      expect(parent).toMatchObject({ hasActiveSubagentRun: true });
      expect(child).toMatchObject({ startedAt });
      const roster = {
        selectedSession: parent,
        subagentSessions: [child],
        subagentSessionsHydrated: true,
        messages: [],
      };
      return { parent, ...projectSubagentStatus(roster, false) };
    };
    try {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: parentKey, env },
        { sessionId: parentSessionId, updatedAt: startedAt },
      );
      await replaceSessionEntry(
        { agentId: "main", sessionKey: childKey, env },
        { sessionId: "wait-child-session", updatedAt: startedAt, spawnedBy: parentKey },
      );
      await subagents.addSubagentRunForTests({
        runId: childRunId,
        childSessionKey: childKey,
        requesterSessionKey: parentKey,
        createdAt: startedAt,
        startedAt,
        cleanup: "keep",
      });
      childClaim = claimAgentRunContext(childRunId, childTarget, {
        trackOwner: true,
        ownsContext: true,
      });
      expect((await readWait()).wait).toBeNull();
      await lifecycle(initialRun, "start", startedAt);
      await lifecycle(initialRun, "end", at(2), true);
      expect(await readWait()).toMatchObject({
        parent: { endedAt: at(2) },
        wait: { startedAt: at(2) },
      });

      await lifecycle(nextRun, "start", at(3));
      expect((await reader.row(parentKey))?.endedAt).toBeUndefined();
      await lifecycle(nextRun, "end", at(4));
      await reader.dispose();
      await closeOpenClawAgentDatabasesAsync(root);
      const resumed = await readWait();
      expect(resumed.parent).toMatchObject({
        lastRunId: nextRun,
        startedAt: at(3),
        endedAt: at(4),
      });
      expect(resumed.wait).toEqual({ startedAt: at(4), runningCount: 0, sessionCount: 1 });
      expect(resumed.placedWait).toBeUndefined();
    } finally {
      releaseAgentRunContext(childRunId, childClaim);
      await reader.dispose();
      await subagents.resetSubagentRegistryForTests({ persist: false });
    }
  });
});
