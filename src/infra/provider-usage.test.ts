import { describe, expect, it, vi } from "vitest";
import {
  formatUsageReportLines,
  formatUsageSummaryLine,
  loadProviderUsageSummary,
  type UsageSummary,
} from "./provider-usage.js";

describe("provider usage formatting", () => {
  it("returns null when no usage is available", () => {
    const summary: UsageSummary = { updatedAt: 0, providers: [] };
    expect(formatUsageSummaryLine(summary)).toBeNull();
  });

  it("picks the most-used window for summary line", () => {
    const summary: UsageSummary = {
      updatedAt: 0,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [
            { label: "5h", usedPercent: 10 },
            { label: "Week", usedPercent: 60 },
          ],
        },
      ],
    };
    const line = formatUsageSummaryLine(summary, { now: 0 });
    expect(line).toContain("Claude");
    expect(line).toContain("40% left");
    expect(line).toContain("(Week");
  });

  it("prints provider errors in report output", () => {
    const summary: UsageSummary = {
      updatedAt: 0,
      providers: [
        {
          provider: "openai-codex",
          displayName: "Codex",
          windows: [],
          error: "Token expired",
        },
      ],
    };
    const lines = formatUsageReportLines(summary);
    expect(lines.join("\n")).toContain("Codex: Token expired");
  });

  it("includes reset countdowns in report lines", () => {
    const now = Date.UTC(2026, 0, 7, 0, 0, 0);
    const summary: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [
            { label: "5h", usedPercent: 20, resetAt: now + 60_000 },
          ],
        },
      ],
    };
    const lines = formatUsageReportLines(summary, { now });
    expect(lines.join("\n")).toContain("resets 1m");
  });
});

describe("provider usage loading", () => {
  it("loads usage snapshots with injected auth", async () => {
    const makeResponse = (status: number, body: unknown) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }) as any;

    const mockFetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("api.anthropic.com")) {
        return makeResponse(200, {
          five_hour: { utilization: 20, resets_at: "2026-01-07T01:00:00Z" },
        });
      }
      if (url.includes("api.z.ai")) {
        return makeResponse(200, {
          success: true,
          code: 200,
          data: {
            planName: "Pro",
            limits: [
              {
                type: "TOKENS_LIMIT",
                percentage: 25,
                unit: 3,
                number: 6,
                nextResetTime: "2026-01-07T06:00:00Z",
              },
            ],
          },
        });
      }
      return makeResponse(404, "not found");
    });

    const summary = await loadProviderUsageSummary({
      now: Date.UTC(2026, 0, 7, 0, 0, 0),
      auth: [
        { provider: "anthropic", token: "token-1" },
        { provider: "zai", token: "token-2" },
      ],
      fetch: mockFetch,
    });

    expect(summary.providers).toHaveLength(2);
    const claude = summary.providers.find((p) => p.provider === "anthropic");
    const zai = summary.providers.find((p) => p.provider === "zai");
    expect(claude?.windows[0]?.label).toBe("5h");
    expect(zai?.plan).toBe("Pro");
    expect(mockFetch).toHaveBeenCalled();
  });
});
