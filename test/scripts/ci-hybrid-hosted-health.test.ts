import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectHybridHostedHealth } from "../../scripts/lib/ci-hybrid-hosted-health.mts";

const NOW = Date.parse("2026-09-20T16:30:00Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1_000).toISOString();
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 10,
  run_attempt: 2,
  event: "push",
  head_branch: "main",
  head_repository: { full_name: "openclaw/openclaw" },
  updated_at: at(10),
  conclusion: "success",
  status: "completed",
  ...overrides,
});
const preflight = (overrides: Record<string, unknown> = {}) => ({
  name: "preflight",
  run_attempt: 2,
  status: "completed",
  conclusion: "success",
  completed_at: at(100),
  ...overrides,
});
const sentinel = (overrides: Record<string, unknown> = {}) => ({
  name: "check-guards",
  run_attempt: 2,
  status: "completed",
  conclusion: "success",
  created_at: at(500),
  started_at: at(95),
  labels: ["ubuntu-24.04"],
  runner_id: 12,
  ...overrides,
});

function mockActions(jobs: unknown[], runs: unknown[] = [run()]) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ workflow_runs: runs }))
    .mockImplementation(async () => Response.json({ jobs }));
}

const inspect = () =>
  inspectHybridHostedHealth({ repository: "openclaw/openclaw", runId: "99", token: "test-token" });

afterEach(() => vi.restoreAllMocks());

describe("hybrid hosted assignment health", () => {
  it("bounds the history query, excludes dependency time, and shares one request deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const created = ">=2026-09-19T16:30:00.000Z";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return Response.json(
        url.pathname.endsWith("/jobs")
          ? { jobs: [preflight(), sentinel()] }
          : {
              workflow_runs: [
                // An unrestricted high-volume listing can omit recent matches.
                run({
                  updated_at: url.searchParams.get("created") === created ? at(10) : at(86_400),
                }),
              ],
            },
      );
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await expect(inspect()).resolves.toEqual({
      healthy: true,
      reason: "hosted-assignment-healthy",
      sampledJobs: 1,
      maxWaitSeconds: 5,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/openclaw/openclaw/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=10&created=%3E%3D2026-09-19T16%3A30%3A00.000Z",
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/openclaw/openclaw/actions/runs/10/attempts/2/jobs?per_page=100",
    );
    const signal = fetch.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(fetch.mock.calls[1]?.[1]?.signal).toBe(signal);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  const evidence: {
    name: string;
    jobs: unknown[];
    runs?: unknown[];
    expected: Partial<Awaited<ReturnType<typeof inspectHybridHostedHealth>>>;
    calls?: number;
  }[] = [
    {
      name: "queued assignment stalls",
      jobs: [
        preflight({ completed_at: at(60) }),
        sentinel({ status: "queued", runner_id: null, started_at: null }),
      ],
      expected: { healthy: false, reason: "hosted-assignment-stalled", sampledJobs: 1 },
    },
    ...[
      { wait: 59, healthy: true },
      { wait: 60, healthy: false },
    ].map(({ wait, healthy }) => ({
      name: `${wait}-second assignment threshold`,
      jobs: [
        preflight({ completed_at: at(500) }),
        sentinel({ created_at: at(wait + 10), started_at: at(10) }),
      ],
      expected: { healthy, maxWaitSeconds: wait },
    })),
    ...[
      [preflight({ run_attempt: 1 }), sentinel()],
      [preflight(), sentinel({ run_attempt: 1 })],
      [
        preflight(),
        sentinel({ created_at: at(20), runner_id: null, status: "queued", started_at: null }),
      ],
      [preflight(), sentinel({ conclusion: "skipped" })],
      [preflight(), sentinel({ labels: ["self-hosted", "ubuntu-24.04"] })],
      [preflight(), sentinel({ started_at: at(1_801) })],
      [preflight({ completed_at: at(-1) }), sentinel()],
    ].map((jobs, index) => ({
      name: `unusable current-attempt evidence ${index}`,
      jobs,
      expected: { healthy: false, reason: "no-fresh-hosted-evidence" },
    })),
    {
      name: "current, cancelled, stale, fork or manual runs",
      jobs: [preflight(), sentinel()],
      runs: [
        run({ id: 99 }),
        run({ conclusion: "cancelled" }),
        run({ conclusion: "skipped" }),
        run({ status: "queued" }),
        run({ event: "pull_request" }),
        run({ updated_at: at(1_801) }),
        run({ event: "pull_request", head_repository: { full_name: "fork/openclaw" } }),
        run({ event: "workflow_dispatch" }),
      ],
      expected: { healthy: false, sampledJobs: 0 },
      calls: 1,
    },
    {
      name: "at most three recent attempts",
      jobs: [preflight(), sentinel()],
      runs: [run(), run({ id: 11 }), run({ id: 12 }), run({ id: 13 })],
      expected: { healthy: true, sampledJobs: 3 },
      calls: 4,
    },
    ...[
      { runner_id: null, status: "completed", conclusion: "failure" },
      { labels: null },
      { created_at: "invalid" },
    ].map((job, index) => ({
      name: `incomplete hosted assignment evidence ${index}`,
      jobs: [preflight(), sentinel(job)],
      expected: { healthy: false, reason: "hosted-health-unavailable" },
    })),
  ];
  it.each(evidence)("evaluates $name", async ({ jobs, runs, expected, calls }) => {
    const fetch = mockActions(jobs, runs);
    await expect(inspect()).resolves.toMatchObject(expected);
    if (calls !== undefined) {
      expect(fetch).toHaveBeenCalledTimes(calls);
    }
  });

  it.each([
    () => Promise.reject(new Error("private request diagnostics")),
    () => Promise.resolve(new Response("private request diagnostics", { status: 403 })),
    () => Promise.resolve(Response.json({ workflow_runs: "invalid" })),
  ])("falls back without exposing API diagnostics (%#)", async (response) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(response);
    await expect(inspect()).resolves.toEqual({
      healthy: false,
      reason: "hosted-health-unavailable",
      sampledJobs: 0,
      maxWaitSeconds: 0,
    });
  });
});
