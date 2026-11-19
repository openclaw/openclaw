import { expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { completionConfig } from "../../agents/bash-tools.lifecycle.test-support.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { WorkspaceAccessUnavailableError } from "../../agents/workspace-access.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import { configureEventState, startEmbeddedTurn } from "./session-event.test-support.js";
import * as sessionUpdates from "./session-updates.js";
// mock-isolation: Synthetic model decisions; admission, queue and recovery custody stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
// Match Gateway startup: activate the real reply runtimes before timing turn authority.
await Promise.all([
  import("../dispatch.js"),
  import("./get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

/** What remote skill discovery throws while the workspace node is absent. */
function workspaceDisconnect(nodeCommandDispatched?: boolean) {
  return new WorkspaceAccessUnavailableError("Remote workspace skill discovery failed", {
    cause: new GatewayClientRequestError({
      code: "UNAVAILABLE",
      message: "node not connected",
      details: {
        code: "NOT_CONNECTED",
        nodeError: { code: "NOT_CONNECTED", message: "node not connected" },
        ...(nodeCommandDispatched === undefined ? {} : { nodeCommandDispatched }),
      },
    }),
  });
}

/** Run one restart input; `node` decides each pre-admission skill discovery attempt. */
async function runRestartEvent(label: string, signal: AbortSignal, node: (attempt: number) => void) {
  return await withOpenClawTestState(
    { label, env: { OPENCLAW_TEST_FAST: "0" } },
    async (state) => {
      await configureEventState(state, completionConfig(state.workspaceDir));
      const target = { agentId: "main", sessionKey: `agent:main:dashboard:${label}` };
      await replaceSessionEntry(target, {
        sessionId: label,
        lifecycleRevision: "original",
        permissionMode: "full",
        updatedAt: Date.now(),
      });
      let discoveries = 0;
      const discover = sessionUpdates.ensureSkillSnapshot;
      using _skills = vi
        .spyOn(sessionUpdates, "ensureSkillSnapshot")
        .mockImplementation(async (params) => {
          node(++discoveries);
          return await discover(params);
        });
      runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
        await startEmbeddedTurn(params, "restart turn");
        return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
      });
      try {
        const receipt = enqueueSessionEventForHost("Resume required work", {
          ...target,
          source: "restart",
          expectedTarget: await captureSessionEventTargetForHost(
            target.agentId,
            target.sessionKey,
          ),
          abortSignal: signal,
          deliver: false,
        });
        const [outcome, accepted] = await withinTest(
          Promise.all([receipt.settled, receipt.accepted]),
          signal,
        );
        return { outcome, accepted, discoveries, runs: runEmbeddedAgentMock.mock.calls.length };
      } finally {
        await drainGlobalSingletonLifecycleState("restart");
        resetSystemEventsForTest();
      }
    },
  );
}

it("retries an undispatched restart input until its workspace node reconnects", async ({
  signal,
}) => {
  const result = await runRestartEvent("workspace-reconnect", signal, (attempt) => {
    if (attempt === 1) {
      throw workspaceDisconnect(false);
    }
  });
  expect(result.outcome, result.outcome.error).toMatchObject({
    status: "completed",
    executionStarted: true,
  });
  expect(result.accepted).toEqual({ ok: true });
  expect(result).toMatchObject({ discoveries: 2, runs: 1 });
});

it.for([
  { case: "dispatched", nodeCommandDispatched: true },
  { case: "ambiguous", nodeCommandDispatched: undefined },
])(
  "keeps a $case workspace disconnect terminal",
  async ({ case: label, nodeCommandDispatched }, { signal }) => {
    const result = await runRestartEvent(`workspace-${label}`, signal, () => {
      throw workspaceDisconnect(nodeCommandDispatched);
    });
    expect(result.outcome).toMatchObject({ status: "failed", executionStarted: false });
    expect(result.accepted).toMatchObject({ ok: false });
    expect(result).toMatchObject({ discoveries: 1, runs: 0 });
  },
);

it("stops retrying an undispatched restart input after the reconnect window", async ({
  signal,
}) => {
  const now = Date.now.bind(Date);
  let skewMs = 0;
  using _clock = vi.spyOn(Date, "now").mockImplementation(() => now() + skewMs);
  const result = await runRestartEvent("workspace-deadline", signal, (attempt) => {
    // The window opens at the first attempt: one retry inside it, none after it.
    skewMs += attempt === 1 ? 30_000 : 31_000;
    throw workspaceDisconnect(false);
  });
  expect(result.outcome).toMatchObject({ status: "failed", executionStarted: false });
  expect(result.outcome.error).toContain("Remote workspace skill discovery failed");
  expect(result).toMatchObject({ discoveries: 2, runs: 0 });
});
