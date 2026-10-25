import { expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.test-support.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createReplyOperation } from "../../../sessions/session-controller.js";
import {
  getCurrentSessionControllerOwner,
  captureSessionTarget,
} from "../../../sessions/session-controller.lifecycle.js";
import { getRpcSourceIdentity } from "../../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceGatewayControl,
} from "../../../talk/provider-types.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { prepareTalkSessionTarget } from "../session-target.js";

type NativeControlHarness = {
  getConfig: () => OpenClawConfig;
  getCallback: () => RealtimeVoiceAgentConsultRunner;
  getBrowserControl: () => RealtimeVoiceGatewayControl;
  runEmbeddedAgent: Mock<
    (
      params: RunEmbeddedAgentParams,
    ) => Promise<{ payloads: { text: string }[]; meta: { durationMs: number } }>
  >;
  context: GatewayRequestContext;
  dispatch: (
    method: string,
    params: Record<string, unknown>,
    handlers?: GatewayRequestHandlers,
  ) => Promise<ReturnType<typeof vi.fn>>;
  submitProviderResult: ReturnType<typeof vi.fn>;
};

export async function createNativeTalkCall(
  dispatch: NativeControlHarness["dispatch"],
  browser: boolean,
  params: Record<string, unknown> = {},
) {
  const respond = await dispatch(browser ? "talk.client.create" : "talk.session.create", {
    sessionKey: "main",
    mode: "realtime",
    brain: "agent-consult",
    transport: browser ? "webrtc" : "gateway-relay",
    ...(browser ? { capabilities: ["gateway-control-v1"] } : {}),
    ...params,
  });
  expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
  return respond.mock.calls[0]![1] as { voiceSessionId?: string; sessionId?: string };
}

export function registerNativeConsultExactControlTests(harness: NativeControlHarness) {
  const cancel = { text: "cancel", mode: "cancel" };
  it.each([
    ["browser-rpc", "other call", true],
    ["browser-provider", "other call", false],
    ["browser-provider", "same call", true],
    ["relay", "other call", false],
    ["relay", "foreign global", true],
  ] as const)(
    "native %s keeps %s control within its declared scope",
    async (surface, replacement, cancelsOriginal) => {
      const answer = "Synthetic consult answer";
      harness.getConfig().session = { scope: "global" };
      const started = createDeferredCore<RunEmbeddedAgentParams>();
      const finish = createDeferredCore();
      let aborted = false;
      const abortOwned = vi.fn(() => {
        aborted = true;
        finish.resolve();
      });
      const abortOther = vi.fn();
      harness.runEmbeddedAgent.mockImplementationOnce(async (params) => {
        const { runId, sessionId, sessionKey, agentId } = params;
        const handle = createEmbeddedRunHandle({ runId, abort: abortOwned });
        const operation = getCurrentSessionControllerOwner();
        if (!operation) {
          throw new Error("Talk consult has no controller-owned turn");
        }
        setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, agentId, operation);
        started.resolve(params);
        try {
          await finish.promise;
          return { payloads: [{ text: answer }], meta: { durationMs: 0, aborted } };
        } finally {
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        }
      });
      const browser = surface !== "relay";
      const result = await createNativeTalkCall(harness.dispatch, browser);
      const voiceId = result.voiceSessionId ?? result.sessionId!;
      let controlSessionId = result.sessionId;
      const consult = harness.getCallback()({ prompt: "Keep working" });
      let foreignOperation: ReturnType<typeof createReplyOperation> | undefined;
      try {
        const active = await awaitGateBeforeSettlement(
          started.promise,
          consult,
          "consult ended before model dispatch",
        );
        expect(getRpcSourceIdentity(rpcSourceTesting.get(active.runId)!)).toMatchObject({
          agentId: "voice",
          sessionKey: "global",
          sessionId: active.sessionId,
        });
        if (replacement === "other call" || replacement === "same call") {
          const call = await createNativeTalkCall(
            harness.dispatch,
            browser,
            replacement === "same call" ? { voiceSessionId: result.voiceSessionId } : {},
          );
          expect((call.voiceSessionId ?? call.sessionId) === voiceId).toBe(
            replacement === "same call",
          );
          controlSessionId = call.sessionId;
        } else {
          foreignOperation = createReplyOperation({
            sessionKey: "global",
            sessionId: "other-agent-session",
            agentId: "primary",
            resetTriggered: false,
            target: captureSessionTarget({
              storeScope: (
                await prepareTalkSessionTarget(harness.getConfig(), "agent:primary:main")
              ).storePath,
              sessionKey: "global",
              incarnation: "other-agent-session",
              agentId: "primary",
            }),
          });
          setActiveEmbeddedRun(
            "other-agent-session",
            createEmbeddedRunHandle({ runId: "other-run", abort: abortOther }),
            "global",
            undefined,
            "primary",
            foreignOperation,
          );
        }
        expect(
          await harness.dispatch("talk.client.steer", {
            sessionKey: "agent:primary:main",
            ...cancel,
          }),
        ).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        const controlResult = expect.objectContaining({ ok: cancelsOriginal, mode: "cancel" });
        if (surface === "browser-provider") {
          harness.getBrowserControl().onToolCall?.({
            callId: "control",
            itemId: "control",
            name: "openclaw_agent_control",
            args: { ...cancel },
          });
          await vi.waitFor(() =>
            expect(harness.submitProviderResult).toHaveBeenCalledWith("control", controlResult),
          );
        } else {
          const respond = await harness.dispatch(
            browser ? "talk.client.steer" : "talk.session.steer",
            {
              ...(browser ? {} : { sessionId: controlSessionId }),
              sessionKey: "main",
              ...cancel,
            },
          );
          expect(respond).toHaveBeenCalledWith(true, controlResult, undefined);
        }
        expect(abortOwned).toHaveBeenCalledTimes(cancelsOriginal ? 1 : 0);
        expect(abortOther).not.toHaveBeenCalled();
        expect(clientVoiceSessionTesting.readRecord("voice", voiceId)?.sessionKey).toBe("main");
        finish.resolve();
        if (cancelsOriginal) {
          await expect(consult).rejects.toMatchObject({ name: "AbortError" });
        } else {
          await expect(consult).resolves.toEqual({ text: answer });
        }
      } finally {
        finish.resolve();
        await Promise.allSettled([consult]);
        foreignOperation?.complete();
      }
    },
  );
}
