import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { maybeRepairGroupAllowFromFallback } from "./allowfrom-fallback-migration.js";

vi.mock("../channel-capabilities.js", () => ({
  getDoctorChannelCapabilities: (channelName?: string) => ({
    dmAllowFromMode: channelName === "matrix" ? "nestedOnly" : "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: channelName !== "discord",
    warnOnEmptyGroupSenderAllowlist: true,
  }),
}));

function config(channels: OpenClawConfig["channels"]): OpenClawConfig {
  return { channels };
}

function expectUnchanged(channels: OpenClawConfig["channels"]) {
  const cfg = config(channels);
  const expected = { config: structuredClone(cfg), changes: [] };
  expect(maybeRepairGroupAllowFromFallback(cfg)).toEqual(expected);
}

describe("doctor group allowFrom fallback migration", () => {
  it.each(["disabled", "allowlist", "open"] as const)(
    "preserves authored empty lists under %s group policy",
    (groupPolicy) => {
      expectUnchanged({
        imessage: { groupPolicy, groupAllowFrom: [], allowFrom: ["dm@example.invalid"] },
        telegram: {
          groupPolicy,
          groupAllowFrom: [],
          allowFrom: ["123"],
          accounts: {
            inherited: { allowFrom: ["456"] },
            explicit: { groupAllowFrom: [], allowFrom: ["789"] },
          },
        },
      });
    },
  );

  it.each(["account", "channel", "defaults"] as const)(
    "preserves absent lists when the %s group policy is disabled",
    (scope) => {
      expectUnchanged({
        ...(scope === "defaults" ? { defaults: { groupPolicy: "disabled" } } : {}),
        signal: {
          ...(scope === "channel" ? { groupPolicy: "disabled" } : {}),
          accounts: {
            work: {
              ...(scope === "account" ? { groupPolicy: "disabled" } : {}),
              allowFrom: ["work-user"],
            },
          },
        },
      });
    },
  );

  it("migrates absent lists with explicit policy overrides", () => {
    const cfg = config({
      defaults: { groupPolicy: "disabled" },
      telegram: { groupPolicy: "allowlist", allowFrom: ["123"] },
      signal: {
        groupPolicy: "disabled",
        allowFrom: ["parent-user"],
        accounts: { work: { groupPolicy: "allowlist", allowFrom: ["work-user"] } },
      },
    });
    const result = maybeRepairGroupAllowFromFallback(cfg);

    expect(result.config.channels?.telegram?.groupAllowFrom).toEqual(["123"]);
    expect(result.config.channels?.signal?.groupAllowFrom).toBeUndefined();
    expect(result.config.channels?.signal?.accounts?.work?.groupAllowFrom).toEqual(["work-user"]);
    expect(maybeRepairGroupAllowFromFallback(result.config).changes).toEqual([]);
    expect(cfg.channels?.telegram?.groupAllowFrom).toBeUndefined();
  });

  it("copies fallback allowFrom into explicit groupAllowFrom", () => {
    const result = maybeRepairGroupAllowFromFallback(
      config({
        telegram: { allowFrom: [123, "accessGroup:ops", "123"], groupPolicy: "allowlist" },
      }),
    );

    expect(result.changes).toEqual([
      "channels.telegram.groupAllowFrom: copied 2 sender entries from allowFrom for explicit group allowlist.",
    ]);
    expect(result.config.channels?.telegram?.groupAllowFrom).toEqual(["123", "accessGroup:ops"]);
  });

  it("preserves account-scoped fallback without broadening to the channel", () => {
    const result = maybeRepairGroupAllowFromFallback(
      config({
        signal: {
          allowFrom: ["parent"],
          accounts: {
            work: { allowFrom: ["work-user"] },
            personal: { groupAllowFrom: ["personal-user"], allowFrom: ["ignored"] },
          },
        },
      }),
    );

    expect(result.changes).toEqual([
      "channels.signal.groupAllowFrom: copied 1 sender entry from allowFrom for explicit group allowlist.",
      "channels.signal.accounts.work.groupAllowFrom: copied 1 sender entry from allowFrom for explicit group allowlist.",
    ]);
    expect(result.config.channels?.signal?.groupAllowFrom).toEqual(["parent"]);
    expect(result.config.channels?.signal?.accounts?.work?.groupAllowFrom).toEqual(["work-user"]);
    expect(result.config.channels?.signal?.accounts?.personal?.groupAllowFrom).toEqual([
      "personal-user",
    ]);
  });

  it("does not shadow an inherited channel group allowlist for accounts", () => {
    expectUnchanged({
      telegram: {
        allowFrom: ["dm-user"],
        groupAllowFrom: ["group-user"],
        accounts: { work: { allowFrom: ["work-dm-user"] } },
      },
    });
  });

  it("skips disabled channels, disabled accounts, and channels without fallback", () => {
    expectUnchanged({
      disabled: { enabled: false, allowFrom: ["user"] },
      telegram: { accounts: { disabled: { enabled: false, allowFrom: ["user"] } } },
      discord: { allowFrom: ["user"] },
      tools: { allowFrom: ["user"] },
    });
  });

  it("skips generated channel schemas that reject groupAllowFrom", () => {
    expectUnchanged({
      slack: { allowFrom: ["U123"], accounts: { workspace: { allowFrom: ["U456"] } } },
    });
  });

  it("skips bundled-extension channels absent from generated metadata", () => {
    // Missing metadata must not authorize writes that the extension's schema rejects.
    expectUnchanged({ agentmail: { allowFrom: ["someone@example.com"] } });
  });
});
