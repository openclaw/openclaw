import { describe, expect, it } from "vitest";
import { isBootSessionKey } from "../infra/outbound/message-class.js";

// Phase 4 Discord Surface Overhaul: Boot Path A.
//
// When the agent's `message` tool fires from a boot-session key, the
// message-action-runner auto-tags the outbound send with
// `messageClass: "boot"`. This test locks in the classifier primitive used
// there (`isBootSessionKey`) and documents the tagging contract for the
// runner.
//
// Keeping this test at the gateway layer (rather than next to the runner)
// keeps the assertion close to the live boot surface that callers actually
// care about, and avoids pulling in the runner's heavy fixture dependencies.

describe("Phase 4 boot-session messageClass tagging", () => {
  it("recognizes boot-hyphen session keys as boot-class", () => {
    expect(isBootSessionKey("boot-main")).toBe(true);
    expect(isBootSessionKey("boot-main-20260416-1200")).toBe(true);
  });

  it("recognizes boot-colon session keys as boot-class", () => {
    expect(isBootSessionKey("boot:main")).toBe(true);
    expect(isBootSessionKey("boot:reboot-session")).toBe(true);
  });

  it("rejects ordinary user session keys", () => {
    expect(isBootSessionKey("agent:main:main")).toBe(false);
    expect(isBootSessionKey("agent:main:discord:thread:abc")).toBe(false);
    expect(isBootSessionKey("")).toBe(false);
    expect(isBootSessionKey("reboot")).toBe(false);
  });

  it("matches only on prefix, not substring", () => {
    // Must NOT match — "xboot-" is not a boot session.
    expect(isBootSessionKey("xboot-main")).toBe(false);
    expect(isBootSessionKey("  boot-main")).toBe(false);
    expect(isBootSessionKey("session-boot-main")).toBe(false);
  });

  it("documents the runner's auto-tagging invariant", () => {
    // This is the single-source-of-truth predicate used inside
    // `src/infra/outbound/message-action-runner.ts` to decide whether an
    // outgoing send should be tagged `messageClass: "boot"`. Changing the
    // prefix set without updating callers would silently change Discord
    // surface behavior — keep this guard asserting the actual runtime check.
    const classify = (sessionKey: string | undefined): "boot" | undefined =>
      sessionKey && isBootSessionKey(sessionKey) ? "boot" : undefined;
    expect(classify("boot-main")).toBe("boot");
    expect(classify("agent:main:main")).toBeUndefined();
    expect(classify(undefined)).toBeUndefined();
  });
});
