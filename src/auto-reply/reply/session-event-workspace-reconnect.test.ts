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

/** The shape a workspace read gets when its node is absent; dispatch provenance varies. */
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

async function runRestartEvent(
  label: string,
  signal: AbortSignal,
  model: (attempt: number, params: Parameters<typeof runEmbeddedAgent>[0]) => Promise<void>,
) {
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
      let attempts = 0;
      runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
        await model(++attempts, params);
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
        return { outcome, accepted, attempts };
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
  const { outcome, accepted, attempts } = await runRestartEvent(
    "workspace-reconnect",
    signal,
    async (attempt, params) => {
      if (attempt === 1) {
        throw workspaceDisconnect(false);
      }
      await startEmbeddedTurn(params, "reconnected turn");
    },
  );
  expect(outcome, outcome.error).toMatchObject({ status: "completed", executionStarted: true });
  expect(accepted).toEqual({ ok: true });
  expect(attempts).toBe(2);
});

it.each([
  { case: "dispatched", nodeCommandDispatched: true },
  { case: "ambiguous", nodeCommandDispatched: undefined },
])(
  "keeps a $case workspace disconnect terminal",
  async ({ case: label, nodeCommandDispatched }, { signal }) => {
    const { outcome, accepted, attempts } = await runRestartEvent(
      `workspace-${label}`,
      signal,
      async () => {
        throw workspaceDisconnect(nodeCommandDispatched);
      },
    );
    expect(outcome).toMatchObject({ status: "failed", executionStarted: false });
    expect(accepted).toMatchObject({ ok: false });
    expect(attempts).toBe(1);
  },
);

it("stops retrying an undispatched restart input after the reconnect window", async ({
  signal,
}) => {
  const now = Date.now.bind(Date);
  let skewMs = 0;
  using _clock = vi.spyOn(Date, "now").mockImplementation(() => now() + skewMs);
  const { outcome, attempts } = await runRestartEvent(
    "workspace-deadline",
    signal,
    async (attempt) => {
      // The window opens at the first attempt: one retry inside it, none after it.
      skewMs += attempt === 1 ? 30_000 : 31_000;
      throw workspaceDisconnect(false);
    },
  );
  expect(outcome).toMatchObject({ status: "failed", executionStarted: false });
  expect(outcome.error).toContain("Remote workspace skill discovery failed");
  expect(attempts).toBe(2);
});
