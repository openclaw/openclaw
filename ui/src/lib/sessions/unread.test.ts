// @vitest-environment node
import { ErrorCodes, GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionUnreadPatchGuard } from "./unread.ts";

afterEach(() => vi.restoreAllMocks());

describe("SessionUnreadPatchGuard", () => {
  it.each([undefined, new GatewayProtocolRequestError({ code: ErrorCodes.UNAVAILABLE })])(
    "unlatches after a transient or unsent patch so later snapshots retry (%s)",
    (error) => {
      const guard = new SessionUnreadPatchGuard();
      expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
      const clock = vi.spyOn(Date, "now").mockReturnValue(0);
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      guard.settlePatch()(false, error);
      clock.mockReturnValue(550);
      expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
      // A successful request remains latched until a confirmed read.
      guard.settlePatch()(true);
      expect(guard.shouldPatch("agent:main:a", true)).toBe(false);
    },
  );

  it.each([ErrorCodes.INVALID_REQUEST, ErrorCodes.FORBIDDEN, ErrorCodes.APPROVAL_NOT_FOUND])(
    "latches a %s rejection until a new unread episode or activation",
    (code) => {
      const guard = new SessionUnreadPatchGuard();
      expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(true);
      guard.settlePatch()(false, new GatewayProtocolRequestError({ code }));
      expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(false);
      expect(guard.shouldPatch("agent:main:a", false, 100)).toBe(false);
      expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(false);

      // A confirmed read ends this episode; new activity can be acknowledged.
      expect(guard.shouldPatch("agent:main:a", false)).toBe(false);
      expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
      guard.settlePatch()(false, new GatewayProtocolRequestError({ code }));
      guard.beginActivation("agent:main:a");
      expect(guard.shouldPatch("agent:main:a", true, 200)).toBe(true);
    },
  );

  it("re-acknowledges when new activity flags the open session unread again", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
    guard.settlePatch()(true);
    // Server confirms the read, then a background run completes.
    expect(guard.shouldPatch("agent:main:a", false)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
    expect(guard.shouldPatch("agent:main:a", true)).toBe(false);
  });

  it("keeps an acknowledgement latched across an optimistic local read", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(true);
    expect(guard.shouldPatch("agent:main:a", false, 100)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(false);
    guard.settlePatch()(false);
    expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(true);
  });

  it("treats a null marker as no manual marker", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.shouldPatch("agent:main:a", false)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", true, null)).toBe(true);
  });

  it("does not patch read sessions and resets after changing sessions", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.shouldPatch("agent:main:a", false)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
    expect(guard.shouldPatch("agent:main:b", true)).toBe(true);
    expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
  });

  it("preserves a manual unread marker created after the active session was observed", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.shouldPatch("agent:main:a", false)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(false);
  });

  it("acknowledges a manual unread marker on a later activation", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.shouldPatch("agent:main:a", false)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(false);
    expect(guard.shouldPatch("agent:main:b", false)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(true);
  });

  it("restarts the unread episode when a retained pane is presented again", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.shouldPatch("agent:main:a", false)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(false);
    guard.beginActivation("agent:main:a");
    expect(guard.shouldPatch("agent:main:a", true, 100)).toBe(true);
  });
});
