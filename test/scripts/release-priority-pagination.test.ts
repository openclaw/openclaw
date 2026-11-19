import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../../scripts/frv.mjs";

type Run = { id: number; created_at: string };
const since = Date.parse("2026-09-24T09:55:23Z");
const until = since + 3_600_000;

function searchClient(runs: Run[]) {
  const select = (resource: string) => {
    const query = new URL(resource, "https://example.invalid/").searchParams;
    const created = query.get("created") ?? "";
    const [lower = "", upper = ""] = created.split("..");
    const start = Date.parse(created.startsWith(">=") ? created.slice(2) : lower);
    const end = created.startsWith(">=") ? Infinity : Date.parse(upper);
    if (!Number.isFinite(start) || Number.isNaN(end)) {
      throw new Error(`Unexpected search range: ${created}`);
    }
    return {
      query,
      matches: runs.filter((run) => {
        const time = Date.parse(run.created_at);
        return time >= start && time <= end;
      }),
    };
  };
  return createClient("openclaw/openclaw", {
    apiText: async (resource: string) =>
      select(resource)
        .matches.slice(0, 1_000)
        .map((run) => JSON.stringify(run))
        .join("\n"),
    apiJson: async (resource: string) => {
      const { query, matches } = select(resource);
      const size = Number(query.get("per_page") ?? 100);
      const offset = (Number(query.get("page") ?? 1) - 1) * size;
      return {
        total_count: matches.length,
        workflow_runs: matches.slice(offset, Math.min(offset + size, 1_000)),
      };
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("release-priority pause-window discovery", () => {
  it.each([
    { count: 1_201, interval: 1_000, truncated: false },
    { count: 1_000, interval: 0, truncated: false },
    { count: 1_001, interval: 0, truncated: true },
  ])(
    "requires a complete $count-run inventory (spacing: $interval ms)",
    async ({ count, interval, truncated }) => {
      vi.spyOn(Date, "now").mockReturnValue(until);
      const runs = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        created_at: new Date(since + index * interval).toISOString(),
      })).toReversed();
      const result = searchClient(runs).listRuns(
        `created=${encodeURIComponent(`>=${new Date(since).toISOString()}`)}`,
      );
      if (truncated) {
        await expect(result).rejects.toThrow(/timestamp window/u);
      } else {
        const found = await result;
        expect(found).toEqual(runs);
        expect(new Set(found.map((run) => run.id)).size).toBe(runs.length);
      }
    },
  );
});
