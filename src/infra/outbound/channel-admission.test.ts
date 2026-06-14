import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isEchoTargetAdmissible,
  registerChannelEchoAdmission,
  resetChannelEchoAdmissionForTest,
  unregisterChannelEchoAdmission,
} from "./channel-admission.js";

const cfg = {} as OpenClawConfig;

describe("channel-admission", () => {
  it("admits a target when no channel predicate is registered (unchanged behavior)", () => {
    resetChannelEchoAdmissionForTest();
    expect(isEchoTargetAdmissible(cfg, "discord", { to: "123" })).toBe(true);
  });

  it("delegates to the registered predicate (enabled -> admit, disabled -> deny)", () => {
    resetChannelEchoAdmissionForTest();
    const enabled = vi.fn(() => true);
    registerChannelEchoAdmission("telegram", "default", enabled);
    expect(
      isEchoTargetAdmissible(cfg, "telegram", { to: "telegram:-100", accountId: "default" }),
    ).toBe(true);
    expect(enabled).toHaveBeenCalledTimes(1);

    const disabled = vi.fn(() => false);
    registerChannelEchoAdmission("telegram", "default", disabled); // last-wins replace
    expect(
      isEchoTargetAdmissible(cfg, "telegram", { to: "telegram:-100", accountId: "default" }),
    ).toBe(false);
  });

  it("uses the sole predicate for a wildcard target but fails closed on an explicit account mismatch", () => {
    resetChannelEchoAdmissionForTest();
    const a = vi.fn(() => true);
    registerChannelEchoAdmission("telegram", "default", a);
    // Wildcard (no pinned account) may use the only registered predicate.
    expect(isEchoTargetAdmissible(cfg, "telegram", { to: "telegram:-100" })).toBe(true);
    // An explicit, different account fails closed even though only one is registered.
    expect(
      isEchoTargetAdmissible(cfg, "telegram", { to: "telegram:-100", accountId: "acct2" }),
    ).toBe(false);
  });

  it("keys predicates by account and fails closed on an unknown account when >1 registered", () => {
    resetChannelEchoAdmissionForTest();
    registerChannelEchoAdmission("telegram", "acc-a", () => true);
    registerChannelEchoAdmission("telegram", "acc-b", () => false);
    expect(isEchoTargetAdmissible(cfg, "telegram", { to: "x", accountId: "acc-a" })).toBe(true);
    expect(isEchoTargetAdmissible(cfg, "telegram", { to: "x", accountId: "acc-b" })).toBe(false);
    // Unknown account with >1 registered → fail closed.
    expect(isEchoTargetAdmissible(cfg, "telegram", { to: "x", accountId: "acc-c" })).toBe(false);
  });

  it("unregister removes a stopped account's predicate (channel reverts to admit-all)", () => {
    resetChannelEchoAdmissionForTest();
    registerChannelEchoAdmission("telegram", "default", () => false);
    expect(isEchoTargetAdmissible(cfg, "telegram", { to: "x", accountId: "default" })).toBe(false);
    unregisterChannelEchoAdmission("telegram", "default");
    // No predicates left for the channel → unchanged admit-all behavior.
    expect(isEchoTargetAdmissible(cfg, "telegram", { to: "x", accountId: "default" })).toBe(true);
  });
});
