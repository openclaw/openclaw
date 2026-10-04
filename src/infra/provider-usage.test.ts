import { beforeEach, expect, it } from "vitest";
import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";
import {
  getProviderUsageSnapshotWithPluginMock,
  resetProviderUsageSnapshotWithPluginMock,
} from "./provider-usage-plugin-runtime.test-mocks.js";
import { formatUsageReportLines } from "./provider-usage.format.js";
import { loadProviderUsageSummary } from "./provider-usage.js";
import { loadUsageWithAuth, usageNow } from "./provider-usage.test-support.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

beforeEach(resetProviderUsageSnapshotWithPluginMock);

it.each<[Partial<ProviderUsageSnapshot>, string]>([
  [{ error: "Token expired" }, "Claude: Token expired"],
  [{ summary: "Balance ¥42.50" }, "Claude: Balance ¥42.50"],
  [{ windows: [{ label: "5h", usedPercent: 20, resetAt: usageNow + 60_000 }] }, "resets 1m"],
])("formats provider usage %j", (entry, expected) => {
  const lines = formatUsageReportLines(
    {
      updatedAt: usageNow,
      providers: [{ provider: "anthropic", displayName: "Claude", windows: [], ...entry }],
    },
    { now: usageNow },
  );
  expect(lines.join("\n")).toContain(expected);
});

it("loads window and balance snapshots with injected auth", async () => {
  const snapshots: ProviderUsageSnapshot[] = [
    { provider: "anthropic", displayName: "Claude", windows: [{ label: "5h", usedPercent: 20 }] },
    { provider: "deepseek", displayName: "DeepSeek", windows: [], summary: "Balance ¥42.50" },
  ];
  getProviderUsageSnapshotWithPluginMock().mockImplementation(
    async ({ provider }) => snapshots.find((snapshot) => snapshot.provider === provider) ?? null,
  );
  const mockFetch = createProviderUsageFetch(async () => {
    throw new Error("legacy fetch should not run");
  });
  const summary = await loadUsageWithAuth(
    loadProviderUsageSummary,
    [
      { provider: "anthropic", token: "token-1" },
      { provider: "deepseek", token: "token-2" },
    ],
    mockFetch,
  );
  expect(summary.providers).toHaveLength(2);
  expect(summary.providers[0]?.windows[0]?.label).toBe("5h");
  expect(summary.providers[1]?.summary).toBe("Balance ¥42.50");
  expect(mockFetch).not.toHaveBeenCalled();
});
