import { describe, expect, it, vi, type Mock } from "vitest";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceGatewayControl,
} from "../../../talk/provider-types.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";

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

export function registerNativeConsultExactControlTests(harness: NativeControlHarness) {
  describe.each(["browser-rpc", "browser-provider", "relay"] as const)(
    "native %s exact control",
    (surface) => {
      it.each([
        "foreign global",
        "replaced run",
        "reused run ID",
        "other call",
        ...(surface === "relay" ? [] : ["same call"]),
      ])("keeps %s control within its declared scope", async (replacement) => {
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
          const handle = {
            runId: params.runId,
            queueMessage: async () => undefined,
            isStreaming: () => true,
            isCompacting: () => false,
            abort: abortOwned,
          };
          setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
          started.resolve(params);
          try {
            await finish.promise;
            return {
              payloads: [{ text: "Synthetic consult answer" }],
              meta: { durationMs: 0, aborted },
            };
          } finally {
            clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
          }
        });
        const browser = surface !== "relay";
        const createMethod = browser ? "talk.client.create" : "talk.session.create";
        const createParams = {
          sessionKey: "main",
          mode: "realtime",
          brain: "agent-consult",
          transport: browser ? "webrtc" : "gateway-relay",
          ...(browser ? { capabilities: ["gateway-control-v1"] } : {}),
        };
        const respond = await harness.dispatch(createMethod, createParams);
        expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
        const result = respond.mock.calls[0]![1] as { voiceSessionId?: string; sessionId?: string };
        let controlSessionId = result.sessionId;
        const cancelsOriginal =
          replacement === "foreign global" ||
          replacement === "same call" ||
          (replacement === "other call" && surface === "browser-rpc");
        const consult = harness.getCallback()({ prompt: "Keep working" });
        try {
          const active = await Promise.race([
            started.promise,
            consult.then(() => {
              throw new Error("consult ended before model dispatch");
            }),
          ]);
          expect(harness.context.chatAbortControllers.get(active.runId)).toMatchObject({
            agentId: "voice",
            sessionKey: "global",
            sessionId: active.sessionId,
          });
          if (replacement === "other call" || replacement === "same call") {
            const next = await harness.dispatch(createMethod, {
              ...createParams,
              ...(replacement === "same call" ? { voiceSessionId: result.voiceSessionId } : {}),
            });
            expect(next).toHaveBeenCalledWith(true, expect.any(Object), undefined);
            const call = next.mock.calls[0]![1] as { voiceSessionId?: string; sessionId?: string };
            expect(
              (call.voiceSessionId ?? call.sessionId) ===
                (result.voiceSessionId ?? result.sessionId),
            ).toBe(replacement === "same call");
            controlSessionId = call.sessionId;
          } else {
            setActiveEmbeddedRun(
              replacement === "replaced run" ? active.sessionId : "other-agent-session",
              {
                runId: replacement === "reused run ID" ? active.runId : "other-run",
                queueMessage: async () => undefined,
                isStreaming: () => true,
                isCompacting: () => false,
                abort: abortOther,
              },
              "global",
            );
          }
          expect(
            await harness.dispatch("talk.client.steer", {
              sessionKey: "agent:primary:main",
              text: "cancel",
              mode: "cancel",
            }),
          ).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "INVALID_REQUEST" }),
          );
          if (surface === "browser-provider") {
            harness.getBrowserControl().onToolCall?.({
              callId: "control",
              itemId: "control",
              name: "openclaw_agent_control",
              args: { text: "cancel", mode: "cancel" },
            });
            await vi.waitFor(() =>
              expect(harness.submitProviderResult).toHaveBeenCalledWith(
                "control",
                expect.objectContaining({ ok: cancelsOriginal, mode: "cancel" }),
              ),
            );
          } else {
            const control = await harness.dispatch(
              browser ? "talk.client.steer" : "talk.session.steer",
              {
                ...(browser ? {} : { sessionId: controlSessionId }),
                sessionKey: "main",
                text: "cancel",
                mode: "cancel",
              },
            );
            expect(control).toHaveBeenCalledWith(
              true,
              expect.objectContaining({ ok: cancelsOriginal, mode: "cancel" }),
              undefined,
            );
          }
          expect(abortOwned).toHaveBeenCalledTimes(cancelsOriginal ? 1 : 0);
          expect(abortOther).not.toHaveBeenCalled();
          expect(
            clientVoiceSessionTesting.readRecord(
              "voice",
              result.voiceSessionId ?? result.sessionId!,
            )?.sessionKey,
          ).toBe("main");
          finish.resolve();
          if (cancelsOriginal) {
            await expect(consult).rejects.toMatchObject({ name: "AbortError" });
          } else {
            await expect(consult).resolves.toEqual({ text: "Synthetic consult answer" });
          }
        } finally {
          finish.resolve();
          await Promise.allSettled([consult]);
        }
      });
    },
  );
}
