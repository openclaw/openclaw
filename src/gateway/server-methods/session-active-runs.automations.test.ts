import { afterEach, expect, it } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import { projectGatewaySessionActiveRun } from "../session-utils-display.js";
import {
  createVisibleActiveSessionRunProjector,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";

const storePath = "/synthetic/automation-projection/sessions";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  resetAgentRunRegistryForTest();
});
function resolveState(
  sessionKey: string,
  options: Partial<Parameters<typeof resolveVisibleActiveSessionRunState>[0]> = {},
) {
  return resolveVisibleActiveSessionRunState({
    storePath,
    requestedKey: sessionKey,
    canonicalKey: sessionKey,
    ...options,
  });
}
function makeRun(name: string) {
  const sessionKey = "agent:main:" + name;
  const sessionId = name + "-session";
  const runId = name + "-run";
  return {
    sessionKey,
    sessionId,
    runId,
    register(overrides: Parameters<typeof registerAgentRunContext>[1]) {
      registerAgentRunContext(runId, { sessionKey, sessionId, ...overrides });
      cleanups.push(() => clearAgentRunContext(runId));
    },
    wait() {
      const release = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
      cleanups.push(() => release?.());
      return release;
    },
  };
}

it.each([true, false])(
  "reconstructs automation identity independently of stream visibility (%s)",
  (visible) => {
    const run = makeRun("automation");
    const automation = {
      runId: run.runId,
      jobId: "watch",
      name: "Watch release readiness",
      startedAt: 100,
    };
    run.register({
      projectSessionActive: true,
      projectSessionLifecycle: false,
      isControlUiVisible: visible,
      automation,
    });
    const read = () =>
      createVisibleActiveSessionRunProjector()({
        storePath,
        requestedKey: run.sessionKey,
        canonicalKey: run.sessionKey,
        sessionId: run.sessionId,
      });
    expect(read()).toMatchObject({
      active: true,
      automationRuns: [{ ...automation, status: "running" }],
    });
    expect(resolveState("agent:main:origin")).toEqual({ active: false, runIds: [] });
    expect(
      resolveState(run.sessionKey, { sessionId: "replacement" }).automationRuns,
    ).toBeUndefined();
    expect(resolveState(run.sessionKey, { agentId: "other" }).automationRuns).toBeUndefined();
    const previous = {
      key: run.sessionKey,
      kind: "direct" as const,
      sessionId: run.sessionId,
      status: "failed" as const,
      updatedAt: 20,
      startedAt: 1,
      endedAt: 2,
      runtimeMs: 1,
      lastRunId: "human-turn",
      lastRunError: "Review needs attention",
    };
    expect(projectGatewaySessionActiveRun(read(), previous.status)).toEqual({
      hasActiveRun: true,
      status: "failed",
      automationRuns: [{ ...automation, status: "running" }],
    });
    expect(
      buildGatewaySessionSnapshot({ sessionRow: previous, activeRunState: read() }).session,
    ).toMatchObject({
      ...previous,
      hasActiveRun: true,
      automationRuns: [{ ...automation, status: "running" }],
    });
    // Tool and approval waits remain occupied work, not a quiet completion.
    for (const [stream, data] of [
      ["tool", { phase: "start", name: "exec", toolCallId: "tool-wait" }],
      [
        "execution",
        {
          state: "waiting",
          wait: { kind: "approval" },
          approval: { id: "approval-wait", state: "pending" },
        },
      ],
      ["tool", { phase: "end", name: "exec", toolCallId: "tool-wait" }],
    ] as const) {
      emitAgentEvent({ runId: run.runId, stream, data });
      expect(read()).toMatchObject({ active: true, automationRuns: [{ status: "running" }] });
    }
    const releaseWait = run.wait();
    expect(read()).toMatchObject({
      active: true,
      status: "queued",
      automationRuns: [{ status: "queued" }],
    });
    releaseWait?.();
    registerAgentRunContext("other-automation", {
      sessionKey: run.sessionKey,
      sessionId: run.sessionId,
      projectSessionActive: true,
      projectSessionLifecycle: false,
      automation: { ...automation, runId: "other-automation", jobId: "other", startedAt: 200 },
    });
    cleanups.push(() => clearAgentRunContext("other-automation"));
    expect(read().automationRuns?.map((entry) => entry.runId)).toEqual([
      run.runId,
      "other-automation",
    ]);
    clearAgentRunContext(run.runId);
    expect(read()).toMatchObject({ active: true, automationRuns: [{ runId: "other-automation" }] });
    clearAgentRunContext("other-automation");
    expect(read()).toEqual({ active: false, runIds: [] });
  },
);
