import { nothing } from "lit";
import { describe, expect, it } from "vitest";
import { __resetProviderBalanceCache, renderProviderBalancePill } from "./provider-balance-pill.ts";

function fakeClient(summary: unknown) {
  return { request: async () => summary } as never;
}

/** Flattens a nested TemplateResult into a searchable string. */
function flatten(value: unknown, acc = ""): string {
  if (value === null || value === undefined) return acc;
  if (typeof value === "string" || typeof value === "number") return acc + String(value);
  if (typeof value === "function") return acc + String(value);
  const record = value as { strings?: readonly string[]; values?: readonly unknown[] };
  if (Array.isArray(record.strings)) {
    for (let i = 0; i < record.strings.length; i += 1) {
      acc += record.strings[i];
      if (i < (record.values ?? []).length) acc = flatten(record.values![i], acc);
    }
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) acc = flatten(item, acc);
    return acc;
  }
  return acc;
}

async function settle() {
  await new Promise((r) => setTimeout(r, 10));
}

const deepseekSummary = {
  providers: [
    {
      provider: "deepseek",
      displayName: "DeepSeek",
      windows: [],
      billing: [{ type: "balance", amount: 9.67, unit: "CNY" }],
      summary: "Balance ¥9.67",
    },
  ],
};

describe("provider-balance-pill", () => {
  it("renders nothing without a client", () => {
    __resetProviderBalanceCache();
    expect(renderProviderBalancePill({ connected: true, client: null })).toBe(nothing);
  });

  it("renders nothing when disconnected", () => {
    __resetProviderBalanceCache();
    expect(renderProviderBalancePill({ connected: false, client: fakeClient(deepseekSummary) })).toBe(
      nothing,
    );
  });

  it("uses the built-in DeepSeek branding by default", async () => {
    __resetProviderBalanceCache();
    renderProviderBalancePill({
      connected: true,
      client: fakeClient(deepseekSummary),
      activeProvider: "deepseek",
    });
    await settle();
    const text = flatten(
      renderProviderBalancePill({
        connected: true,
        client: fakeClient(deepseekSummary),
        activeProvider: "deepseek",
      }),
    );
    expect(text).toContain("9.67");
    expect(text).toContain("余额");
    expect(text).toContain("ProviderIcon-deepseek.svg");
    expect(text).toContain("#4d6bfe");
    expect(text).toContain("console");
  });

  it("switches branding for anthropic", async () => {
    __resetProviderBalanceCache();
    const anthropic = {
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [{ displayName: "5h", label: "tokens", remaining: 42 }],
        },
      ],
    };
    renderProviderBalancePill({
      connected: true,
      client: fakeClient(anthropic),
      activeProvider: "anthropic",
    });
    await settle();
    const text = flatten(
      renderProviderBalancePill({
        connected: true,
        client: fakeClient(anthropic),
        activeProvider: "anthropic",
      }),
    );
    expect(text).toContain("ProviderIcon-claude.svg");
    expect(text).toContain("#d97757");
    expect(text).toContain("console");
  });

  it("applies operator overrides for label, color, url and icon", async () => {
    __resetProviderBalanceCache();
    renderProviderBalancePill({
      connected: true,
      client: fakeClient(deepseekSummary),
      activeProvider: "deepseek",
      overrides: {
        label: "Credits",
        providers: {
          deepseek: {
            color: "#ff0000",
            url: "https://example.com/billing",
            icon: "claude",
            label: "Wallet",
          },
        },
      },
    });
    await settle();
    const text = flatten(
      renderProviderBalancePill({
        connected: true,
        client: fakeClient(deepseekSummary),
        activeProvider: "deepseek",
        overrides: {
          label: "Credits",
          providers: {
            deepseek: {
              color: "#ff0000",
              url: "https://example.com/billing",
              icon: "claude",
              label: "Wallet",
            },
          },
        },
      }),
    );
    // Provider label wins over the global label.
    expect(text).toContain("Wallet");
    expect(text).not.toContain("余额");
    expect(text).toContain("#ff0000");
    expect(text).toContain("ProviderIcon-claude.svg");
    // The URL only lives in the click handler / title, not in markup attributes.
    expect(text).toContain("console");
  });

  it("accepts an absolute icon URL", async () => {
    __resetProviderBalanceCache();
    renderProviderBalancePill({
      connected: true,
      client: fakeClient(deepseekSummary),
      overrides: { providers: { deepseek: { icon: "https://cdn.test/logo.svg" } } },
    });
    await settle();
    const text = flatten(
      renderProviderBalancePill({
        connected: true,
        client: fakeClient(deepseekSummary),
        overrides: { providers: { deepseek: { icon: "https://cdn.test/logo.svg" } } },
      }),
    );
    expect(text).toContain("https://cdn.test/logo.svg");
  });

  it("marks low balances below the configured threshold", async () => {
    __resetProviderBalanceCache();
    const small = {
      providers: [
        {
          provider: "deepseek",
          billing: [{ type: "balance", amount: 0.42, unit: "CNY" }],
          windows: [],
        },
      ],
    };
    renderProviderBalancePill({
      connected: true,
      client: fakeClient(small),
      overrides: { lowBalanceThreshold: 5 },
    });
    await settle();
    const text = flatten(
      renderProviderBalancePill({
        connected: true,
        client: fakeClient(small),
        overrides: { lowBalanceThreshold: 5 },
      }),
    );
    expect(text).toContain("provider-balance-pill--low");
  });

  it("does not flag low balance above the threshold", async () => {
    __resetProviderBalanceCache();
    renderProviderBalancePill({
      connected: true,
      client: fakeClient(deepseekSummary),
      overrides: { lowBalanceThreshold: 5 },
    });
    await settle();
    const text = flatten(
      renderProviderBalancePill({
        connected: true,
        client: fakeClient(deepseekSummary),
        overrides: { lowBalanceThreshold: 5 },
      }),
    );
    expect(text).not.toContain("--low");
  });
});
