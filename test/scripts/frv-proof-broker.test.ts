import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  createGitHubApi,
  runProofBroker,
  validateBrokerRequest,
  type GitHubApi,
} from "../../scripts/frv-proof-broker.mjs";

const workflowSha = "a".repeat(40);
const landedSha = "b".repeat(40);
const repository = "openclaw/openclaw";
const foreignSha = "c".repeat(40);
const fixturePath = ".github/workflows/frv-proof-fixture.yml";
const fixtureEndpoint = "/actions/workflows/frv-proof-fixture.yml";
type Fields = Record<string, unknown>;
const completed = {
  conclusion: "failure",
  head_sha: workflowSha,
  run_attempt: 1,
  status: "completed",
};

type BrokerWorkflow = {
  concurrency: { "cancel-in-progress": boolean; group: string };
  jobs: {
    prove: {
      permissions: Record<string, string>;
      steps: Array<{ uses?: string; with?: Record<string, unknown> }>;
    };
  };
};

type FixtureWorkflow = {
  jobs: { fixture: { permissions: Record<string, string> } };
  on: { workflow_dispatch: { inputs: { operation: { options: string[] } } } };
  permissions: Record<string, string>;
};

function brokerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTOR: "maintainer",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "12345",
    GITHUB_SHA: workflowSha,
    GITHUB_TRIGGERING_ACTOR: "maintainer",
    GITHUB_WORKFLOW_REF: "openclaw/openclaw/.github/workflows/frv-proof-broker.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: workflowSha,
    ...overrides,
  };
}

function brokerEvent(overrides: Fields = {}) {
  return { inputs: { landed_sha: landedSha, pr_number: "128141", ...overrides } };
}

function createFixture<T extends Fields>(defaults: T) {
  return (overrides: Fields = {}) => ({ ...defaults, ...overrides });
}
const fixtureRun = createFixture({
  ...completed,
  display_title: "FRV Proof Fixture [noop] frv-proof-12345-1",
  event: "workflow_dispatch",
  head_branch: "main",
  id: 777,
  path: fixturePath,
  repository: { full_name: repository },
});
const fixtureJob = createFixture({
  ...completed,
  id: 888,
  name: "Fail once, then pass",
  run_id: 777,
});
const pullRequest = createFixture({
  base: { ref: "main", repo: { full_name: repository } },
  merge_commit_sha: landedSha,
  merged: true,
  merged_at: "2026-08-28T11:35:11Z",
  number: 128141,
  state: "closed",
});
const landedAncestry = createFixture({
  ahead_by: 1,
  base_commit: { sha: landedSha },
  behind_by: 0,
  merge_base_commit: { sha: landedSha },
  status: "ahead",
});

function successfulApi(
  options: {
    ancestries?: Fields[];
    initialRun?: Fields;
    jobsResponse?: Fields;
    mainShas?: string[];
    permissions?: string[];
    pulls?: Fields[];
    recheckedRun?: Fields;
    rerun?: Fields;
    rerunError?: Error;
    comparisonSha?: string;
  } = {},
) {
  const calls: Array<{ body?: unknown; method: string; path: string }> = [];
  const permissions = options.permissions?.values();
  const pulls = options.pulls?.values();
  const mainShas = options.mainShas?.values();
  const ancestries = options.ancestries?.values();
  let rerunRequested = false;
  const initialRun = options.initialRun ?? fixtureRun();
  const rerun = options.rerun ?? fixtureRun({ conclusion: "success", run_attempt: 2 });
  const reads: Record<string, () => unknown> = {
    "/collaborators/maintainer/permission": () => ({
      permission: permissions?.next().value ?? "maintain",
    }),
    "/pulls/128141": () => pulls?.next().value ?? pullRequest(),
    [`/compare/${options.comparisonSha ?? landedSha}...${workflowSha}`]: () =>
      ancestries?.next().value ?? landedAncestry(),
    [fixtureEndpoint]: () => ({
      id: 99,
      name: "FRV Proof Fixture",
      path: fixturePath,
      state: "active",
    }),
    "/git/ref/heads/main": () => ({
      object: { sha: mainShas?.next().value ?? workflowSha },
      ref: "refs/heads/main",
    }),
    "/actions/runs/777/attempts/1/jobs?per_page=100": () =>
      options.jobsResponse ?? { jobs: [fixtureJob()], total_count: 1 },
    "/actions/runs/777": () => (rerunRequested ? rerun : (options.recheckedRun ?? initialRun)),
  };
  const api: GitHubApi = {
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ body, method, path });
      if (method === "GET" && Object.hasOwn(reads, path)) {
        return reads[path]!();
      }
      if (method === "POST" && path === `${fixtureEndpoint}/dispatches`) {
        return null;
      }
      if (method === "GET" && path.startsWith(`${fixtureEndpoint}/runs?`)) {
        return { workflow_runs: [initialRun] };
      }
      if (method === "POST" && path === "/actions/jobs/888/rerun") {
        rerunRequested = true;
        if (options.rerunError) {
          throw options.rerunError;
        }
        return null;
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    }),
  };
  return { api, calls };
}

