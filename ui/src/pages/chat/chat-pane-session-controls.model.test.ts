/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  captureChatOutboxAdmission,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import { createInitializationContext, createRenderTestChatPane } from "./chat-pane.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-queue.ts";
import { steerQueuedChatMessage } from "./chat-send-actions.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import {
  getChatModelObservedRunId,
  getChatSessionProjection,
  setChatRunOwner,
} from "./history-merge.ts";
import { adoptStartedChatRun, reconcileChatRunLifecycle } from "./run-lifecycle.ts";

describe("chat pane model controls", () => {
  it("binds model events to the admitted run when session rows omit exact run IDs", async () => {
    const pane = createRenderTestChatPane();
    const state = pane.initialize(createInitializationContext());
    state.sessionKey = "agent:main:current";
    state.connected = true;
    state.chatModelCatalog = [
      { id: "primary", name: "Primary", provider: "example" },
      { id: "fallback", name: "Fallback", provider: "example" },
    ];
    const row: GatewaySessionRow = {
      key: state.sessionKey,
      kind: "direct",
      sessionId: "current-session",
      updatedAt: 1,
      model: "primary",
      modelProvider: "example",
      hasActiveRun: true,
      activeModel: "fallback",
      activeModelProvider: "example",
    };
    state.sessions.reconcile(row, createSessionsListResult().defaults);
    state.sessionsResult = state.sessions.state.result;
    const container = document.createElement("div");
    const draw = () => {
      const controls = renderChatPaneComposerControls({
        state,
        selectedSession: state.sessionsResult?.sessions[0],
        agentDefaultModel: "example/primary",
        modelAccess: { allowed: true, requiredScope: "operator.write" },
        effortAccess: { allowed: true, requiredScope: "operator.write" },
        contextWindowAccess: { allowed: true, requiredScope: "operator.write" },
        permissionAccess: { allowed: true, requiredScope: "operator.write" },
        canSelectFull: true,
        onModelSetup: vi.fn(),
      });
      render(controls.composerControls, container);
      const trigger = container.querySelector<HTMLElement>("[data-chat-model-select]");
      expect(trigger?.dataset.chatSelectValue).toBe("example/primary");
      return trigger?.textContent;
    };
    state.chatSending = true;
    state.chatSendingScopeKey = storedChatOutboxScopeKey({
      sessionKey: state.sessionKey,
      agentId: "main",
    });
    expect(draw()).toContain("Model pending");
    adoptStartedChatRun(state, "current-run", 2);
    state.chatSending = false;
    expect(draw()).toContain("Model pending");
    const observe = (
      runId: string,
      model: string | null,
      updatedAt: number,
      sessionKey = row.key,
    ) =>
      handlePageGatewayEvent(state, {
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey,
          agentId: "main",
          runId,
          phase: "model",
          session: { ...row, key: sessionKey, updatedAt, activeModel: model },
        },
      });
    observe("current-run", "primary", 3);
    expect(draw()).toContain("Primary");
    observe("current-run", "fallback", 4);
    expect(draw()).toContain("Fallback");
    observe("previous-run", "primary", 1);
    expect(draw()).toContain("Fallback");
    observe("elsewhere-run", "primary", 5, "agent:main:elsewhere");
    expect(draw()).toContain("Fallback");
    observe("current-run", null, 6);
    expect(draw()).toContain("Model pending");
    observe("current-run", "fallback", 7);
    expect(draw()).toContain("Fallback");
    adoptStartedChatRun(state, "replacement-run", 8);
    expect(draw()).toContain("Model pending");
    observe("replacement-run", "primary", 9);
    expect(draw()).toContain("Primary");
    state.chatSending = true;
    state.chatQueue = [
      {
        id: "next-send",
        text: "Continue",
        createdAt: 10,
        sendState: "sending",
        sendRunId: "next-run",
      },
    ];
    observe("next-run", "fallback", 10);
    // A delayed event can carry the latest session projection but an older emitter ID.
    observe("replacement-run", "fallback", 10);
    expect(draw()).toContain("Model pending");
    adoptStartedChatRun(state, "next-run", 11);
    state.chatSending = false;
    expect(draw()).toContain("Fallback");
    observe("next-run", "primary", 12);
    expect(draw()).toContain("Primary");
    const steerAck = createDeferred<unknown>();
    vi.stubGlobal("sessionStorage", window.sessionStorage);
    onTestFinished(() => {
      sessionStorage.clear();
      vi.unstubAllGlobals();
    });
    const request = createGatewayRequestMock((method) =>
      method === "chat.send" ? steerAck.promise : Promise.resolve({}),
    );
    state.client = createTestGatewayClient(request);
    state.hello = sessionMutationGatewayHello();
    state.chatQueue = [];
    const steer = {
      id: "held-steer",
      text: "Keep going",
      createdAt: 13,
      sendRunId: "steer-operation",
      sessionKey: state.sessionKey,
      agentId: "main",
    };
    expect(
      admitQueuedMessageForSession(
        state,
        captureChatOutboxAdmission(state, state.sessionKey, "main"),
        steer,
      ),
    ).toBe(true);
    const steering = steerQueuedChatMessage(state, steer.id);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({
          queueMode: "steer",
          idempotencyKey: steer.sendRunId,
        }),
      ),
    );
    expect(state.chatSending).toBe(true);
    observe("next-run", "fallback", 13);
    steerAck.resolve({ runId: steer.sendRunId, status: "started", messageSeq: 1 });
    await steering;
    await vi.waitFor(() => expect(state.chatSending).toBe(false));
    expect(state.chatRunId).toBe("next-run");
    expect(draw()).toContain("Fallback");
    reconcileChatRunLifecycle(state, { clearLocalRun: true, clearChatStream: true });
    expect(getChatModelObservedRunId(state, state.sessionsResult?.sessions[0])).toBeUndefined();
    state.sessions.dispose();
  });

  it("does not show another session's pending model after switching sessions", () => {
    const previousSessionKey = "agent:main:previous";
    const selectedSession: GatewaySessionRow = {
      key: "agent:main:selected",
      kind: "direct",
      model: "primary",
      modelProvider: "example",
    };
    const pane = createRenderTestChatPane();
    const state = pane.initialize(createInitializationContext());
    Object.assign(state, {
      sessionKey: previousSessionKey,
      sessionsResult: { ...createSessionsListResult(), sessions: [selectedSession] },
      chatModelCatalog: [{ id: "primary", name: "Primary", provider: "example" }],
      chatModelSwitchPromises: {},
      connected: true,
      client: createTestGatewayClient(async () => ({})),
    });
    getChatSessionProjection(state, { sessionKey: previousSessionKey });
    state.chatRunId = "previous-session-run";
    state.chatStream = "Working";
    state.chatSending = true;
    state.chatSendingScopeKey = storedChatOutboxScopeKey({ sessionKey: previousSessionKey });
    setChatRunOwner(state, state.chatRunId);
    state.sessionKey = selectedSession.key;

    const controls = renderChatPaneComposerControls({
      state,
      selectedSession,
      agentDefaultModel: "example/primary",
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      contextWindowAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      onModelSetup: vi.fn(),
    });
    const container = document.createElement("div");
    render(controls.composerControls, container);

    const trigger = container.querySelector<HTMLElement>("[data-chat-model-select]");
    expect(trigger?.textContent).toContain("Primary");
    expect(trigger?.textContent).not.toContain("Model pending");
    expect(trigger?.dataset.chatSelectValue).toBe("example/primary");
  });
});
