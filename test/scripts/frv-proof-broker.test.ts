import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  createGitHubApi,
  runProofBroker,
  validateBrokerRequest,
  type GitHubApi,
} from "../../scripts/frv-proof-broker.mjs";

const workflowSha = "a".repeat(40);
const landedSha = "b".repeat(40);
const pullHeadSha = "c".repeat(40);
const repository = "openclaw/openclaw";

type BrokerWorkflow = {
  concurrency: { "cancel-in-progress": boolean; group: string };
  jobs: {
    prove: {
      permissions: Record<string, string>;
      steps: Array<{ name?: string; with?: Record<string, unknown> }>;
    };
  };
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
};

type FixtureWorkflow = {
  jobs: { fixture: { permissions: Record<string, string> } };
  on: {
    workflow_dispatch: {
      inputs: { operation: { default: string; options: string[]; type: string } };
    };
  };
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

function brokerEvent(overrides: Record<string, unknown> = {}) {
  return {
    inputs: {
      landed_sha: landedSha,
      pr_number: "128141",
      ...overrides,
    },
  };
}

function fixtureRun(overrides: Record<string, unknown> = {}) {
  return {
    conclusion: "failure",
    display_title: "FRV Proof Fixture [noop] frv-proof-12345-1",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: workflowSha,
    id: 777,
    path: ".github/workflows/frv-proof-fixture.yml",
    repository: { full_name: repository },
    run_attempt: 1,
    status: "completed",
    ...overrides,
  };
}

function fixtureJob(overrides: Record<string, unknown> = {}) {
  return {
    conclusion: "failure",
    head_sha: workflowSha,
    id: 888,
    name: "Fail once, then pass",
    run_attempt: 1,
    run_id: 777,
    status: "completed",
    ...overrides,
  };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    base: { ref: "main", repo: { full_name: repository } },
    head: { sha: pullHeadSha, repo: { full_name: repository } },
    merge_commit_sha: landedSha,
    merged: true,
    merged_at: "2026-08-28T11:35:11Z",
    number: 128141,
    state: "closed",
    ...overrides,
  };
}

function landedAncestry(overrides: Record<string, unknown> = {}) {
  return {
    ahead_by: 1,
    base_commit: { sha: landedSha },
    behind_by: 0,
    merge_base_commit: { sha: landedSha },
    status: "ahead",
    ...overrides,
  };
}

function successfulApi(
  options: {
    ancestries?: Array<Record<string, unknown>>;
    initialRun?: Record<string, unknown>;
    jobsResponse?: Record<string, unknown>;
    mainShas?: string[];
    permissions?: string[];
    pulls?: Array<Record<string, unknown>>;
    recheckedRun?: Record<string, unknown>;
    rerun?: Record<string, unknown>;
    rerunError?: Error;
  } = {},
) {
  const calls: Array<{ body?: unknown; method: string; path: string }> = [];
  let permissionRead = 0;
  let pullRead = 0;
  let mainRead = 0;
  let ancestryRead = 0;
  let rerunRequested = false;
  const initialRun = options.initialRun ?? fixtureRun();
  const rerun =
    options.rerun ??
    fixtureRun({
      conclusion: "success",
      run_attempt: 2,
    });
  const api: GitHubApi = {
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ body, method, path });
      if (method === "GET" && path === "/collaborators/maintainer/permission") {
        const permission = options.permissions?.[permissionRead] ?? "maintain";
        permissionRead += 1;
        return { permission };
      }
      if (method === "GET" && path === "/pulls/128141") {
        const pull = options.pulls?.[pullRead] ?? pullRequest();
        pullRead += 1;
        return pull;
      }
      if (method === "GET" && path === `/compare/${landedSha}...${workflowSha}`) {
        const ancestry = options.ancestries?.[ancestryRead] ?? landedAncestry();
        ancestryRead += 1;
        return ancestry;
      }
      if (method === "GET" && path === "/actions/workflows/frv-proof-fixture.yml") {
        return {
          id: 99,
          name: "FRV Proof Fixture",
          path: ".github/workflows/frv-proof-fixture.yml",
          state: "active",
        };
      }
      if (method === "GET" && path === "/git/ref/heads/main") {
        const sha = options.mainShas?.[mainRead] ?? workflowSha;
        mainRead += 1;
        return { object: { sha }, ref: "refs/heads/main" };
      }
      if (method === "POST" && path === "/actions/workflows/frv-proof-fixture.yml/dispatches") {
        return null;
      }
      if (method === "GET" && path.startsWith("/actions/workflows/frv-proof-fixture.yml/runs?")) {
        return { workflow_runs: [initialRun] };
      }
      if (method === "GET" && path === "/actions/runs/777/attempts/1/jobs?per_page=100") {
        return options.jobsResponse ?? { jobs: [fixtureJob()], total_count: 1 };
      }
      if (method === "POST" && path === "/actions/jobs/888/rerun") {
        rerunRequested = true;
        if (options.rerunError) {
          throw options.rerunError;
        }
        return null;
      }
      if (method === "GET" && path === "/actions/runs/777") {
        return rerunRequested ? rerun : (options.recheckedRun ?? initialRun);
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    }),
  };
  return { api, calls };
}

