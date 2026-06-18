import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isEchoTargetAdmissible,
  registerChannelEchoAdmission,
  resetChannelEchoAdmissionForTest,
  unregisterChannelEchoAdmission,
} from "./channel-admission.js";
import {
  markChannelMirrorCapable,
  resetChannelMirrorCapabilityForTest,
} from "./channel-mirror-capability.js";

const cfg = {} as OpenClawConfig;

describe("channel-admission", () => {
  beforeEach(() => {
    resetChannelEchoAdmissionForTest();
    resetChannelMirrorCapabilityForTest();
  });

  it("admits a target when no channel predicate is registered (unchanged behavior)", async () => {
    expect(await isEchoTargetAdmissible(cfg, "discord", { to: "123" })).toBe(true);
  });

  it("fails closed for a mirror-capable channel with no predicate (stop/reload window)", async () => {
    // The channel has been mirror-capable (registered a dispatcher) but its
    // admission predicate is currently absent (account stopped/reloading). Deny
    // the echo rather than fall back to a raw send to a possibly-revoked target.
    markChannelMirrorCapable("telegram");
    expect(
      await isEchoTargetAdmissible(cfg, "telegram", { to: "telegram:-100", accountId: "default" }),
    ).toBe(false);
    // A channel that never mirrors still admits when no predicate is registered.
    expect(await isEchoTargetAdmissible(cfg, "discord", { to: "123" })).toBe(true);
  });

  it("delegates to the registered predicate (enabled -> admit, disabled -> deny)", async () => {
    const enabled = vi.fn(() => true);
    registerChannelEchoAdmission("test-owner", "telegram", "default", enabled);
    expect(
      await isEchoTargetAdmissible(cfg, "telegram", { to: "telegram:-100", accountId: "default" }),
    ).toBe(true);
    expect(enabled).toHaveBeenCalledTimes(1);

    const disabled = vi.fn(() => false);
    registerChannelEchoAdmission("test-owner", "telegram", "default", disabled); // last-wins replace
    expect(
      await isEchoTargetAdmissible(cfg, "telegram", { to: "telegram:-100", accountId: "default" }),
    ).toBe(false);
  });

  it("awaits an async predicate (telegram DM access is resolved asynchronously)", async () => {
    registerChannelEchoAdmission("test-owner", "telegram", "default", async () => false);
    expect(
      await isEchoTargetAdmissible(cfg, "telegram", { to: "telegram:123", accountId: "default" }),
    ).toBe(false);
  });

  it("uses the sole predicate for a wildcard target but fails closed on an explicit account mismatch", async () => {
    const a = vi.fn(() => true);
    registerChannelEchoAdmission("test-owner", "telegram", "default", a);
    // Wildcard (no pinned account) may use the only registered predicate.
    expect(await isEchoTargetAdmissible(cfg, "telegram", { to: "telegram:-100" })).toBe(true);
    // An explicit, different account fails closed even though only one is registered.
    expect(
      await isEchoTargetAdmissible(cfg, "telegram", { to: "telegram:-100", accountId: "acct2" }),
    ).toBe(false);
  });

  it("keys predicates by account and fails closed on an unknown account when >1 registered", async () => {
    registerChannelEchoAdmission("test-owner", "telegram", "acc-a", () => true);
    registerChannelEchoAdmission("test-owner", "telegram", "acc-b", () => false);
    expect(await isEchoTargetAdmissible(cfg, "telegram", { to: "x", accountId: "acc-a" })).toBe(
      true,
    );
    expect(await isEchoTargetAdmissible(cfg, "telegram", { to: "x", accountId: "acc-b" })).toBe(
      false,
    );
    // Unknown account with >1 registered → fail closed.
    expect(await isEchoTargetAdmissible(cfg, "telegram", { to: "x", accountId: "acc-c" })).toBe(
      false,
    );
  });

  it("unregister removes a stopped account's predicate (channel reverts to admit-all)", async () => {
    registerChannelEchoAdmission("test-owner", "telegram", "default", () => false);
    expect(await isEchoTargetAdmissible(cfg, "telegram", { to: "x", accountId: "default" })).toBe(
      false,
    );
    unregisterChannelEchoAdmission("test-owner", "telegram", "default");
    // No predicates left for the channel → unchanged admit-all behavior.
    expect(await isEchoTargetAdmissible(cfg, "telegram", { to: "x", accountId: "default" })).toBe(
      true,
    );
  });
});
