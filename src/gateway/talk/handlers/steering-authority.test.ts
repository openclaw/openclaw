import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../../agents/admitted-run-context.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import type { captureOperatorToolGatewayContinuationContext } from "../../server-plugin-in-process-dispatch.js";
import { createContext } from "../../server-plugin-in-process-dispatch.test-support.js";
import { sharingPolicyClient } from "../../session-sharing.test-utils.js";
import { forgetUnifiedTalkSession, rememberUnifiedTalkSession } from "../session-registry.js";
import { talkClientHandlers } from "./client.js";
import { talkSessionHandlers } from "./session.js";

type Continuation = NonNullable<
  Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>
>;

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  control: vi.fn(),
  relayControl: vi.fn(),
}));

vi.mock("../../server-plugin-in-process-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server-plugin-in-process-dispatch.js")>()),
  captureOperatorToolGatewayContinuationContext: mocks.capture,
}));
vi.mock("../../../talk/agent-run-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/agent-run-control.js")>()),
  controlRealtimeVoiceAgentRun: mocks.control,
}));
vi.mock("../relay/operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relay/operations.js")>()),
  steerTalkRealtimeRelayAgentRun: mocks.relayControl,
}));
// mock-isolation: Exercise request custody without initializing the plugin runtime.
vi.mock("../../../plugins/runtime/index.js", () => ({
  createPluginRuntime: () => ({
    agent: {
      session: { getSessionEntry: () => undefined },
      resolveAgentDir: () => "/test/agent",
      resolveAgentWorkspaceDir: () => "/test/workspace",
    },
  }),
}));

const target = {
  agentId: "main",
  sessionKey: "agent:main:main",
  canonicalKey: "agent:main:main",
  storePath: "/test/sessions",
};
const relayId = "request-authority-relay";

afterEach(() => {
  forgetUnifiedTalkSession(relayId);
  vi.resetAllMocks();
});

function continuation(): Continuation {
  const lifetime = new AbortController();
  const assertCurrent = () => lifetime.signal.throwIfAborted();
  return {
    operatorAuthority: createAdmittedRunOperatorAuthority({
      profileId: "current-steering-caller",
      scopes: ["operator.admin"],
      signal: lifetime.signal,
      assertCurrent,
    }),
    signal: lifetime.signal,
    assertCurrent,
    release: vi.fn(() => lifetime.abort()),
    run<T>(run: () => T): T {
      assertCurrent();
      return run();
    },
  };
}

describe.each(["talk.client.steer", "talk.session.steer"] as const)(
  "%s request authority",
  (method) => {
    function request(assertCurrent = () => {}) {
      const client = sharingPolicyClient({
        deviceId: "steering-device",
        scopes: ["operator.admin"],
      });
      client.connId = "steering-connection";
      rememberUnifiedTalkSession(relayId, {
        kind: "realtime-relay",
        connId: client.connId,
        relaySessionId: relayId,
        sessionTarget: target,
      });
      const respond = vi.fn();
      const handler =
        method === "talk.client.steer" ? talkClientHandlers[method] : talkSessionHandlers[method];
      if (!handler) {
        throw new Error("Missing Talk steering handler");
      }
      const control = method === "talk.client.steer" ? mocks.control : mocks.relayControl;
      const context = createContext();
      context.chatAbortControllers = new Map([
        [
          "owned-run",
          {
            controller: new AbortController(),
            sessionId: "owned-session",
            sessionKey: target.canonicalKey,
            agentId: "main",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            ownerConnId: client.connId,
            kind: "chat-send",
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]);
      const invoke = () =>
        handler({
          req: { type: "req", id: "steering-request", method },
          params: {
            sessionKey: target.canonicalKey,
            ...(method === "talk.session.steer" ? { sessionId: relayId } : {}),
            text: "Use the release branch",
          },
          client,
          respond,
          isWebchatConnect: () => false,
          sessionMutationAuthorization: {
            talkSessionTarget: target,
            assertCurrent,
            assertTargetCurrent: assertCurrent,
          },
          context,
        });
      return { invoke, respond, control };
    }

    it.each(["accepted", "rejected"] as const)(
      "retains the caller until steering is %s, then releases",
      async (outcome) => {
        const current = continuation();
        mocks.capture.mockResolvedValueOnce(current);
        const { invoke, respond, control } = request();
        const pending = createDeferred<{ ok: true }>();
        const entered = createDeferred();
        control.mockImplementationOnce(() => {
          entered.resolve();
          return pending.promise;
        });
        const handling = Promise.resolve(invoke());
        await awaitGateBeforeSettlement(
          entered.promise,
          handling,
          "Steering handler settled before entering control",
        );
        expect(control).toHaveBeenCalledOnce();
        const input = control.mock.calls[0]?.[0];
        const caller =
          method === "talk.client.steer"
            ? input.getToolAuthorityOverlay().operatorAuthority
            : input.authority.executionContext.operatorAuthority;
        expect(caller).toBe(current.operatorAuthority);
        expect(current.release).not.toHaveBeenCalled();
        expect(respond).not.toHaveBeenCalled();
        if (outcome === "accepted") {
          pending.resolve({ ok: true });
        } else {
          pending.reject(new Error("Steering refused"));
        }
        await handling;
        expect(current.release).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(outcome === "accepted");
      },
    );

    it("revalidates session authority after asynchronous caller capture", async () => {
      const current = continuation();
      const capture = createDeferred<Continuation>();
      const entered = createDeferred();
      mocks.capture.mockImplementationOnce(() => {
        entered.resolve();
        return capture.promise;
      });
      let authorized = true;
      const { invoke, respond, control } = request(() => {
        if (!authorized) {
          throw new Error("Session authority revoked");
        }
      });
      const handling = Promise.resolve(invoke());
      await awaitGateBeforeSettlement(
        entered.promise,
        handling,
        "Steering handler settled before capturing caller authority",
      );
      expect(mocks.capture).toHaveBeenCalledOnce();
      authorized = false;
      capture.resolve(current);
      await handling;
      expect(control).not.toHaveBeenCalled();
      expect(current.release).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(false);
    });
  },
);