function runBroker(api: GitHubApi, env = brokerEnv(), event = brokerEvent()) {
  return runProofBroker({ api, env, event, sleep: async () => {} });
}

const mutationCalls = (calls: Array<{ method: string }>) =>
  calls.filter((call) => call.method !== "GET");

it("accepts only the exact two operator inputs", () => {
  const parsed = validateBrokerRequest(brokerEvent(), brokerEnv());
  expect(parsed).toMatchObject({
    correlation: "frv-proof-12345-1",
    landedSha,
    prNumber: 128141,
    workflowSha,
  });
  expect(() =>
    validateBrokerRequest(brokerEvent({ correlation: "operator-value" }), brokerEnv()),
  ).toThrow(/keys must be exactly/u);
});

it.each([
  { name: "repository", env: { GITHUB_REPOSITORY: "attacker/fork" } },
  { name: "workflow", env: { GITHUB_WORKFLOW_REF: "openclaw/openclaw/other.yml@main" } },
  { name: "ref", env: { GITHUB_REF: "refs/pull/128141/merge" } },
  { name: "workflow SHA", env: { GITHUB_WORKFLOW_SHA: "c".repeat(40) } },
  { name: "actor", env: { GITHUB_TRIGGERING_ACTOR: "different-user" } },
  { name: "PR", inputs: { pr_number: "0" } },
  { name: "landed SHA", inputs: { landed_sha: "ABC" } },
  { name: "run attempt", env: { GITHUB_RUN_ATTEMPT: "0" }, error: /GITHUB_RUN_ATTEMPT/u },
])("rejects invalid $name before API access", ({ env, inputs, error }) => {
  expect(() => validateBrokerRequest(brokerEvent(inputs), brokerEnv(env))).toThrow(error);
});
const dispatchForAttempt = (attempt: number) => ({
  body: { inputs: { correlation: `frv-proof-12345-${attempt}`, operation: "noop" }, ref: "main" },
  method: "POST",
  path: `${fixtureEndpoint}/dispatches`,
});
const dispatch = dispatchForAttempt(1);
const rerunRequest = { body: undefined, method: "POST", path: "/actions/jobs/888/rerun" };
type Refusal = [NonNullable<Parameters<typeof successfulApi>[0]>, RegExp, 0 | 1 | 2];
const nonAncestor = () =>
  landedAncestry({
    ahead_by: 0,
    behind_by: 1,
    merge_base_commit: { sha: foreignSha },
    status: "behind",
  });
const refusal = (options: Refusal[0], error: RegExp, mutations: 0 | 1 | 2 = 1): Refusal => [
  options,
  error,
  mutations,
];
const refusePull = (fields: Fields, error: RegExp) =>
  refusal({ pulls: [pullRequest(fields)] }, error, 0);
const refuseAncestry = (ancestry: Fields) =>
  refusal({ ancestries: [ancestry] }, /landed controller ancestry/u, 0);
const refuseJobs = (jobs: Fields[], total_count = jobs.length) =>
  refusal({ jobsResponse: { jobs, total_count } }, /fixture job/u);
const refuseJob = (fields: Fields) => refuseJobs([fixtureJob(fields)]);
const refuseRun = (fields: Fields) => refusal({ recheckedRun: fixtureRun(fields) }, /fixture run/u);
const refuseInitialRun = (fields: Fields, error: RegExp) =>
  refusal({ initialRun: fixtureRun(fields) }, error);

it.each([1, undefined])(
  "reruns only the fixed job with attempt field %s after authority checks",
  async (attempt) => {
    const { api, calls } = successfulApi({
      jobsResponse: { jobs: [fixtureJob({ run_attempt: attempt })], total_count: 1 },
    });
    const receipt = await runBroker(api);
    expect(receipt).toMatchObject({
      fixtureJobId: 888,
      fixtureRunAttempt: 2,
      fixtureRunId: 777,
      landedSha,
      operation: "noop",
      sourceRef: "refs/heads/main",
    });
    expect(mutationCalls(calls)).toEqual([dispatch, rerunRequest]);
  },
);

