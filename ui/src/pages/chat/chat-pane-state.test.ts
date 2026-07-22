import { describe, expect, it } from "vitest";
import {
  applySelectedSessionProjection,
  resolveSessionParticipationBlocked,
} from "./chat-pane-state.ts";

function projectionState(): Parameters<typeof applySelectedSessionProjection>[0] {
  return {
    chatEffectiveQueueMode: "interrupt",
    chatQueueModeOverride: "interrupt",
    selectedChatSessionArchived: true,
  };
}

describe("applySelectedSessionProjection", () => {
  it("retains pane-owned metadata when a scoped list omits the selected session", () => {
    const state = projectionState();

    expect(applySelectedSessionProjection(state, undefined)).toBe(false);
    expect(state).toEqual({
      chatEffectiveQueueMode: "interrupt",
      chatQueueModeOverride: "interrupt",
      selectedChatSessionArchived: true,
    });
  });

  it("adopts metadata from a matching session row", () => {
    const state = projectionState();

    expect(
      applySelectedSessionProjection(state, {
        archived: false,
        effectiveQueueMode: "followup",
        key: "agent:main:main",
        kind: "direct",
        queueMode: "followup",
        updatedAt: 1,
      }),
    ).toBe(true);
    expect(state).toEqual({
      chatEffectiveQueueMode: "followup",
      chatQueueModeOverride: "followup",
      selectedChatSessionArchived: false,
    });
  });
});

describe("resolveSessionParticipationBlocked", () => {
  it("blocks when a selected row disappears, then reopens once it returns shared", () => {
    expect(
      resolveSessionParticipationBlocked({
        catalog: false,
        session: { visibility: "draft", sharingRole: "member" },
      }),
    ).toBe(true);
    expect(
      resolveSessionParticipationBlocked({
        catalog: false,
        session: undefined,
      }),
    ).toBe(true);
    expect(
      resolveSessionParticipationBlocked({
        catalog: false,
        session: { visibility: "shared", sharingRole: "member" },
      }),
    ).toBe(false);
  });

  it("keeps catalog sessions on their separate capability path", () => {
    expect(resolveSessionParticipationBlocked({ catalog: true, session: undefined })).toBe(false);
  });
});
