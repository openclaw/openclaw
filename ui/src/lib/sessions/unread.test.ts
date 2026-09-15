// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SessionUnreadPatchGuard } from "./unread.ts";

describe("SessionUnreadPatchGuard", () => {
  it("admits one acknowledgement until its request settles", () => {
    const guard = new SessionUnreadPatchGuard();
    const settle = guard.beginPatch("agent:main:a", true);
    expect(settle).toBeTypeOf("function");
    expect(guard.beginPatch("agent:main:a", true)).toBeNull();
    settle?.();
    expect(guard.beginPatch("agent:main:a", false)).toBeNull();
  });

  it.each([
    { name: "activity", marker: undefined },
    { name: "null-marker activity", marker: null },
    { name: "manual", marker: 100 },
  ])("keeps a $name acknowledgement pending through optimistic read and rollback", ({ marker }) => {
    const guard = new SessionUnreadPatchGuard();
    const settle = guard.beginPatch("agent:main:a", true, marker);
    expect(settle).toBeTypeOf("function");
    expect(guard.beginPatch("agent:main:a", false, marker)).toBeNull();
    expect(guard.beginPatch("agent:main:a", true, marker)).toBeNull();
    expect(guard.beginPatch("agent:main:a", true, marker)).toBeNull();

    settle?.();
    expect(guard.beginPatch("agent:main:a", true, marker)).toBeTypeOf("function");
  });

  it("re-arms after success when newer snapshots remain unread without a false confirmation", () => {
    const guard = new SessionUnreadPatchGuard();
    const settle = guard.beginPatch("agent:main:a", true);
    expect(settle).toBeTypeOf("function");
    // A newer activity snapshot can supersede the successful request's read state.
    expect(guard.beginPatch("agent:main:a", true)).toBeNull();
    settle?.();
    expect(guard.beginPatch("agent:main:a", true)).toBeTypeOf("function");
    expect(guard.beginPatch("agent:main:a", true)).toBeNull();
  });

  it("does not let a repeated old settlement release its successor", () => {
    const guard = new SessionUnreadPatchGuard();
    const settleFirst = guard.beginPatch("agent:main:a", true);
    expect(settleFirst).toBeTypeOf("function");
    settleFirst?.();
    const settleSecond = guard.beginPatch("agent:main:a", true);
    expect(settleSecond).toBeTypeOf("function");
    settleFirst?.();
    expect(guard.beginPatch("agent:main:a", true)).toBeNull();
    settleSecond?.();
    expect(guard.beginPatch("agent:main:a", true)).toBeTypeOf("function");
  });

  it("does not let an old A activation release a new A acknowledgement after visiting B", () => {
    const guard = new SessionUnreadPatchGuard();
    const settleOld = guard.beginPatch("agent:main:a", true);
    expect(settleOld).toBeTypeOf("function");
    expect(guard.beginPatch("agent:main:b", false)).toBeNull();
    const settleCurrent = guard.beginPatch("agent:main:a", true);
    expect(settleCurrent).toBeTypeOf("function");
    settleOld?.();
    expect(guard.beginPatch("agent:main:a", false)).toBeNull();
    expect(guard.beginPatch("agent:main:a", true)).toBeNull();
    settleCurrent?.();
    expect(guard.beginPatch("agent:main:a", true)).toBeTypeOf("function");
  });

  it.each([undefined, 50])(
    "preserves a newer manual marker through settlement of marker %s",
    (marker) => {
      const guard = new SessionUnreadPatchGuard();
      const settle = guard.beginPatch("agent:main:a", true, marker);
      expect(settle).toBeTypeOf("function");
      expect(guard.beginPatch("agent:main:a", true, 100)).toBeNull();
      expect(guard.beginPatch("agent:main:a", false, 100)).toBeNull();
      settle?.();
      expect(guard.beginPatch("agent:main:a", true, 100)).toBeNull();

      guard.beginActivation("agent:main:a");
      expect(guard.beginPatch("agent:main:a", true, 100)).toBeTypeOf("function");
    },
  );

  it("does not acknowledge read or unknown state and treats a null marker as absent", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.beginPatch("agent:main:a", false)).toBeNull();
    expect(guard.beginPatch("agent:main:a", undefined)).toBeNull();
    expect(guard.beginPatch("agent:main:a", true, null)).toBeTypeOf("function");
  });

  it("preserves a manual unread marker created after the active session was observed", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.beginPatch("agent:main:a", false)).toBeNull();
    expect(guard.beginPatch("agent:main:a", true, 100)).toBeNull();
    expect(guard.beginPatch("agent:main:a", true, 100)).toBeNull();
  });

  it("acknowledges a manual unread marker on a later activation", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.beginPatch("agent:main:a", false)).toBeNull();
    expect(guard.beginPatch("agent:main:a", true, 100)).toBeNull();
    expect(guard.beginPatch("agent:main:b", false)).toBeNull();
    expect(guard.beginPatch("agent:main:a", true, 100)).toBeTypeOf("function");
  });

  it("restarts the unread episode when a retained pane is presented again", () => {
    const guard = new SessionUnreadPatchGuard();
    const settleOld = guard.beginPatch("agent:main:a", true, 100);
    expect(settleOld).toBeTypeOf("function");
    guard.beginActivation("agent:main:a");
    expect(guard.beginPatch("agent:main:a", true, 100)).toBeTypeOf("function");
    settleOld?.();
    expect(guard.beginPatch("agent:main:a", true, 100)).toBeNull();
  });
});