it.each<Refusal>([
  refusePull({ merged: false, merged_at: null }, /merged pull request/u),
  refusePull(
    { base: { ref: "release/2026.9.1", repo: { full_name: repository } } },
    /base must be main/u,
  ),
  refusePull({ base: { ref: "main", repo: { full_name: "attacker/fork" } } }, /base repository/u),
  refusePull({ merge_commit_sha: foreignSha }, /merge commit/u),
  refuseAncestry(nonAncestor()),
  refuseAncestry(
    landedAncestry({ base_commit: { sha: foreignSha }, merge_base_commit: { sha: foreignSha } }),
  ),
  [{ mainShas: [foreignSha] }, /trusted main moved/u, 0],
  refuseJobs([]),
  refuseJobs([fixtureJob(), fixtureJob({ id: 889 })]),
  refuseJobs([fixtureJob()], 2),
  refuseJob({ name: "Other job" }),
  refuseJob({ id: 0 }),
  refuseJob({ run_id: 778 }),
  refuseJob({ head_sha: landedSha }),
  refuseJob({ run_attempt: 2 }),
  refuseJob({ status: "in_progress" }),
  refuseJob({ conclusion: "success" }),
  refuseRun({ repository: { full_name: "attacker/fork" } }),
  refuseRun({ id: 778 }),
  refuseRun({ run_attempt: 2 }),
  refuseRun({ path: ".github/workflows/other.yml" }),
  refuseRun({ head_sha: landedSha }),
  refuseRun({ status: "in_progress" }),
  refuseRun({ display_title: "FRV Proof Fixture [publish] frv-proof-12345-1" }),
  [{ permissions: ["maintain", "read"] }, /lacks repository write permission/u, 1],
  [{ pulls: [pullRequest(), pullRequest({ merge_commit_sha: foreignSha })] }, /merge commit/u, 1],
  [{ ancestries: [landedAncestry(), nonAncestor()] }, /landed controller ancestry/u, 1],
  refuseInitialRun({ path: ".github/workflows/other.yml" }, /workflow does not match/u),
  refuseInitialRun({ head_sha: foreignSha }, /trusted main workflow SHA/u),
  [{ rerunError: new Error("HTTP 422: rerun rejected") }, /rerun rejected/u, 2],
])("refuses %j without further mutation", async (options, error, mutations) => {
  const { api, calls } = successfulApi(options);
  await expect(runBroker(api)).rejects.toThrow(error);
  expect(calls.filter((call) => call.method !== "GET")).toEqual(
    [dispatch, rerunRequest].slice(0, mutations),
  );
  expect(calls.some((call) => call.path.startsWith("/git/refs"))).toBe(false);
});

it("accepts a landed SHA identical to the trusted workflow SHA", async () => {
  const ancestry = landedAncestry({
    ahead_by: 0,
    base_commit: { sha: workflowSha },
    merge_base_commit: { sha: workflowSha },
    status: "identical",
  });
  const { api, calls } = successfulApi({
    comparisonSha: workflowSha,
    ancestries: [ancestry, ancestry],
    pulls: Array.from({ length: 2 }, () => pullRequest({ merge_commit_sha: workflowSha })),
  });
  await runBroker(api, brokerEnv(), brokerEvent({ landed_sha: workflowSha }));
  expect(
    calls.filter((call) => call.path === `/compare/${workflowSha}...${workflowSha}`),
  ).toHaveLength(2);
});

it("does not adopt a fixture from a prior broker attempt", async () => {
  const { api, calls } = successfulApi();
  await expect(runBroker(api, brokerEnv({ GITHUB_RUN_ATTEMPT: "2" }))).rejects.toThrow(
    /timed out waiting/u,
  );
  expect(mutationCalls(calls)).toEqual([dispatchForAttempt(2)]);
});

it.each([true, false])(
  "reconciles one uncertain targeted rerun when observed=%s",
  async (observed) => {
    const { api, calls } = successfulApi({
      rerunError: Object.assign(new Error("read ECONNRESET after dispatch"), {
        code: "ECONNRESET",
      }),
      ...(observed ? {} : { rerun: fixtureRun() }),
    });
    const result = runBroker(api);
    if (observed) {
      await expect(result).resolves.toMatchObject({ fixtureJobId: 888, fixtureRunAttempt: 2 });
    } else {
      await expect(result).rejects.toThrow("uncertain targeted job rerun was not reconciled");
    }
    expect(
      calls.filter((call) => call.method === "POST" && call.path === "/actions/jobs/888/rerun"),
    ).toHaveLength(1);
  },
);
it("accepts an empty HTTP 201 rerun response without repeating the mutation", async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
  const api = createGitHubApi({ fetchImpl, repository, token: "synthetic-proof-token" });
  await expect(api.request("POST", "/actions/jobs/888/rerun")).resolves.toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("isolates the serialized write-capable broker from the tokenless fixture", () => {
  const broker: BrokerWorkflow = parseYaml(
    readFileSync(".github/workflows/frv-proof-broker.yml", "utf8"),
  );
  const fixtureSource = readFileSync(".github/workflows/frv-proof-fixture.yml", "utf8");
  const fixture: FixtureWorkflow = parseYaml(fixtureSource);
  expect(broker.concurrency["cancel-in-progress"]).toBe(false);
  expect(broker.concurrency.group).not.toContain("${{");
  const job = broker.jobs.prove;
  expect(Object.entries(job.permissions).filter(([, level]) => level === "write")).toEqual([
    ["actions", "write"],
  ]);
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with).toMatchObject({
    "persist-credentials": false,
    ref: "${{ github.workflow_sha }}",
  });
  expect(fixture.permissions).toEqual({});
  expect(fixture.jobs.fixture.permissions).toEqual({});
  expect(fixture.on.workflow_dispatch.inputs.operation.options).toEqual(["noop"]);
  expect(fixtureSource).not.toContain("actions/checkout");
});