function runBroker(api: GitHubApi) {
  return runProofBroker({ api, env: brokerEnv(), event: brokerEvent(), sleep: async () => {} });
}

describe("FRV proof broker request validation", () => {
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
});

const dispatch = {
  body: { inputs: { correlation: "frv-proof-12345-1", operation: "noop" }, ref: "main" },
  method: "POST",
  path: "/actions/workflows/frv-proof-fixture.yml/dispatches",
};
const rerunRequest = { body: undefined, method: "POST", path: "/actions/jobs/888/rerun" };
type BrokerOptions = NonNullable<Parameters<typeof successfulApi>[0]>;
type Refusal = [string, BrokerOptions, RegExp, 0 | 1 | 2];

describe("FRV proof broker mutation boundary", () => {
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
      const firstMutation = calls.findIndex((call) => call.method !== "GET");
      expect(calls.slice(0, firstMutation).map((call) => call.path)).toEqual([
        "/actions/workflows/frv-proof-fixture.yml",
        "/collaborators/maintainer/permission",
        "/pulls/128141",
        `/compare/${landedSha}...${workflowSha}`,
        "/git/ref/heads/main",
      ]);
      expect(calls.filter((call) => call.method !== "GET")).toEqual([dispatch, rerunRequest]);
      expect(calls.filter((call) => call.path === rerunRequest.path)).toHaveLength(1);
      const rerunIndex = calls.findIndex((call) => call.path === rerunRequest.path);
      expect(calls.slice(rerunIndex - 4, rerunIndex).map((call) => call.path)).toEqual([
        "/actions/runs/777",
        "/collaborators/maintainer/permission",
        "/pulls/128141",
        `/compare/${landedSha}...${workflowSha}`,
      ]);
    },
  );

  it.each<Refusal>([
    ...(
      [
        ["open", { merged: false, merged_at: null, state: "open" }, /merged pull request/u],
        ["unmerged", { merged: false, merged_at: null }, /merged pull request/u],
        [
          "wrong base",
          { base: { ref: "release/2026.9.1", repo: { full_name: repository } } },
          /base must be main/u,
        ],
        [
          "wrong base repository",
          { base: { ref: "main", repo: { full_name: "attacker/fork" } } },
          /base repository/u,
        ],
        ["wrong merge SHA", { merge_commit_sha: "c".repeat(40) }, /merge commit/u],
      ] satisfies [string, Record<string, unknown>, RegExp][]
    ).map<Refusal>(([name, overrides, error]) => [
      name,
      { pulls: [pullRequest(overrides)] },
      error,
      0,
    ]),
    ...(
      [
        [
          "non-ancestor",
          {
            ahead_by: 0,
            behind_by: 1,
            merge_base_commit: { sha: "c".repeat(40) },
            status: "behind",
          },
        ],
        [
          "wrong ancestry base",
          { base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } },
        ],
      ] satisfies [string, Record<string, unknown>][]
    ).map<Refusal>(([name, ancestry]) => [
      name,
      { ancestries: [landedAncestry(ancestry)] },
      /landed controller ancestry/u,
      0,
    ]),
    ["moved main", { mainShas: ["c".repeat(40)] }, /trusted main moved/u, 0],
    ...(
      [
        ["missing", { jobs: [], total_count: 0 }],
        ["duplicate", { jobs: [fixtureJob(), fixtureJob({ id: 889 })], total_count: 2 }],
        ["incomplete", { jobs: [fixtureJob()], total_count: 2 }],
        ["wrong name", { jobs: [fixtureJob({ name: "Other job" })], total_count: 1 }],
        ["invalid ID", { jobs: [fixtureJob({ id: 0 })], total_count: 1 }],
        ["wrong run", { jobs: [fixtureJob({ run_id: 778 })], total_count: 1 }],
        ["wrong source", { jobs: [fixtureJob({ head_sha: landedSha })], total_count: 1 }],
        ["wrong attempt", { jobs: [fixtureJob({ run_attempt: 2 })], total_count: 1 }],
        ["active", { jobs: [fixtureJob({ status: "in_progress" })], total_count: 1 }],
        ["successful", { jobs: [fixtureJob({ conclusion: "success" })], total_count: 1 }],
      ] satisfies [string, Record<string, unknown>][]
    ).map<Refusal>(([name, jobsResponse]) => [
      `${name} fixture job`,
      { jobsResponse },
      /fixture job/u,
      1,
    ]),
    ...(
      [
        ["repository", { repository: { full_name: "attacker/fork" } }],
        ["run ID", { id: 778 }],
        ["attempt", { run_attempt: 2 }],
        ["workflow", { path: ".github/workflows/other.yml" }],
        ["source", { head_sha: landedSha }],
        ["status", { status: "in_progress" }],
        ["operation", { display_title: "FRV Proof Fixture [publish] frv-proof-12345-1" }],
      ] satisfies [string, Record<string, unknown>][]
    ).map<Refusal>(([name, overrides]) => [
      `changed fixture ${name}`,
      { recheckedRun: fixtureRun(overrides) },
      /fixture run/u,
      1,
    ]),
    [
      "revoked actor",
      { permissions: ["maintain", "read"] },
      /lacks repository write permission/u,
      1,
    ],
    [
      "changed merge",
      { pulls: [pullRequest(), pullRequest({ merge_commit_sha: "c".repeat(40) })] },
      /merge commit/u,
      1,
    ],
    [
      "changed ancestry",
      {
        ancestries: [
          landedAncestry(),
          landedAncestry({
            ahead_by: 0,
            behind_by: 1,
            merge_base_commit: { sha: "c".repeat(40) },
            status: "behind",
          }),
        ],
      },
      /landed controller ancestry/u,
      1,
    ],
    [
      "wrong initial workflow",
      { initialRun: fixtureRun({ path: ".github/workflows/other.yml" }) },
      /workflow does not match/u,
      1,
    ],
    [
      "main replacement race",
      { initialRun: fixtureRun({ head_sha: "c".repeat(40) }) },
      /trusted main workflow SHA/u,
      1,
    ],
    ["rerun rejected", { rerunError: new Error("HTTP 422: rerun rejected") }, /rerun rejected/u, 2],
  ])("refuses %s without further mutation", async (_name, options, error, mutations) => {
    const { api, calls } = successfulApi(options);
    await expect(runBroker(api)).rejects.toThrow(error);
    expect(calls.filter((call) => call.method !== "GET")).toEqual(
      [dispatch, rerunRequest].slice(0, mutations),
    );
    expect(calls.some((call) => call.path.startsWith("/git/refs"))).toBe(false);
  });

  it("accepts a landed SHA identical to the trusted workflow SHA", async () => {
    const identicalSha = workflowSha;
    const { api } = successfulApi({
      pulls: [
        pullRequest({ merge_commit_sha: identicalSha }),
        pullRequest({ merge_commit_sha: identicalSha }),
      ],
    });
    let ancestryReads = 0;
    await runProofBroker({
      api: {
        request: async (method, path, body) => {
          if (method === "GET" && path === `/compare/${identicalSha}...${workflowSha}`) {
            ancestryReads += 1;
            return {
              ahead_by: 0,
              base_commit: { sha: identicalSha },
              behind_by: 0,
              merge_base_commit: { sha: identicalSha },
              status: "identical",
            };
          }
          return api.request(method, path, body);
        },
      },
      env: brokerEnv(),
      event: brokerEvent({ landed_sha: identicalSha }),
      sleep: async () => {},
    });
    expect(ancestryReads).toBe(2);
  });

  it("does not adopt a fixture from a prior broker attempt", async () => {
    const { api, calls } = successfulApi();
    await expect(
      runProofBroker({
        api,
        env: brokerEnv({ GITHUB_RUN_ATTEMPT: "2" }),
        event: brokerEvent(),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/timed out waiting/u);
    expect(calls.filter((call) => call.method !== "GET")).toEqual([
      {
        body: {
          inputs: { correlation: "frv-proof-12345-2", operation: "noop" },
          ref: "main",
        },
        method: "POST",
        path: "/actions/workflows/frv-proof-fixture.yml/dispatches",
      },
    ]);
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
      const result = runProofBroker({
        api,
        env: brokerEnv(),
        event: brokerEvent(),
        sleep: async () => {},
      });
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
});

it("accepts an empty HTTP 201 rerun response without repeating the mutation", async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
  const api = createGitHubApi({ fetchImpl, repository, token: "synthetic-proof-token" });
  await expect(api.request("POST", "/actions/jobs/888/rerun")).resolves.toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

describe("FRV proof workflows", () => {
  const brokerSource = readFileSync(".github/workflows/frv-proof-broker.yml", "utf8");
  const fixtureSource = readFileSync(".github/workflows/frv-proof-fixture.yml", "utf8");
  const broker = parseYaml(brokerSource) as BrokerWorkflow;
  const fixture = parseYaml(fixtureSource) as FixtureWorkflow;

  it("pins broker inputs and write-capable checkout to trusted main", () => {
    expect(Object.keys(broker.on.workflow_dispatch.inputs).toSorted()).toEqual([
      "landed_sha",
      "pr_number",
    ]);
    expect(broker.concurrency).toEqual({
      "cancel-in-progress": false,
      group: "frv-proof-broker",
    });
    const job = broker.jobs.prove;
    expect(job.permissions).toEqual({
      actions: "write",
      contents: "read",
      "pull-requests": "read",
    });
    const checkout = job.steps.find((step) => step.name === "Checkout trusted main broker");
    expect(checkout).toBeDefined();
    expect(checkout?.with).toEqual({
      "fetch-depth": 1,
      "persist-credentials": false,
      ref: "${{ github.workflow_sha }}",
    });
    expect(brokerSource).not.toContain("inputs.landed_sha }}");
    expect(brokerSource).not.toContain("pull/");
    expect(brokerSource).not.toContain("contents: write");
  });

  it("keeps the fixture tokenless and fixes its behavior to noop", () => {
    expect(fixture.permissions).toEqual({});
    expect(fixture.jobs.fixture.permissions).toEqual({});
    expect(fixture.on.workflow_dispatch.inputs.operation).toMatchObject({
      default: "noop",
      options: ["noop"],
      type: "choice",
    });
    expect(fixtureSource).not.toContain("actions/checkout");
  });
});
