import { expect, it, vi } from "vitest";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy as allowlistPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy as openPolicy,
} from "./runtime-group-policy.js";

it.each([
  [
    "missing provider despite open default",
    openPolicy,
    { providerConfigPresent: false, defaultGroupPolicy: "open" },
    true,
  ],
  ["configured provider", allowlistPolicy, { providerConfigPresent: true }, false],
] as const)("uses allowlist for %s", (_name, resolve, config, providerMissingFallbackApplied) => {
  expect(resolve(config)).toEqual({
    groupPolicy: "allowlist",
    providerMissingFallbackApplied,
  });
});

it("returns channels.defaults.groupPolicy when present", () => {
  expect(resolveDefaultGroupPolicy({ channels: { defaults: { groupPolicy: "disabled" } } })).toBe(
    "disabled",
  );
});

it("refreshes recent keys and re-warns evicted keys once the cap overflows", async () => {
  vi.resetModules();
  const { warnMissingProviderGroupPolicyFallbackOnce: warnOnceFn } =
    await import("./runtime-group-policy.js");
  const lines: string[] = [];
  const warnForAccount = (accountId: string, blockedLabel?: string) =>
    warnOnceFn({
      providerMissingFallbackApplied: true,
      providerKey: "runtime-policy-evict-test",
      accountId,
      blockedLabel,
      log: (message) => lines.push(message),
    });

  for (let i = 0; i < 4096; i++) {
    warnForAccount(`account-${i}`, i === 0 ? GROUP_POLICY_BLOCKED_LABEL.room : undefined);
  }
  expect(lines).toHaveLength(4096);
  expect(lines[0]).toContain("channels.runtime-policy-evict-test is missing");
  expect(lines[0]).toContain("room messages blocked");

  expect(warnForAccount("account-0")).toBe(false);
  expect(lines).toHaveLength(4096);

  // Overflow evicts the oldest untouched key (account-1), not the refreshed one.
  expect(warnForAccount("account-overflow")).toBe(true);
  expect(warnForAccount("account-0")).toBe(false);
  expect(warnForAccount("account-1")).toBe(true);
  expect(lines).toHaveLength(4098);
});
