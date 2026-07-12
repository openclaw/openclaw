import { describe, expect, it } from "vitest";
import { mergeUsageSummaries } from "./codex-synthetic-usage.js";

describe("mergeUsageSummaries", () => {
  it("preserves OAuth plan and billing when synthetic Codex windows win", () => {
    const merged = mergeUsageSummaries(
      {
        updatedAt: 1,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            plan: "Plus",
            windows: [{ label: "Week", usedPercent: 40 }],
            billing: [{ type: "balance", amount: 12.5, unit: "credits" }],
          },
        ],
      },
      {
        updatedAt: 2,
        providers: [
          {
            provider: "openai",
            displayName: "Codex",
            windows: [{ label: "5h", usedPercent: 10 }],
          },
        ],
      },
    );

    expect(merged).toEqual({
      updatedAt: 1,
      providers: [
        {
          provider: "openai",
          displayName: "Codex",
          plan: "Plus",
          windows: [{ label: "5h", usedPercent: 10 }],
          billing: [{ type: "balance", amount: 12.5, unit: "credits" }],
          error: undefined,
        },
      ],
    });
  });

  it("ranks billing-only snapshots above errors", () => {
    const merged = mergeUsageSummaries(
      {
        updatedAt: 1,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [],
            billing: [{ type: "balance", amount: 4, unit: "credits" }],
          },
        ],
      },
      {
        updatedAt: 2,
        providers: [
          {
            provider: "openai",
            displayName: "Codex",
            windows: [],
            error: "Unavailable",
          },
        ],
      },
    );

    expect(merged.providers[0]).toMatchObject({
      displayName: "OpenAI",
      billing: [{ type: "balance", amount: 4, unit: "credits" }],
      error: undefined,
    });
  });

  it("preserves provider endpoint errors over synthetic fallback errors", () => {
    const merged = mergeUsageSummaries(
      {
        updatedAt: 1,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [],
            error: "Admin API key required",
          },
        ],
      },
      {
        updatedAt: 2,
        providers: [
          {
            provider: "openai",
            displayName: "Codex",
            windows: [],
            error: "Codex account authentication required",
          },
        ],
      },
    );

    expect(merged.providers[0]).toMatchObject({
      displayName: "OpenAI",
      error: "Admin API key required",
    });
  });
});
