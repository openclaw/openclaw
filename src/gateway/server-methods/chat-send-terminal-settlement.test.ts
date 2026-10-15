import { AsyncResource } from "node:async_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { emitAgentEvent, onAgentRuntimeEvent } from "../../infra/agent-events.js";
import * as sessionAdmission from "../../sessions/session-lifecycle-admission.js";
import { startGatewayEventSubscriptions } from "../server-runtime-subscriptions.js";
import {
  createSubscriptionTestFixture,
  registerSubscriptionChatRun,
} from "../server-runtime-subscriptions.test-support.js";
import {
  dispatchInboundMessageMock,
  gatewayReplyMock,
  installGatewayTestHooks,
} from "../test-helpers.js";
import { broadcastChatFinal } from "./chat-broadcast.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import * as workAdmission from "./chat-send-work-admission.js";
import * as settlementOwner from "./session-run-settlement.js";
import { sessionCompactHandlers } from "./sessions-compact.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();

it.for(
  (["compact", "fork", "rewind"] as const).flatMap((action) =>
    (["native", "dispatched"] as const).map((publication) => ({ action, publication })),
  ),
)(
  "accepts $action from a synchronous $publication final listener but refuses the live turn",
  async ({ action, publication }, { signal }) => {
    const fixture = await createFixture({ active: false });
    const runId = `terminal-${publication}-${action}`;
    fixture.params.idempotencyKey = runId;
    const subscriptionParams = createSubscriptionTestFixture().createParams();
    const subscriptions =
      publication === "native"
        ? startGatewayEventSubscriptions({
            ...subscriptionParams,
            broadcast: fixture.context.broadcast,
            broadcastToConnIds: fixture.context.broadcastToConnIds,
            nodeSendToSession: fixture.context.nodeSendToSession,
            chatRunState: fixture.context.chatRunState,
            chatAbortControllers: fixture.context.chatAbortControllers,
            agentRunSeq: fixture.context.agentRunSeq,
            toolEventRecipients: fixture.context.chatRunState.toolEventRecipients,
          })
        : undefined;
    vi.mocked(fixture.context.addChatRun).mockImplementation((id, entry) => {
      fixture.context.chatRunState.registry.add(id, entry);
    });
    const clientRequest = new AsyncResource("terminal-client-request");
    const modelEntered = createDeferred();
    const modelRelease = createDeferred();
    const settlementEntered = createDeferred();
    const finalObserved = createDeferred();
    let releaseRetainedWork = () => {};
    const createAdmission = workAdmission.createChatSendWorkAdmission;
    vi.spyOn(workAdmission, "createChatSendWorkAdmission").mockImplementation((params) => {
      const work = createAdmission(params);
      // Retain real source custody, as pending input cleanup does after delivery.
      releaseRetainedWork = work.retain();
      return work;
    });
    dispatchInboundMessageMock.mockReset();
    gatewayReplyMock.mockImplementation(async (_ctx, options) => {
      const operation = replyRunRegistry.get(fixture.scope.sessionKey);
      modelEntered.resolve();
      if (publication === "native" && !operation) {
        throw new Error("Missing admitted reply operation");
      }
      if (publication === "native") {
        options?.onAgentRunStart?.(runId);
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start" } });
      }
      await modelRelease.promise;
      if (publication === "dispatched") {
        return { text: "Final answer" };
      }
      operation!.freezeAbort();
      emitAgentEvent({ runId, stream: "assistant", data: { text: "Final answer" } });
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
      return undefined;
    });
    const entryId = loadTranscriptEventsSync(fixture.scope)
      .map(asOptionalRecord)
      .find((event) => event?.type === "message")?.id;
    expect(entryId).toBeTruthy();
    const method = `sessions.${action}`;
    const invoke = (respond: RespondFn) =>
      clientRequest.runInAsyncScope(() =>
        Promise.resolve(
          (action === "compact" ? sessionCompactHandlers : sessionRewindHandlers)[method]!({
            req: { type: "req", id: action, method },
            params:
              action === "compact"
                ? { key: fixture.scope.sessionKey, maxLines: 1 }
                : { sessionKey: fixture.scope.sessionKey, entryId },
            client: null,
            isWebchatConnect: () => false,
            respond,
            context: fixture.context,
          }),
        ),
      );
    const finalResponse = vi.fn<RespondFn>();
    let mutation: Promise<void> | undefined;
    vi.mocked(fixture.context.broadcast).mockImplementation((event, payload) => {
      if (event !== "chat" || (payload as { state?: string }).state !== "final") {
        return;
      }
      const settle = settlementOwner.waitForTerminalSessionRunSettlement;
      vi.spyOn(settlementOwner, "waitForTerminalSessionRunSettlement").mockImplementation(
        (params) => {
          const result = settle(params);
          settlementEntered.resolve();
          return result;
        },
      );
      mutation = invoke(finalResponse);
      finalObserved.resolve();
    });
    try {
      await fixture.send();
      await withinTest(modelEntered.promise, signal);
      const liveResponse = vi.fn<RespondFn>();
      await invoke(liveResponse);
      expect(liveResponse).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining(
            action === "compact" ? "has an active run" : "while the agent is working",
          ),
        }),
      );
      modelRelease.resolve();
      await withinTest(finalObserved.promise, signal);
      await withinTest(settlementEntered.promise, signal);
      releaseRetainedWork();
      await withinTest(mutation!, signal);
      expect(finalResponse).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    } finally {
      modelRelease.resolve();
      releaseRetainedWork();
      await fixture.cleanup();
      await mutation;
      if (subscriptions) {
        subscriptions.heartbeatUnsub();
        subscriptions.transcriptUnsub();
        subscriptions.lifecycleUnsub();
        await subscriptions.agentUnsub();
      }
      await subscriptionParams.scheduler.stop();
      clientRequest.emitDestroy();
      vi.restoreAllMocks();
    }
  },
);

