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

  it.each([
    { status: "queued", runner_id: null, started_at: null },
    { status: "completed", runner_id: 12, started_at: at(20) },
  ])("falls back on $status assignment stalls", async (job) => {
    mockActions([preflight({ completed_at: at(200) }), sentinel(job)]);
    await expect(inspect()).resolves.toMatchObject({
      healthy: false,
      reason: "hosted-assignment-stalled",
      sampledJobs: 1,
    });
  });

  it("uses job creation when a sentinel is created after preflight", async () => {
    mockActions([preflight({ completed_at: at(500) }), sentinel({ created_at: at(100) })]);
    await expect(inspect()).resolves.toMatchObject({ healthy: true, maxWaitSeconds: 5 });
  });

  it.each([
    [preflight({ run_attempt: 1 }), sentinel()],
    [preflight(), sentinel({ run_attempt: 1 })],
    [preflight(), sentinel({ runner_id: null, status: "queued", started_at: null })],
    [preflight(), sentinel({ conclusion: "skipped" })],
    [preflight(), sentinel({ labels: ["self-hosted", "ubuntu-24.04"] })],
    [preflight(), sentinel({ started_at: at(1_801) })],
    [preflight({ completed_at: at(-1) }), sentinel()],
  ])("requires fresh assigned evidence from the current attempt (%#)", async (...jobs) => {
    mockActions(jobs);
    await expect(inspect()).resolves.toMatchObject({
      healthy: false,
      reason: "no-fresh-hosted-evidence",
    });
  });

  it("ignores the current run, cancelled or stale runs, forks, and manual dispatches", async () => {
    const fetch = mockActions(
      [preflight(), sentinel()],
      [
        run({ id: 99 }),
        run({ conclusion: "cancelled" }),
        run({ conclusion: "skipped" }),
        run({ status: "queued" }),
        run({ event: "pull_request" }),
        run({ updated_at: at(1_801) }),
        run({ event: "pull_request", head_repository: { full_name: "fork/openclaw" } }),
        run({ event: "workflow_dispatch" }),
      ],
    );
    await expect(inspect()).resolves.toMatchObject({ healthy: false, sampledJobs: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds evidence to three recent attempts", async () => {
    const fetch = mockActions(
      [preflight(), sentinel()],
      [run(), run({ id: 11 }), run({ id: 12 }), run({ id: 13 })],
    );
    await expect(inspect()).resolves.toMatchObject({ healthy: true, sampledJobs: 3 });
    expect(fetch).toHaveBeenCalledTimes(4);
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

  it.each([
    { runner_id: null, status: "completed", conclusion: "failure" },
    { labels: null },
    { created_at: "invalid" },
  ])("fails closed on incomplete hosted assignment evidence (%#)", async (job) => {
    mockActions([preflight(), sentinel(job)]);
    await expect(inspect()).resolves.toMatchObject({
      healthy: false,
      reason: "hosted-health-unavailable",
    });
  });
});
