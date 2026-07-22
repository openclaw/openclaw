import { describe, expect, it } from "vitest";
import { applySelectedSessionProjection, SessionParticipationTracker } from "./chat-pane-state.ts";

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

describe("SessionParticipationTracker", () => {
  const resolve = (
    tracker: SessionParticipationTracker,
    patch: Partial<Parameters<SessionParticipationTracker["resolve"]>[0]> = {},
  ) =>
    tracker.resolve({
      catalog: false,
      listLoaded: true,
      listLoading: false,
      sessionKey: "agent:main:tracked",
      session: undefined,
      ...patch,
    });

  it("does not block before the list loads or while it is loading", () => {
    const tracker = new SessionParticipationTracker();
    expect(resolve(tracker, { listLoaded: false })).toBe(false);
    expect(resolve(tracker, { listLoading: true })).toBe(false);
  });

  it("does not block a brand-new key that never had a row", () => {
    expect(resolve(new SessionParticipationTracker())).toBe(false);
  });

  it("blocks after a previously visible row disappears and reopens when shared", () => {
    const tracker = new SessionParticipationTracker();
    expect(resolve(tracker, { session: { visibility: "shared", sharingRole: "member" } })).toBe(
      false,
    );
    expect(resolve(tracker)).toBe(true);
    expect(resolve(tracker, { listLoading: true })).toBe(true);
    expect(resolve(tracker, { session: { visibility: "shared", sharingRole: "member" } })).toBe(
      false,
    );
  });

  it("blocks a member while a draft row is still cached", () => {
    expect(
      resolve(new SessionParticipationTracker(), {
        session: { visibility: "draft", sharingRole: "member" },
      }),
    ).toBe(true);
  });

  it("forgets disappeared rows when the gateway connection changes", () => {
    const tracker = new SessionParticipationTracker();
    expect(resolve(tracker, { session: { visibility: "shared", sharingRole: "member" } })).toBe(
      false,
    );
    expect(resolve(tracker)).toBe(true);
    tracker.reset();
    expect(resolve(tracker)).toBe(false);
  });

  it("keeps agent-relative global session history separate", () => {
    const tracker = new SessionParticipationTracker();
    expect(
      resolve(tracker, {
        sessionKey: "main\0global",
        session: { visibility: "shared", sharingRole: "member" },
      }),
    ).toBe(false);
    expect(resolve(tracker, { sessionKey: "work\0global" })).toBe(false);
    expect(resolve(tracker, { sessionKey: "main\0global" })).toBe(true);
  });
});