it.for(
  (["compact", "fork", "rewind"] as const).flatMap((action) =>
    (["lifecycle", "chat-final"] as const).map((publication) => ({ action, publication })),
  ),
)(
  "refuses $action immediately when a replaced run publishes $publication",
  async ({ action, publication }, { signal }) => {
    const fixture = await createFixture({ active: false });
    await appendTranscriptMessage(fixture.scope, {
      message: { role: "user", content: "A second completed turn.", timestamp: 2 },
    });
    const params = {
      ...createSubscriptionTestFixture().createParams(),
      chatAbortControllers: fixture.context.chatAbortControllers,
      chatRunState: fixture.context.chatRunState,
    };
    const runId = `replacement-${action}`;
    let registration = registerSubscriptionChatRun(params, { runId, ...fixture.scope });
    const originalEntry = registration.entry;
    const admission = await sessionAdmission.beginSessionWorkAdmission({
      scope: fixture.scope.storePath,
      identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
      assertAllowed: () => {},
      isSettling: () => registration.entry.terminalOutcomeObserved === true,
    });
    const removeListener = onAgentRuntimeEvent((event) => {
      if (event.runId === runId) {
        registration.cleanup();
        registration = registerSubscriptionChatRun(params, { runId, ...fixture.scope });
      }
    });
    const subscriptions = startGatewayEventSubscriptions(params);
    const admissionChecked = createDeferred();
    const getRelease = sessionAdmission.getTerminalSessionWorkAdmissionRelease;
    const releaseCheck = vi
      .spyOn(sessionAdmission, "getTerminalSessionWorkAdmissionRelease")
      .mockImplementation((target) => {
        const result = getRelease(target);
        admissionChecked.resolve();
        return result;
      });
    let mutation: Promise<void> | undefined;
    try {
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
      expect(registration.entry).not.toBe(originalEntry);
      if (publication === "chat-final") {
        broadcastChatFinal({
          context: fixture.context,
          runId,
          sessionKey: fixture.scope.sessionKey,
          terminalEntry: originalEntry,
        });
      }
      expect(registration.entry.terminalOutcomeObserved).toBeUndefined();
      const entryId = loadTranscriptEventsSync(fixture.scope)
        .map(asOptionalRecord)
        .find((event) => event?.type === "message")?.id;
      expect(entryId).toBeTruthy();
      const method = `sessions.${action}`;
      const respond = vi.fn<RespondFn>();
      mutation = Promise.resolve(
        (action === "compact" ? sessionCompactHandlers : sessionRewindHandlers)[method]!({
          req: { type: "req", id: action, method },
          params:
            action === "compact"
              ? { key: fixture.scope.sessionKey, maxLines: 1 }
              : { sessionKey: fixture.scope.sessionKey, entryId },
          client: null,
          isWebchatConnect: () => false,
          respond,
          context: fixture.context,
        }),
      );
      await withinTest(admissionChecked.promise, signal);
      // A live acquired lease must refuse synchronously, never await its release.
      expect(releaseCheck.mock.results[0]?.value).toBe(false);
      await withinTest(mutation, signal);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining(
            action === "compact" ? "has an active run" : "while the agent is working",
          ),
        }),
      );
    } finally {
      removeListener();
      admission.release();
      registration.cleanup();
      await mutation;
      subscriptions.heartbeatUnsub();
      subscriptions.transcriptUnsub();
      subscriptions.lifecycleUnsub();
      await subscriptions.agentUnsub();
      await params.scheduler.stop();
      await fixture.cleanup();
      vi.restoreAllMocks();
    }
  },
);
