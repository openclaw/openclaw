/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { disposeSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { currentChatSharingNotices, projectChatSharingNotice } from "./chat-sharing-notice.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import { createSessionEventState } from "./chat-state.test-support.ts";

function sharingEvent(payload: Record<string, unknown> = {}, evidence = false): GatewayEventFrame {
  return {
    type: "event",
    event: evidence ? "session.sharing.evidence" : "session.sharing",
    payload: {
      action: "member-added",
      sessionKey: "agent:main:main",
      agentId: "main",
      identityId: "member-alice",
      identityLabel: "Alice Collaborator",
      access: "send",
      ts: 1_000,
      ...(evidence
        ? { actorState: "unknown" }
        : { actor: { type: "human", id: "owner", label: "Taylor" } }),
      ...payload,
    },
  };
}

describe("live sharing transcript notices", () => {
  it("presents both event variants without writing history or requesting it", () => {
    const messages = [{ id: "previous", role: "user", content: "Earlier turn" }];
    const { state, request } = createSessionEventState({ chatMessages: messages });
    const publish = vi.fn();
    const stop = chatRunPresentation(state).subscribeNonText(publish);
    const added = sharingEvent();
    handlePageGatewayEvent(state, added);
    handlePageGatewayEvent(state, added);
    handlePageGatewayEvent(
      state,
      sharingEvent({ action: "member-access-changed", access: "read", ts: 2_000 }, true),
    );
    const notices = currentChatSharingNotices(state);
    expect(notices.map(projectChatSharingNotice)).toMatchObject([
      {
        kind: "notice",
        label: "Taylor invited Alice Collaborator with Send access",
        timestamp: 1_000,
      },
      { kind: "notice", label: "Alice Collaborator’s access changed to Read", timestamp: 2_000 },
    ]);
    expect(notices.map((notice) => notice.afterMessageId)).toEqual(["previous", "previous"]);
    handlePageGatewayEvent(state, sharingEvent({ access: undefined }));
    expect(currentChatSharingNotices(state)).toBe(notices);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(state.chatMessages).toBe(messages);
    expect(request).not.toHaveBeenCalled();
    stop();
  });

  it("uses an unknown-person label instead of an opaque identity or actor id", () => {
    const { state } = createSessionEventState();
    handlePageGatewayEvent(
      state,
      sharingEvent({
        action: "member-access-changed",
        identityLabel: "  ",
        actor: { type: "human", id: "opaque-actor-id" },
      }),
    );
    expect(currentChatSharingNotices(state).map(projectChatSharingNotice)).toMatchObject([
      { label: "Unknown person’s access changed to Send" },
    ]);
  });

  it("leaves old/non-ceiling, unrelated and malformed sharing events unchanged", () => {
    const { state, request } = createSessionEventState();
    const publish = vi.fn();
    const stop = chatRunPresentation(state).subscribeNonText(publish);
    for (const payload of [
      { access: undefined },
      { access: "admin" },
      { action: "visibility", visibility: "shared" },
      { action: "member-removed" },
      { sessionKey: "agent:main:other" },
      { agentId: "other" },
      { agentId: undefined },
      { identityId: "" },
      { ts: -1 },
      { ts: 1.5 },
      { ts: undefined },
    ]) {
      handlePageGatewayEvent(state, sharingEvent(payload));
    }
    handlePageGatewayEvent(state, { ...sharingEvent(), event: "session.suggestion" });
    expect(currentChatSharingNotices(state)).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    stop();
  });

  it.each(["client", "epoch", "session", "instance", "subscription", "disconnect"])(
    "retires notices when the %s owner changes",
    (change) => {
      const { state } = createSessionEventState();
      handlePageGatewayEvent(state, sharingEvent());
      expect(currentChatSharingNotices(state)).toHaveLength(1);
      if (change === "client") {
        state.client = createTestGatewayClient(vi.fn());
      }
      if (change === "epoch") {
        state.connectionEpoch += 1;
      }
      if (change === "session") {
        state.sessionKey = "agent:main:other";
      }
      if (change === "instance") {
        state.currentSessionId = "replacement";
      }
      if (change === "subscription") {
        disposeSelectedSessionMessageSubscription(state);
      }
      if (change === "disconnect") {
        state.connected = false;
      }
      expect(currentChatSharingNotices(state)).toEqual([]);
      state.connected = true;
      state.sessionKey = "agent:main:main";
      expect(currentChatSharingNotices(state)).toEqual([]);
    },
  );

  it("matches only the selected global agent and retires on an agent switch", () => {
    const { state } = createSessionEventState({ sessionKey: "global", assistantAgentId: "main" });
    handlePageGatewayEvent(state, sharingEvent({ sessionKey: "global", agentId: "other" }));
    expect(currentChatSharingNotices(state)).toEqual([]);
    handlePageGatewayEvent(state, sharingEvent({ sessionKey: "global" }));
    expect(currentChatSharingNotices(state)).toHaveLength(1);
    state.assistantAgentId = "other";
    expect(currentChatSharingNotices(state)).toEqual([]);
  });

  it.each(["reset", "new"])("clears notices on the selected session's %s event", (reason) => {
    const { state } = createSessionEventState();
    handlePageGatewayEvent(state, sharingEvent());
    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: { key: state.sessionKey, agentId: "main", reason },
    });
    expect(currentChatSharingNotices(state)).toEqual([]);
  });
});
