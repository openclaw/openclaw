import { expect, it } from "vitest";
import { projectSubagentStatus } from "../../ui/src/pages/chat/chat-subagent-wait.ts";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
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
    await resetSubagentRegistryForTests({ persist: false });
    const reader = createResidentSessionRowReader();
    const parentKey = "agent:main:dashboard:wait-parent";
    const childKey = "agent:main:dashboard:wait-child";
    const parentSessionId = "wait-parent-session";
    const childRunId = "wait-child-run";
    const startedAt = Date.now();
    let childClaim: string | undefined;
    const lifecycle = (runId: string, phase: "start" | "end", at: number, yielded = false) =>
      persistGatewaySessionLifecycleEvent({
        sessionKey: parentKey,
        agentId: "main",
        event: {
          sessionId: parentSessionId,
          runId,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          ts: at,
          data: {
            phase,
            ...(phase === "start" ? { startedAt: at } : { endedAt: at }),
            ...(yielded ? { yielded: true, livenessState: "paused", stopReason: "end_turn" } : {}),
          },
        },
      });
    const readWait = async () => {
      const parent = await reader.row(parentKey);
      const child = await reader.row(childKey);
      expect(parent?.hasActiveSubagentRun).toBe(true);
      expect(child?.startedAt).toBe(startedAt);
      if (!parent || !child) {
        throw new Error("Expected persisted parent and child rows");
      }
      return {
        parent,
        projection: projectSubagentStatus(
          {
            selectedSession: parent,
            subagentSessions: [child],
            subagentSessionsHydrated: true,
            messages: [],
          },
          false,
        ),
      };
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
      await addSubagentRunForTests({
        runId: childRunId,
        childSessionKey: childKey,
        requesterSessionKey: parentKey,
        createdAt: startedAt,
        startedAt,
        cleanup: "keep",
      });
      childClaim = claimAgentRunContext(
        childRunId,
        { sessionKey: childKey, sessionId: "wait-child-session", agentId: "main" },
        { trackOwner: true, ownsContext: true },
      );
      // Merely owning an active child does not fabricate an unclocked parent wait.
      expect((await readWait()).projection.wait).toBeNull();
      await lifecycle("initial-parent-run", "start", startedAt);
      await lifecycle("initial-parent-run", "end", startedAt + 2_000, true);
      const yielded = await readWait();
      expect(yielded.parent.endedAt).toBe(startedAt + 2_000);
      expect(yielded.projection.wait?.startedAt).toBe(startedAt + 2_000);

      await lifecycle("announcement-parent-run", "start", startedAt + 3_000);
      expect((await reader.row(parentKey))?.endedAt).toBeUndefined();
      // The runtime explicitly permits a normal final when earlier children remain pending.
      await lifecycle("announcement-parent-run", "end", startedAt + 4_000);
      await reader.dispose();
      await closeOpenClawAgentDatabasesAsync(root);
      const resumed = await readWait();
      expect(resumed.parent).toMatchObject({
        lastRunId: "announcement-parent-run",
        startedAt: startedAt + 3_000,
        endedAt: startedAt + 4_000,
      });
      expect(resumed.projection.wait).toEqual({
        startedAt: startedAt + 4_000,
        runningCount: 0,
        sessionCount: 1,
      });
      expect(resumed.projection.placedWait).toBeUndefined();
    } finally {
      releaseAgentRunContext(childRunId, childClaim);
      await reader.dispose();
      await resetSubagentRegistryForTests({ persist: false });
    }
  });
});
