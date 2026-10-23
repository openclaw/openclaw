import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inspectHybridHostedHealth } from "../../scripts/lib/ci-hybrid-hosted-health.mts";

const NOW = Date.parse("2026-09-20T16:30:00Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1_000).toISOString();
const completed = { run_attempt: 2, status: "completed", conclusion: "success" };
const run = (overrides: Record<string, unknown> = {}) => ({
  ...completed,
  id: 10,
  event: "push",
  head_branch: "main",
  head_repository: { full_name: "openclaw/openclaw" },
  updated_at: at(10),
  ...overrides,
});
const hostedJobs = (
  job: Record<string, unknown> = {},
  dependency: Record<string, unknown> = {},
) => [
  { ...completed, name: "preflight", completed_at: at(100), ...dependency },
  {
    ...completed,
    name: "check-guards",
    created_at: at(500),
    started_at: at(95),
    labels: ["ubuntu-24.04"],
    runner_id: 12,
    ...job,
  },
];

const inspect = () =>
  inspectHybridHostedHealth({ repository: "openclaw/openclaw", runId: "99", token: "test-token" });
type ExpectedHealth = Partial<Awaited<ReturnType<typeof inspect>>>;

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
async function check(
  jobs: unknown[],
  expected: ExpectedHealth,
  runs: unknown[] = [run()],
  calls?: number,
) {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ workflow_runs: runs }))
    .mockImplementation(async () => Response.json({ jobs }));
  await expect(inspect()).resolves.toMatchObject(expected);
  if (calls !== undefined) {
    expect(fetch).toHaveBeenCalledTimes(calls);
  }
}

it("bounds the history query, excludes dependency time, and shares one request deadline", async () => {
  const created = ">=2026-09-19T16:30:00.000Z";
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/jobs")) {
      return Response.json({ jobs: hostedJobs() });
    }
    // An unrestricted high-volume listing can omit recent matches.
    const updated_at = url.searchParams.get("created") === created ? at(10) : at(86_400);
    return Response.json({ workflow_runs: [run({ updated_at })] });
  });
  const timeout = vi.spyOn(AbortSignal, "timeout");
  await expect(inspect()).resolves.toEqual({
    healthy: true,
    reason: "hosted-assignment-healthy",
    sampledJobs: 1,
    maxWaitSeconds: 5,
  });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://api.github.com/repos/openclaw/openclaw/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=10&created=%3E%3D2026-09-19T16%3A30%3A00.000Z",
    "https://api.github.com/repos/openclaw/openclaw/actions/runs/10/attempts/2/jobs?per_page=100",
  ]);
  const signal = fetch.mock.calls[0]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(fetch.mock.calls[1]?.[1]?.signal).toBe(signal);
  expect(timeout).toHaveBeenCalledWith(10_000);
});

const noEvidence = { healthy: false, reason: "no-fresh-hosted-evidence" };
type Evidence = readonly [unknown[], ExpectedHealth, unknown[]?, number?];
const evidence: Evidence[] = [
  [
    hostedJobs({ status: "queued", runner_id: null, started_at: null }, { completed_at: at(60) }),
    { healthy: false, reason: "hosted-assignment-stalled", sampledJobs: 1 },
  ],
  ...[59, 60].map(
    (wait) =>
      [
        hostedJobs({ created_at: at(wait + 10), started_at: at(10) }, { completed_at: at(500) }),
        { healthy: wait === 59, maxWaitSeconds: wait },
      ] as const,
  ),
  ...[
    hostedJobs({}, { run_attempt: 1 }),
    hostedJobs({ run_attempt: 1 }),
    hostedJobs({ created_at: at(20), runner_id: null, status: "queued", started_at: null }),
    hostedJobs({ conclusion: "skipped" }),
    hostedJobs({ labels: ["self-hosted", "ubuntu-24.04"] }),
    hostedJobs({ started_at: at(1_801) }),
    hostedJobs({}, { completed_at: at(-1) }),
  ].map((jobs) => [jobs, noEvidence] as const),
  [
    hostedJobs(),
    { healthy: false, sampledJobs: 0 },
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
    1,
  ],
  [
    hostedJobs(),
    { healthy: true, sampledJobs: 3 },
    [run(), run({ id: 11 }), run({ id: 12 }), run({ id: 13 })],
    4,
  ],
  ...[
    { runner_id: null, status: "completed", conclusion: "failure" },
    { labels: null },
    { created_at: "invalid" },
  ].map(
    (job) => [hostedJobs(job), { healthy: false, reason: "hosted-health-unavailable" }] as const,
  ),
];
it.each(evidence.map((args) => ({ args })))(
  "evaluates hosted assignment evidence (%#)",
  ({ args }) => check(...args),
);

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
