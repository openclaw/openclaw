import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  capturePluginMaintenanceContinuation,
  registerPluginMaintenanceContinuation,
} from "../../agents/plugin-maintenance-continuation.js";
import {
  withSessionControllerOwner,
  withSessionControllerSource,
} from "../../sessions/session-controller.context.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { retireSessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { getRpcSourceForGateway } from "../../sessions/session-controller.rpc-sources.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

const state = vi.hoisted(() => ({
  sessionId: "original-session",
  enqueue: vi.fn(),
}));
const sessionKey = "agent:main:maintenance";
const storePath = "/synthetic/chat-abort/session-controller.sqlite";
// mock-isolation: Fixed external session storage and delivery; Stop and continuation owners are real.
vi.mock("../session-utils.js", async (original) => ({
  ...(await original<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async () => ({
    entry: { sessionId: state.sessionId },
    storePath: "/synthetic/chat-abort/session-controller.sqlite",
  }),
}));
// mock-isolation: Supply admitted synthetic requester custody; the real Stop authority check stays active.
vi.mock("../server-plugin-in-process-authority.js", () => ({
  captureOperatorToolGatewayContinuationContextInternal: () => ({
    signal: new AbortController().signal,
    assertCurrent: () => {},
    runWithRequester: <T>(run: () => T) => run(),
    release: () => {},
  }),
}));
// mock-isolation: Target the fixed synthetic incarnation without opening a second session database.
vi.mock("../../auto-reply/reply/session-event-target.js", () => ({
  captureSessionEventTargetForHost: async () => ({
    agentId: "main",
    sessionKey: "agent:main:maintenance",
    sessionId: "original-session",
    storePath: "/synthetic/chat-abort/session-controller.sqlite",
    generation: "generation",
  }),
}));
// mock-isolation: Only the admission entry is synthetic; controller effects and cancellation are real.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: async (
    _scope: unknown,
    assertCurrent: () => void,
    run: (read: unknown) => unknown,
  ) => {
    assertCurrent();
    return run({ ok: true, value: {} });
  },
}));
// mock-isolation: Observe the continuation receipt without executing another model turn.
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  enqueueSessionEventForHost: state.enqueue,
}));

it.each(["initiator", "foreign writer", "reset incarnation"])(
  "exact-run Stop selects retained maintenance only for its current %s",
  async (scenario) => {
    state.sessionId = "original-session";
    state.enqueue.mockClear().mockReturnValue({
      id: "accepted",
      accepted: Promise.resolve({ ok: true }),
      settled: Promise.resolve({ status: "completed" }),
    });
    const runId = "maintenance-run";
    const context = createChatAbortContext();
    const operation = createReplyOperation({
      sessionKey,
      sessionId: state.sessionId,
      agentId: "main",
      resetTriggered: false,
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey,
        agentId: "main",
        incarnation: state.sessionId,
      }),
    });
    const source = createActiveRun(sessionKey, {
      runId,
      sessionId: state.sessionId,
      agentId: "main",
      storeScope: storePath,
      queued: true,
      owner: { connId: "alice-original", deviceId: "alice-original-device" },
    });
    source.adapter.initiatingPersonalOperator = createAdmittedRunOperatorAuthority({
      profileId: "alice",
      scopes: ["operator.write"],
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    const unregister = withSessionControllerSource(source.input, () =>
      withSessionControllerOwner(operation, () =>
        registerPluginMaintenanceContinuation({
          agentId: "main",
          sessionKey,
          sessionId: state.sessionId,
        }),
      ),
    );
    const captured = await capturePluginMaintenanceContinuation(operation);
    expect(captured).toBeDefined();
    try {
      await captured!.interrupt(() => {});
      operation.complete();
      retireSessionControllerInput(source.input);
      await captured!.settled;
      expect(getRpcSourceForGateway(runId, undefined)).toBeUndefined();
      const sibling = createActiveRun(sessionKey, {
        runId: "sibling-run",
        sessionId: state.sessionId,
        agentId: "main",
        storeScope: storePath,
        queued: true,
      });
      if (scenario === "reset incarnation") {
        state.sessionId = "replacement-session";
      }
      const profileId = scenario === "foreign writer" ? "bob" : "alice";
      const respond = vi.fn();
      await invokeChatAbortHandler({
        handler: (options) =>
          handleChatAbortRequest({
            ...options,
            sessionMutationAuthorization: {
              admittedTarget: { agentId: "main", sessionKey, sessionId: state.sessionId },
              assertCurrent: () => {},
              assertTargetCurrent: () => {},
            },
          }),
        request: { sessionKey, runId },
        respond,
        context,
        client: {
          connId: profileId === "bob" ? "bob-device" : "alice-other-device",
          connect: { role: "operator", scopes: ["operator.write"] },
          internal: { authenticatedOperator: true },
          authenticatedUserProfile: { profileId },
        },
      });
      if (scenario === "initiator") {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ aborted: true, runIds: [runId] }),
        );
      } else if (scenario === "foreign writer") {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: "unauthorized" }),
        );
      } else {
        expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: false, runIds: [] });
      }
      expect(sibling.input.abortSignal.aborted).toBe(false);
      await captured!.finish({ ok: true, pluginIds: ["example"] }, true, async () => {});
      await vi.waitFor(() =>
        expect(state.enqueue).toHaveBeenCalledTimes(scenario === "initiator" ? 0 : 1),
      );
    } finally {
      captured?.cancel();
      unregister();
      operation.complete();
      retireSessionControllerInput(source.input);
    }
  },
);
