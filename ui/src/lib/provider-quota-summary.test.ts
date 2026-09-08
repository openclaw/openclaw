// Control UI tests cover provider quota summary behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelAuthStatusProvider } from "../api/types.ts";
import {
  collectOAuthProfileQuotaGroups,
  collectProviderQuotaGroups,
  formatQuotaReset,
} from "./provider-quota-summary.ts";

describe("formatQuotaReset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns compact relative reset windows", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00.000Z"));

    expect(formatQuotaReset(Date.now() + 30 * 60_000)).toBe("30m");
    expect(formatQuotaReset(Date.now() + 2 * 60 * 60_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("returns <1m for sub-minute reset windows instead of 0m", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00.000Z"));

    expect(formatQuotaReset(Date.now() - 1)).toBe("now");
    expect(formatQuotaReset(Date.now())).toBe("now");
    expect(formatQuotaReset(Date.now() + 1)).toBe("<1m");
    expect(formatQuotaReset(Date.now() + 59_999)).toBe("<1m");
    expect(formatQuotaReset(Date.now() + 60_000)).toBe("1m");
  });

  it("ignores Date-invalid reset timestamps", () => {
    expect(formatQuotaReset(8_640_000_000_000_001)).toBeNull();
    expect(formatQuotaReset(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("collectProviderQuotaGroups", () => {
  const acceptAll = () => true;

  function providerWithUsage(
    provider: string,
    usage: ModelAuthStatusProvider["usage"],
  ): ModelAuthStatusProvider {
    return {
      provider,
      displayName: "Claude",
      status: "ok",
      profiles: [{ profileId: `${provider}:default`, type: "oauth", status: "ok" }],
      usage,
    };
  }

  it("collapses providers sharing identical usage into one group", () => {
    const usage: ModelAuthStatusProvider["usage"] = {
      providerId: "anthropic",
      plan: "Max (20x)",
      windows: [
        { label: "5h", usedPercent: 21.6, resetAt: 1_800_000_000_000 },
        { label: "Week", usedPercent: 25 },
      ],
      billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
    };
    const groups = collectProviderQuotaGroups(
      {
        ts: 1,
        providers: [providerWithUsage("anthropic", usage), providerWithUsage("claude-cli", usage)],
      },
      acceptAll,
    );

    expect(groups).toEqual([
      {
        providers: ["anthropic", "claude-cli"],
        displayName: "Claude",
        plan: "Max (20x)",
        windows: [
          { label: "5h", usedPercent: 22, resetAt: 1_800_000_000_000 },
          { label: "Week", usedPercent: 25 },
        ],
        budgets: [{ used: 157.85, limit: 400, unit: "USD" }],
      },
    ]);
  });

  it("carries the account email and keeps distinct accounts in separate groups", () => {
    const windows = [{ label: "5h", usedPercent: 10 }];
    const groups = collectProviderQuotaGroups(
      {
        ts: 1,
        providers: [
          providerWithUsage("anthropic", {
            providerId: "anthropic",
            accountEmail: "work@example.com",
            windows,
          }),
          providerWithUsage("claude-cli", {
            providerId: "anthropic",
            accountEmail: "personal@example.com",
            windows,
          }),
        ],
      },
      acceptAll,
    );

    expect(groups.map((group) => group.accountEmail)).toEqual([
      "work@example.com",
      "personal@example.com",
    ]);
    expect(groups).toHaveLength(2);
  });

  it("drops providers without windows or budgets and invalid budget shapes", () => {
    const groups = collectProviderQuotaGroups(
      {
        ts: 1,
        providers: [
          providerWithUsage("anthropic", { providerId: "anthropic", windows: [] }),
          providerWithUsage("openrouter", {
            providerId: "openrouter",
            windows: [],
            billing: [
              { type: "balance", amount: 10, unit: "USD" },
              { type: "budget", used: 5, limit: 0, unit: "USD" },
            ],
          }),
          providerWithUsage("openai", {
            providerId: "openai",
            windows: [{ label: "Week", usedPercent: 140 }],
          }),
        ],
      },
      acceptAll,
    );

    expect(groups).toEqual([
      {
        providers: ["openai"],
        displayName: "Claude",
        windows: [{ label: "Week", usedPercent: 100 }],
        budgets: [],
      },
    ]);
  });

  it("applies the provider filter", () => {
    const usage = { providerId: "anthropic", windows: [{ label: "5h", usedPercent: 10 }] };
    const groups = collectProviderQuotaGroups(
      { ts: 1, providers: [providerWithUsage("anthropic", usage)] },
      () => false,
    );
    expect(groups).toEqual([]);
  });
});

describe("collectOAuthProfileQuotaGroups", () => {
  it("keeps effective OAuth profiles in auth order and marks the active profile", () => {
    const groups = collectOAuthProfileQuotaGroups(
      {
        ts: 1,
        sessionKey: "agent:main:main",
        activeProfileId: "openai:second",
        activeProfileSource: "user",
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            status: "ok",
            profileOrder: ["openai:second", "openai:first", "openai:second"],
            profiles: [
              {
                profileId: "openai:first",
                type: "oauth",
                status: "ok",
                displayName: "First",
                usage: {
                  status: "ready",
                  providerId: "openai",
                  windows: [
                    { label: "5h", usedPercent: 10.4 },
                    { label: "Day", usedPercent: 77 },
                    { label: "Week", usedPercent: 20 },
                  ],
                },
              },
              {
                profileId: "openai:second",
                type: "oauth",
                status: "ok",
                email: "second@example.com",
                usage: {
                  status: "ready",
                  providerId: "openai",
                  plan: "Plus",
                  windows: [{ label: "Week", usedPercent: 42.6 }],
                },
              },
              {
                profileId: "openai:api",
                type: "api_key",
                status: "static",
                usage: { status: "ready", providerId: "openai", windows: [] },
              },
              {
                profileId: "openai:outside-order",
                type: "oauth",
                status: "ok",
                usage: { status: "unavailable", providerId: "openai" },
              },
            ],
          },
        ],
      },
      () => true,
    );

    expect(groups).toEqual([
      {
        providers: ["openai"],
        displayName: "OpenAI",
        profiles: [
          {
            profileId: "openai:second",
            label: "second@example.com",
            accountEmail: "second@example.com",
            plan: "Plus",
            active: true,
            activeSource: "user",
            status: "ready",
            windows: [{ label: "Week", usedPercent: 43 }],
          },
          {
            profileId: "openai:first",
            label: "First",
            active: false,
            status: "ready",
            windows: [
              { label: "5h", usedPercent: 10 },
              { label: "Week", usedPercent: 20 },
            ],
          },
        ],
      },
    ]);
  });

  it("keeps unavailable profile states isolated", () => {
    const profiles = [
      { profileId: "expired", status: "expired" as const },
      { profileId: "cooldown", status: "cooldown" as const, until: 1_800_000_000_000 },
      { profileId: "unavailable", status: "unavailable" as const },
    ];
    const groups = collectOAuthProfileQuotaGroups(
      {
        ts: 1,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            status: "expired",
            profileOrder: profiles.map((profile) => profile.profileId),
            profiles: profiles.map((profile) => ({
              profileId: profile.profileId,
              type: "oauth" as const,
              status: profile.status === "expired" ? "expired" : "ok",
              usage: { ...profile, providerId: "openai" },
            })),
          },
        ],
      },
      () => true,
    );

    expect(
      groups[0]?.profiles.map(({ profileId, status, until }) => ({
        profileId,
        status,
        until,
      })),
    ).toEqual([
      { profileId: "expired", status: "expired", until: undefined },
      { profileId: "cooldown", status: "cooldown", until: 1_800_000_000_000 },
      { profileId: "unavailable", status: "unavailable", until: undefined },
    ]);
  });
});
