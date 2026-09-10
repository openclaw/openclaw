import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  continueFailed,
  createClient,
  inspectContinuation,
  loadPlan,
  preflightContinuation,
} from "../../scripts/frv.mjs";
import { buildFullReleaseCandidateRequest } from "../../scripts/full-release-candidate-contract.mjs";
import {
  buildReleaseExecutionPlan,
  buildReleaseExecutionPlanArtifact,
  releaseChildSpec,
  releaseCompositeJobsSha256,
  releaseExecutionPlanSha256,
  validateReleaseExecutionPlanArtifact,
} from "../../scripts/full-release-validation-policy.mjs";
import { validateParentManifest } from "../../scripts/release-ci-summary.mjs";

const SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const SOURCE_REF = `release-ci/${SHA.slice(0, 12)}-77`;
const REPOSITORY = "openclaw/openclaw";

function job(name: string, conclusion = "success") {
  return {
    completed_at: "2026-08-22T00:01:00Z",
    conclusion,
    html_url: `https://example.invalid/jobs/${name}`,
    name,
    started_at: "2026-08-22T00:00:00Z",
    status: "completed",
  };
}

function child(key: string, runId: string) {
  const spec = releaseChildSpec(key);
  return {
    displayTitle: `${spec.displayName} full-release-validation-77-1${spec.suffix}`,
    key,
    required: true,
    runAttempt: 1,
    runId,
    selected: true,
    sourceParentAttempt: 1,
    url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    workflow: spec.workflow,
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  };
}

function withoutChildRunIdentity(entry: ReturnType<typeof child>) {
  const missing = structuredClone(entry);
  Reflect.set(missing, "runAttempt", null);
  Reflect.set(missing, "runId", "");
  Reflect.set(missing, "url", "");
  return missing;
}

function requiredChildren() {
  return [
    child("normalCi", "101"),
    child("pluginPrerelease", "202"),
    child("releaseChecks", "303"),
    child("productPerformance", "404"),
  ];
}

function plan(children = requiredChildren()) {
  return {
    attemptEvidenceVersion: 2,
    children,
    parentRunAttempt: 1,
    parentRunId: "77",
    releaseProfile: "beta",
    rerunGroup: "all",
    targetSha: TARGET_SHA,
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: SHA },
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  };
}

function executionPlanArtifact({
  children = requiredChildren(),
  evidenceReuse = { requested: false },
}: {
  children?: ReturnType<typeof requiredChildren>;
  evidenceReuse?: Record<string, unknown>;
} = {}) {
  const built = buildReleaseExecutionPlan({
    children: Object.fromEntries(
      children.map((entry) => [
        entry.key,
        {
          result: "success",
          runAttempt: entry.runAttempt,
          runId: entry.runId,
          url: entry.url,
        },
      ]),
    ),
    dockerPreflightResult: "success",
    evidenceReuse: evidenceReuse.requested === true,
    parentRunAttempt: 1,
    parentRunId: "77",
    candidateBindingResult: "success",
    rerunGroup: "all",
    resolveTargetResult: "success",
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  });
  const candidateRequest = buildFullReleaseCandidateRequest({
    repository: REPOSITORY,
    targetSha: TARGET_SHA,
    toolingSha: SHA,
    releaseProfile: "beta",
    releaseSoak: false,
    upgradeSurvivorBaseline: "openclaw@latest",
    upgradeSurvivorBaselines: "",
    upgradeSurvivorScenarios: "",
    allowFrozenTargetScenarioOmissions: false,
    allowUnreleasedChangelog: false,
    packagePublished: false,
    sharedImagePolicy: "no-push-artifact",
  });
  const selectedKeys = new Set(children.map((entry) => entry.key));
  return buildReleaseExecutionPlanArtifact({
    attemptEvidenceVersion: 2,
    candidate: null,
    children: built.children.map((entry) =>
      selectedKeys.has(entry.key)
        ? entry
        : {
            ...entry,
            required: false,
            result: "skipped",
            runAttempt: null,
            runId: "",
            selected: false,
            url: "",
          },
    ),
    evidenceReuse,
    expected: {
      candidateRequest,
      parentRunAttempt: 1,
      parentRunId: "77",
      repository: REPOSITORY,
      targetSha: TARGET_SHA,
      workflowRef: SOURCE_REF,
      workflowSha: SHA,
    },
    gates: built.gates,
    releaseProfile: "beta",
    rerunGroup: "all",
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: SHA },
  });
}

function historicalExecutionPlanArtifact() {
  const artifact = structuredClone(executionPlanArtifact());
  delete artifact.attemptEvidenceVersion;
  delete artifact.candidate;
  delete artifact.candidateRequest;
  delete artifact.repository;
  for (const entry of artifact.children) {
    delete entry.sourceParentAttempt;
  }
  artifact.sha256 = releaseExecutionPlanSha256(artifact);
  return artifact;
}

function runFor(
  entry: ReturnType<typeof child>,
  attempt: number,
  conclusion: string | null,
  status = conclusion === null ? "in_progress" : "completed",
) {
  return {
    actor: { login: "github-actions[bot]" },
    conclusion,
    display_title: entry.displayTitle,
    event: "workflow_dispatch",
    head_branch: entry.workflowRef,
    head_sha: entry.workflowSha,
    html_url: entry.url,
    id: Number(entry.runId),
    path: `.github/workflows/${entry.workflow}`,
    repository: { full_name: REPOSITORY },
    run_attempt: attempt,
    status,
    triggering_actor: {
      login: attempt === entry.runAttempt ? "github-actions[bot]" : "release-operator",
    },
  };
}

function rootRun(
  attempt = 1,
  conclusion: string | null = "failure",
  status = conclusion === null ? "in_progress" : "completed",
) {
  return {
    actor: { login: "github-actions[bot]" },
    conclusion,
    display_title: "Full Release Validation",
    event: "workflow_dispatch",
    head_branch: SOURCE_REF,
    head_sha: SHA,
    id: 77,
    path: ".github/workflows/full-release-validation.yml",
    repository: { full_name: REPOSITORY },
    run_attempt: attempt,
    status,
    triggering_actor: { login: attempt === 1 ? "github-actions[bot]" : "release-operator" },
  };
}

function preflightMethods(
  children: ReturnType<typeof child>[],
  childRun: (entry: ReturnType<typeof child>) => Record<string, unknown>,
  options: { failFast?: boolean; childRunIdOverride?: string; ciReleaseScope?: string } = {},
) {
  const byRunId = new Map(children.map((entry) => [entry.runId, entry]));
  const parentJobs = [
    {
      conclusion: "success",
      id: 1,
      name: "Resolve target ref",
      run_attempt: 1,
      status: "completed",
    },
    ...children.map((entry, index) => ({
      conclusion: "failure",
      id: index + 2,
      name: releaseChildSpec(entry.key).parentJobName,
      run_attempt: 1,
      status: "completed",
    })),
  ];
  return {
    getJobLog: async (jobId: number) => {
      if (jobId === 1) {
        return [
          "RERUN_GROUP: all",
          `FAIL_FAST: ${options.failFast === true ? "true" : "false"}`,
          `TARGET_SHA: ${TARGET_SHA}`,
        ].join("\n");
      }
      const entry = children[jobId - 2]!;
      const runId = options.childRunIdOverride ?? entry.runId;
      return [
        `TARGET_SHA: ${TARGET_SHA}`,
        ...(entry.key === "productPerformance" ? ["-f publish_reports=false"] : []),
        ...(entry.key === "normalCi" && options.ciReleaseScope
          ? [`CI_RELEASE_SCOPE: ${options.ciReleaseScope}`]
          : []),
        `Dispatched ${entry.workflow}: https://github.com/${REPOSITORY}/actions/runs/${runId} (attempt 1)`,
      ].join("\n");
    },
    getParentJobs: async () => parentJobs,
    getRunAttempt: async (runId: string) =>
      runId === "77" ? rootRun() : childRun(byRunId.get(runId)!),
  };
}

function controllerClient(
  children: ReturnType<typeof child>[],
  childRuns: Map<string, { attempt: number; conclusion: string | null }>,
  parent: { attempt: number; conclusion: string | null },
) {
  const byRunId = new Map(children.map((entry) => [entry.runId, entry]));
  return {
    ...preflightMethods(children, (entry) => runFor(entry, 1, "failure")),
    getAttemptJobs: async (runId: string, attempt: number) => [
      job(
        "test",
        attempt === childRuns.get(runId)?.attempt
          ? (childRuns.get(runId)?.conclusion ?? "")
          : "failure",
      ),
    ],
    getRun: async (runId: string) =>
      runId === "77"
        ? rootRun(parent.attempt, parent.conclusion)
        : runFor(
            byRunId.get(runId)!,
            childRuns.get(runId)!.attempt,
            childRuns.get(runId)!.conclusion,
          ),
    repository: REPOSITORY,
  };
}

async function withFastPolling<T>(run: () => Promise<T>, reconcileTimeoutMs?: string) {
  vi.stubEnv("OPENCLAW_FRV_POLL_MS", "1");
  if (reconcileTimeoutMs) {
    vi.stubEnv("OPENCLAW_FRV_RECONCILE_TIMEOUT_MS", reconcileTimeoutMs);
  }
  try {
    return await run();
  } finally {
    vi.unstubAllEnvs();
  }
}

type ScenarioState = [
  attempt: unknown,
  conclusion: string | null,
  status?: string,
  actor?: string,
  triggeringActor?: string,
  headSha?: string,
];

function rerunScenario(options: {
  childAfter?: ScenarioState[];
  childBefore?: ScenarioState[];
  childError?: Error;
  childSource?: ScenarioState;
  parentAfter?: ScenarioState[];
  parentBefore?: ScenarioState[];
  parentError?: Error;
  parentSource?: ScenarioState;
}) {
  const selected = child("normalCi", "101");
  const source = {
    child: options.childSource ?? [1, "failure"],
    parent: options.parentSource ?? [1, "success"],
  };
  const after = {
    child: options.childAfter ?? [[2, "success"]],
    parent: options.parentAfter ?? [[2, "success"]],
  };
  const mutated = { child: false, parent: false };
  const beforeReads = { child: 0, parent: 0 };
  const counters = {
    posts: { child: 0, parent: 0 },
    reads: { child: 0, parent: 0 },
    verifies: 0,
  };
  const stateAt = (states: ScenarioState[], index: number) =>
    states[Math.min(index, states.length - 1)]!;
  const makeRun = (target: "child" | "parent", state: ScenarioState) => {
    const [attempt, conclusion, status, actor, triggeringActor, headSha] = state;
    const validAttempt = typeof attempt === "number" && attempt > 0 ? attempt : 1;
    const base =
      target === "child"
        ? runFor(selected, validAttempt, conclusion, status)
        : rootRun(validAttempt, conclusion, status);
    return {
      ...base,
      actor: { login: actor ?? base.actor.login },
      run_attempt: attempt,
      ...(target === "child" && triggeringActor
        ? { triggering_actor: { login: triggeringActor } }
        : {}),
      ...(headSha ? { head_sha: headSha } : {}),
    };
  };
  const mutate = async (target: "child" | "parent", error?: Error) => {
    counters.posts[target] += 1;
    mutated[target] = true;
    if (error) {
      throw error;
    }
  };
  return {
    counters,
    selected,
    client: {
      ...preflightMethods([selected], () => makeRun("child", source.child)),
      getAttemptJobs: async (_runId: string, attempt: number) => [
        job("test", attempt === source.child[0] ? (source.child[1] ?? "failure") : "success"),
      ],
      getRun: async (runId: string) => {
        const target = runId === "77" ? "parent" : "child";
        const states = mutated[target]
          ? after[target]
          : target === "parent"
            ? (options.parentBefore ?? [source.parent])
            : (options.childBefore ?? [source.child]);
        const index = mutated[target] ? counters.reads[target]++ : beforeReads[target]++;
        return makeRun(target, stateAt(states, index));
      },
      repository: REPOSITORY,
      rerunFailed: () => mutate("child", options.childError),
      rerunParent: () => mutate("parent", options.parentError),
      verify: async () => {
        counters.verifies += 1;
        return "{}";
      },
    },
  };
}

describe("FRV immutable plan eligibility", () => {
  it("accepts current v2 all-group plans", async () => {
    await expect(
      loadPlan({ repository: REPOSITORY, runId: "77" }, async () => executionPlanArtifact()),
    ).resolves.toMatchObject({
      attemptEvidenceVersion: 2,
      parentRunId: "77",
      rerunGroup: "all",
    });
  });

  it("keeps historical plan verification but rejects it for continuation", async () => {
    const historical = historicalExecutionPlanArtifact();
    expect(validateReleaseExecutionPlanArtifact(historical)).not.toHaveProperty(
      "attemptEvidenceVersion",
    );
    await expect(
      loadPlan({ repository: REPOSITORY, runId: "77" }, async () => historical),
    ).rejects.toThrow("run predates attempt-aware immutable plans; run a fresh all-group FRV");
  });

  it("rejects missing plans and focused roots", async () => {
    await expect(
      loadPlan({ repository: REPOSITORY, runId: "77" }, async () => undefined),
    ).rejects.toThrow("run has no authenticated immutable FRV plan");
    const focused = structuredClone(executionPlanArtifact());
    focused.rerunGroup = "ci";
    focused.sha256 = releaseExecutionPlanSha256(focused);
    await expect(
      loadPlan({ repository: REPOSITORY, runId: "77" }, async () => focused),
    ).rejects.toThrow("FRV continuation requires an all-group root");
  });
});

describe("FRV continuation preflight", () => {
  it.each([
    "Prepare release npm artifacts / Prepare publishable npm package",
    "Prepare release Docker artifacts / Seal prepared Docker images",
  ])("rejects rerunning a parent that owns publication artifacts from %s", async (name) => {
    const selected = withoutChildRunIdentity(child("normalCi", "101"));
    const client = preflightMethods([selected], (entry) => runFor(entry, 1, "failure"));
    await expect(
      preflightContinuation(plan([selected]), "77", {
        ...client,
        getParentJobs: async () => [
          { name, run_attempt: 1, status: "completed", conclusion: "success" },
        ],
      }),
    ).rejects.toThrow("parent-owned publication artifacts");
  });
  it("rejects parent-owned candidate artifacts before any GitHub access", async () => {
    const selected = withoutChildRunIdentity(child("normalCi", "101"));
    const parentOwnedPlan = {
      ...plan([selected]),
      candidate: { producer: { runId: "77" } },
    };
    let reads = 0;
    let mutations = 0;
    const read = async () => {
      reads += 1;
      throw new Error("unexpected GitHub read");
    };
    const mutate = async () => {
      mutations += 1;
    };

    await expect(
      continueFailed(parentOwnedPlan, "77", {
        getAttemptJobs: read,
        getJobLog: read,
        getParentJobs: read,
        getRun: read,
        getRunAttempt: read,
        repository: REPOSITORY,
        rerunFailed: mutate,
        rerunParent: mutate,
        verify: mutate,
      }),
    ).rejects.toThrow(
      "parent-owned sealed candidate artifacts do not survive parent reruns; start a fresh all-group FRV",
    );
    expect(reads).toBe(0);
    expect(mutations).toBe(0);
  });

  it.each([
    ["candidate-free", undefined],
    ["externally produced", { producer: { runId: "88" } }],
  ])("allows %s plans through candidate ownership preflight", async (_label, candidate) => {
    const selected = child("normalCi", "101");
    await expect(
      preflightContinuation(
        { ...plan([selected]), candidate },
        "77",
        preflightMethods([selected], (entry) => runFor(entry, 1, "failure")),
      ),
    ).resolves.toMatchObject({ id: 77 });
  });

  it("rejects fail-fast roots before any rerun mutation", async () => {
    const selected = child("normalCi", "101");
    let mutations = 0;
    const client = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure"), {
        failFast: true,
      }),
      getAttemptJobs: async () => [job("test", "failure")],
      getRun: async () => runFor(selected, 1, "failure"),
      repository: REPOSITORY,
      rerunFailed: async () => {
        mutations += 1;
      },
      rerunParent: async () => {
        mutations += 1;
      },
      verify: async () => "{}",
    };
    await expect(continueFailed(plan([selected]), "77", client)).rejects.toThrow(
      "source full release root is not an exact fail-fast-disabled all-group target",
    );
    expect(mutations).toBe(0);
  });

  it("rejects parent provenance drift before mutation", async () => {
    const selected = child("normalCi", "101");
    let mutations = 0;
    const methods = preflightMethods([selected], (entry) => runFor(entry, 1, "failure"));
    await expect(
      continueFailed(plan([selected]), "77", {
        ...methods,
        getAttemptJobs: async () => [job("test", "failure")],
        getRun: async () => runFor(selected, 1, "failure"),
        getRunAttempt: async (runId: string) => {
          const run = await methods.getRunAttempt(runId);
          return runId === "77" ? { ...run, repository: { full_name: "someone/else" } } : run;
        },
        repository: REPOSITORY,
        rerunFailed: async () => {
          mutations += 1;
        },
      }),
    ).rejects.toThrow("source full release parent identity changed");
    expect(mutations).toBe(0);
  });

  it("rejects missing selected child identities before child reads or mutations", async () => {
    const first = withoutChildRunIdentity(child("pluginPrerelease", "202"));
    const second = withoutChildRunIdentity(child("normalCi", "101"));
    let downstreamReads = 0;
    let mutations = 0;
    const downstreamRead = async () => {
      downstreamReads += 1;
      throw new Error("unexpected downstream read");
    };
    const mutate = async () => {
      mutations += 1;
    };

    await expect(
      continueFailed(plan([first, second]), "77", {
        getAttemptJobs: downstreamRead,
        getJobLog: downstreamRead,
        getParentJobs: async () => [
          {
            conclusion: "success",
            id: 1,
            name: "Resolve target ref",
            run_attempt: 1,
            status: "completed",
          },
        ],
        getRun: downstreamRead,
        getRunAttempt: async () => rootRun(),
        repository: REPOSITORY,
        rerunFailed: mutate,
        rerunParent: mutate,
        verify: mutate,
      }),
    ).rejects.toThrow(
      "selected FRV children did not record exact run IDs and attempts: normalCi, pluginPrerelease; start a fresh all-group FRV",
    );
    expect(downstreamReads).toBe(0);
    expect(mutations).toBe(0);
  });

  it("requires every selected child to be emitted by its exact parent job", async () => {
    const selected = child("normalCi", "101");
    await expect(
      preflightContinuation(plan([selected]), "77", {
        ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure"), {
          childRunIdOverride: "999",
        }),
      }),
    ).rejects.toThrow("release child is not uniquely emitted by its parent job");
  });

  it("binds the normal CI dispatch scope to the plan's coverage policy", async () => {
    const selected = child("normalCi", "101");
    const stablePlan = { ...plan([selected]), coveragePolicy: "npm-stable-v1" };
    const methods = (scope: string) =>
      preflightMethods([selected], (entry) => runFor(entry, 1, "failure"), {
        ciReleaseScope: scope,
      });
    await expect(
      preflightContinuation(stablePlan, "77", methods("npm-stable")),
    ).resolves.toBeDefined();
    await expect(preflightContinuation(stablePlan, "77", methods("full"))).rejects.toThrow(
      "release normal CI dispatch scope differs from its coverage policy",
    );
  });
});

describe("FRV same-parent recovery", () => {
  it("reports missing selected children without reading nonexistent runs", async () => {
    const selected = child("normalCi", "101");
    const missing = withoutChildRunIdentity(child("pluginPrerelease", "202"));
    const runReads: string[] = [];
    const attemptReads: Array<[string, number]> = [];
    const result = await inspectContinuation(plan([selected, missing]), {
      getAttemptJobs: async (runId: string, attempt: number) => {
        attemptReads.push([runId, attempt]);
        return [job("test")];
      },
      getRun: async (runId: string) => {
        runReads.push(runId);
        return runFor(selected, 1, "success");
      },
      repository: REPOSITORY,
    });

    expect(runReads).toEqual(["101"]);
    expect(attemptReads).toEqual([["101", 1]]);
    expect(result.children).toEqual([
      expect.objectContaining({ key: "normalCi", status: "passed" }),
      {
        compositeJobsSha256: "",
        conclusion: "",
        effectiveRunAttempt: null,
        key: "pluginPrerelease",
        passed: false,
        plannedRunAttempt: null,
        runId: "",
        status: "missing",
        url: "",
      },
    ]);
    expect(result.active).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.missing).toEqual([result.children[1]]);
    expect(result.passed).toEqual([result.children[0]]);
  });

  it("reports the effective attempt and composite job evidence", async () => {
    const selected = child("normalCi", "101");
    const result = await inspectContinuation(plan([selected]), {
      getAttemptJobs: async (_runId: string, attempt: number) => [
        job("test", attempt === 1 ? "failure" : "success"),
      ],
      getRun: async () => runFor(selected, 2, "success"),
      repository: REPOSITORY,
    });
    expect(result.children[0]).toMatchObject({
      compositeJobsSha256: releaseCompositeJobsSha256({
        effectiveRunAttempt: 2,
        jobs: [
          {
            acceptedRunAttempt: 2,
            completedAt: "2026-08-22T00:01:00Z",
            conclusion: "success",
            name: "test",
            startedAt: "2026-08-22T00:00:00Z",
            status: "completed",
            url: "https://example.invalid/jobs/test",
          },
        ],
        plannedRunAttempt: 1,
      }),
      effectiveRunAttempt: 2,
      status: "passed",
    });
  });

  it("adopts an already-active newer child attempt without dispatching another rerun", async () => {
    const scenario = rerunScenario({
      childBefore: [
        [2, null],
        [2, "success"],
      ],
    });
    await withFastPolling(() =>
      expect(
        continueFailed(plan([scenario.selected]), "77", scenario.client),
      ).resolves.toMatchObject({ action: "reran-parent", finalRunId: "77" }),
    );
    expect(scenario.counters.posts.child).toBe(0);
  });

  it("reruns blocking children concurrently, preserves green and advisory children, then reruns the parent once", async () => {
    const first = child("normalCi", "101");
    const second = child("pluginPrerelease", "202");
    const green = child("releaseChecks", "303");
    const telegram = child("npmTelegram", "505");
    const selectedPlan = {
      ...plan([first, second, green, telegram]),
      candidate: { producer: { runId: "606" } },
      releaseProfile: "full",
    };
    const childRuns = new Map([
      ["101", { attempt: 1, conclusion: "failure" }],
      ["202", { attempt: 1, conclusion: "failure" }],
      ["303", { attempt: 1, conclusion: "success" }],
      ["505", { attempt: 1, conclusion: "failure" }],
    ]);
    const parent = { attempt: 1, conclusion: "failure" as string | null };
    const events: string[] = [];
    let parentReruns = 0;
    const controller = controllerClient(selectedPlan.children, childRuns, parent);
    const client = {
      ...controller,
      getParentJobs: async () => [
        ...(await controller.getParentJobs()),
        ...[
          "Prepare release npm artifacts",
          "Prepare release Docker artifacts",
          "Acquire full release candidate",
        ].map((name) => ({
          name,
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
        })),
      ],
      rerunFailed: async (runId: string) => {
        events.push(`child:${runId}`);
        childRuns.set(runId, { attempt: 2, conclusion: "success" });
        await Promise.resolve();
      },
      rerunParent: async () => {
        parentReruns += 1;
        events.push("parent");
        parent.attempt = 2;
        parent.conclusion = "success";
      },
      verify: async (
        _runId: string,
        _plan: Record<string, unknown>,
        _deadline?: number,
        attempts?: Record<string, number>,
      ) => {
        expect(attempts?.["505"]).toBe(1);
        events.push("verify");
        return "{}";
      },
    };
    const result = await continueFailed(selectedPlan, "77", client);
    expect(result).toMatchObject({ action: "reran-parent", finalRunId: "77" });
    expect(events.slice(0, 2).toSorted()).toEqual(["child:101", "child:202"]);
    expect(events).not.toContain("child:303");
    expect(events).not.toContain("child:505");
    expect(result.status.children).toContainEqual(
      expect.objectContaining({
        key: "npmTelegram",
        conclusion: "failure",
        passed: true,
        effectiveRunAttempt: 1,
      }),
    );
    expect(events.indexOf("parent")).toBeGreaterThan(events.indexOf("child:202"));
    expect(events.at(-1)).toBe("verify");
    expect(parentReruns).toBe(1);
  });

  it("does not rerun a parent that already seals the recovered child attempt", async () => {
    const selected = child("normalCi", "101");
    const childRuns = new Map([["101", { attempt: 1, conclusion: "failure" as string | null }]]);
    const parent = { attempt: 1, conclusion: "success" as string | null };
    const posts = { child: 0, parent: 0 };
    let sealedChildAttempt = 1;
    const client = {
      ...controllerClient([selected], childRuns, parent),
      rerunFailed: async () => {
        posts.child += 1;
        childRuns.set("101", { attempt: 2, conclusion: "success" });
      },
      rerunParent: async () => {
        posts.parent += 1;
        parent.attempt += 1;
        parent.conclusion = "success";
        sealedChildAttempt = childRuns.get("101")!.attempt;
      },
      verifySeal: async (
        _runId: string,
        _plan: Record<string, unknown>,
        _deadline: number,
        attempts: Record<string, number>,
      ) => attempts["101"] === sealedChildAttempt,
      verify: async (
        _runId: string,
        _plan: Record<string, unknown>,
        _deadline?: number,
        attempts?: Record<string, number>,
      ) => {
        expect(attempts?.["101"]).toBe(sealedChildAttempt);
        return "{}";
      },
    };

    await expect(continueFailed(plan([selected]), "77", client)).resolves.toMatchObject({
      action: "reran-parent",
    });
    await expect(continueFailed(plan([selected]), "77", client)).resolves.toMatchObject({
      action: "verified-parent",
    });
    expect(posts).toEqual({ child: 1, parent: 1 });
  });

  it.each(["child", "parent"])("reconciles a write-once %s rerun", async (target) => {
    const transportError = Object.assign(new Error("read ECONNRESET after dispatch"), {
      code: "ECONNRESET",
    });
    const scenario = rerunScenario(
      target === "child"
        ? {
            childAfter: [
              [1, null, "queued"],
              [1, null, undefined, undefined, "release-operator"],
              [2, "success"],
            ],
            childError: transportError,
          }
        : {
            childSource: [1, "success"],
            parentAfter: [
              [1, null, "queued"],
              [1, null],
              [2, "success"],
            ],
            parentError: transportError,
            parentSource: [1, "failure"],
          },
    );
    await withFastPolling(() =>
      expect(
        continueFailed(plan([scenario.selected]), "77", scenario.client),
      ).resolves.toMatchObject({ action: "reran-parent" }),
    );
    expect(
      target === "child" ? scenario.counters.posts.child : scenario.counters.posts.parent,
    ).toBe(1);
    expect(scenario.counters.verifies).toBe(1);
  });

  it("keeps the reconciliation timeout when no newer attempt appears", async () => {
    const scenario = rerunScenario({
      childAfter: [[1, "failure"]],
      childError: new Error("HTTP 502 after dispatch"),
    });
    await withFastPolling(
      () =>
        expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
          "rerun mutation did not produce an observable newer attempt for 101 (101: HTTP 502 after dispatch)",
        ),
      "5",
    );
    expect(scenario.counters.posts.child).toBe(1);
  });

  it("keeps exact-terminal parent admission before dispatch", async () => {
    const scenario = rerunScenario({
      childSource: [1, "success"],
      parentBefore: [
        [1, "failure"],
        [2, null],
      ],
      parentSource: [1, "failure"],
    });
    await expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
      "rerun source 77 is no longer the exact terminal run",
    );
    expect(scenario.counters.posts.parent).toBe(0);
  });

  it("binds mutation reconciliation to the original actor", async () => {
    const scenario = rerunScenario({
      childAfter: [[2, "success", undefined, "other-actor"]],
    });
    await expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
      "rerun source 101 changed during mutation reconciliation",
    );
  });

  it.each([
    ["missing", 1, undefined, "101 run attempt must be a positive integer"],
    ["zero", 1, 0, "101 run attempt must be a positive integer"],
    ["regressed", 2, 1, "rerun source 101 attempt regressed"],
    ["skipped", 1, 3, "controller-owned run 101 advanced past attempt 2"],
  ])("rejects a %s child attempt", async (_label, sourceAttempt, observedAttempt, error) => {
    const scenario = rerunScenario({
      childAfter: [[observedAttempt, "success"]],
      childSource: [sourceAttempt, "failure"],
    });
    await expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
      error,
    );
  });

  it.each([
    ["child", "HTTP 403: workflow rerun forbidden"],
    ["parent", "HTTP 422: workflow rerun rejected"],
  ])("does not poll after a hard %s mutation failure", async (target, error) => {
    const scenario = rerunScenario(
      target === "child"
        ? { childError: new Error(error) }
        : {
            childSource: [1, "success"],
            parentError: new Error(error),
            parentSource: [1, "failure"],
          },
    );
    await expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
      error,
    );
    expect(
      target === "child" ? scenario.counters.reads.child : scenario.counters.reads.parent,
    ).toBe(0);
  });

  it("reconciles an ambiguous peer before surfacing a hard child mutation failure", async () => {
    const first = child("normalCi", "101");
    const second = child("pluginPrerelease", "202");
    const childRuns = new Map([
      ["101", { attempt: 1, conclusion: "failure" }],
      ["202", { attempt: 1, conclusion: "failure" }],
    ]);
    const parent = { attempt: 1, conclusion: "success" as string | null };
    const base = controllerClient([first, second], childRuns, parent);
    const calls: string[] = [];
    let dispatched = false;
    let hardRunReads = 0;
    const client = {
      ...base,
      getRun: async (runId: string) => {
        if (dispatched && runId === "202") {
          hardRunReads += 1;
        }
        return base.getRun(runId);
      },
      rerunFailed: async (runId: string) => {
        dispatched = true;
        calls.push(runId);
        if (runId === "101") {
          childRuns.set(runId, { attempt: 2, conclusion: "success" });
          throw new Error("HTTP 502 after dispatch");
        }
        throw new Error("HTTP 403: workflow rerun forbidden");
      },
      rerunParent: async () => {},
      verify: async () => "{}",
    };
    await expect(continueFailed(plan([first, second]), "77", client)).rejects.toThrow("HTTP 403");
    expect(calls.toSorted()).toEqual(["101", "202"]);
    expect(hardRunReads).toBe(0);
  });

  it.each([
    ["child", "101"],
    ["parent", "77"],
  ])("rejects %s attempt advancement before verification", async (target, targetRunId) => {
    const advancingStates = [
      [2, null],
      [2, "success"],
      [3, "success"],
    ] satisfies ScenarioState[];
    const scenario = rerunScenario(
      target === "child"
        ? { childAfter: advancingStates }
        : {
            childSource: [1, "success"],
            parentAfter: advancingStates,
            parentSource: [1, "failure"],
          },
    );
    await expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
      `controller-owned run ${targetRunId} advanced past attempt 2`,
    );
    expect(scenario.counters.verifies).toBe(0);
  });

  it("freezes every selected and reused parent attempt for final verification", async () => {
    const scenario = rerunScenario({ childSource: [1, "success"] });
    const reusedPlan = validateReleaseExecutionPlanArtifact(
      executionPlanArtifact({
        children: [scenario.selected],
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: TARGET_SHA,
          policy: "exact-target-full-validation-v1",
          requested: true,
          rootRunId: "88",
          runUrl: `https://github.com/${REPOSITORY}/actions/runs/88`,
          selectedRunId: "88",
          sourceManifest: { runAttempt: 3, runId: "88", targetSha: TARGET_SHA },
        },
      }),
    );
    const getRun = scenario.client.getRun;
    let expectedRunAttempts: Record<string, number> | undefined;
    const client = {
      ...scenario.client,
      getRun: async (runId: string) => {
        if (runId === "88") {
          return { ...rootRun(3, "success"), id: Number(runId) };
        }
        return getRun(runId);
      },
      verify: async (
        _runId: string,
        _plan: Record<string, unknown>,
        _deadline?: number,
        attempts?: Record<string, number>,
      ) => {
        expectedRunAttempts = attempts;
        return "{}";
      },
    };

    await expect(continueFailed(reusedPlan, "77", client)).resolves.toMatchObject({
      action: "verified-parent",
    });
    expect(expectedRunAttempts).toEqual({ "77": 1, "88": 3, "101": 1 });
  });

  it("fails closed without another POST when provenance changes during reconciliation", async () => {
    const scenario = rerunScenario({
      childAfter: [[1, "failure", undefined, undefined, undefined, "f".repeat(40)]],
      childError: new Error("HTTP 502 before dispatch"),
    });
    await withFastPolling(() =>
      expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
        "rerun source 101 changed during mutation reconciliation",
      ),
    );
    expect(scenario.counters.posts.child).toBe(1);
  });

  it("keeps dry-run recovery mutation-free", async () => {
    const selected = child("normalCi", "101");
    let mutations = 0;
    const client = {
      ...controllerClient([selected], new Map([["101", { attempt: 1, conclusion: "failure" }]]), {
        attempt: 1,
        conclusion: "failure",
      }),
      rerunFailed: async () => {
        mutations += 1;
      },
      rerunParent: async () => {
        mutations += 1;
      },
      verify: async () => {
        mutations += 1;
      },
    };
    await expect(
      continueFailed(plan([selected]), "77", client, { dryRun: true }),
    ).resolves.toMatchObject({ action: "would-rerun" });
    expect(mutations).toBe(0);
  });
});

describe("FRV rerun API", () => {
  it("uses the direct failed-jobs and parent rerun endpoints", async () => {
    const calls: string[][] = [];
    const client = createClient(REPOSITORY, {
      mutate: async (args: string[]) => {
        calls.push(args);
      },
    });
    await client.rerunFailed("101");
    await client.rerunParent("77");
    expect(calls).toEqual([
      ["api", "-X", "POST", `repos/${REPOSITORY}/actions/runs/101/rerun-failed-jobs`],
      ["api", "-X", "POST", `repos/${REPOSITORY}/actions/runs/77/rerun`],
    ]);
  });
});

describe("FRV strict verifier", () => {
  it("uses the immutable trusted workflow identity and remaining operation budget", async () => {
    let args: string[] = [];
    let timeoutMs = 0;
    const client = createClient(REPOSITORY, {
      execCommand: async (
        _command: string,
        commandArgs: string[],
        options: { timeoutMs: number },
      ) => {
        args = commandArgs;
        timeoutMs = options.timeoutMs;
        return "{}";
      },
    });
    await expect(
      client.verify("77", executionPlanArtifact(), Date.now() + 30_000, {
        "77": 2,
        "101": 2,
      }),
    ).resolves.toBe("{}");
    expect(args).toEqual(
      expect.arrayContaining([
        "--validate-run",
        "77",
        "--expected-run-attempts-json",
        '{"77":2,"101":2}',
        "--trusted-workflow-sha",
        SHA,
        "--verifier-source-sha",
        SHA,
      ]),
    );
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it("rejects an expired verification budget before spawning the verifier", async () => {
    let spawns = 0;
    const client = createClient(REPOSITORY, {
      execCommand: async () => {
        spawns += 1;
        return "{}";
      },
    });
    await expect(client.verify("77", executionPlanArtifact(), Date.now() - 1)).rejects.toThrow(
      "FRV verification timed out",
    );
    expect(spawns).toBe(0);
  });

  it("treats only typed verifier refresh failures as rerunnable", async () => {
    let refreshable = true;
    const client = createClient(REPOSITORY, {
      execCommand: async () => {
        throw Object.assign(new Error("verification failed"), {
          stdout: JSON.stringify({
            error: refreshable ? "parent evidence is stale" : "producer identity is invalid",
            ...(refreshable ? { refreshable: true } : {}),
            valid: false,
          }),
        });
      },
    });
    const attempts = { "77": 2, "101": 2 };

    await expect(
      client.verifySeal("77", executionPlanArtifact(), Date.now() + 30_000, attempts),
    ).resolves.toBe(false);

    refreshable = false;
    await expect(
      client.verifySeal("77", executionPlanArtifact(), Date.now() + 30_000, attempts),
    ).rejects.toThrow("verification failed");
  });
});

describe("FRV protected gh evidence reads", () => {
  const jobLogArgs = [
    "api",
    `repos/${REPOSITORY}/actions/jobs/1/logs`,
    "-H",
    "Cache-Control: max-age=0",
  ];

  it.each([
    ["getRun", ["101"], "actions/runs/101", { run_attempt: 2 }],
    ["getRunAttempt", ["101", 2], "actions/runs/101/attempts/2", { run_attempt: 2 }],
    [
      "getAttemptJobs",
      ["101", 2],
      "actions/runs/101/attempts/2/jobs?per_page=100",
      [{ id: 1 }, { id: 2 }],
    ],
    [
      "getParentJobs",
      ["77"],
      "actions/runs/77/jobs?filter=all&per_page=100",
      [{ id: 1 }, { id: 2 }],
    ],
    ["getJobLog", [1], "actions/jobs/1/logs", "job evidence"],
  ])("revalidates %s through the default protected route", (method, args, endpoint, expected) => {
    const result = runProtectedFrv(method, args as Array<string | number>, endpoint);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(result.calls).toHaveLength(1);
  });

  it("falls back once when gh does not support the escape-sequence flag", () => {
    const result = runProtectedFrv("getJobLog", [1], "actions/jobs/1/logs", "legacy-flag");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBe("job evidence");
    expect(result.calls).toEqual([[...jobLogArgs, "--allow-escape-sequences"], jobLogArgs]);
  });

  it("does not fall back after an unrelated job-log error", () => {
    const result = runProtectedFrv("getJobLog", [1], "actions/jobs/1/logs", "unrelated");
    expect(result.status).toBe(23);
    expect(result.stderr).toContain("unrelated log failure");
    expect(result.calls).toEqual([[...jobLogArgs, "--allow-escape-sequences"]]);
  });

  it("preserves protected refusal status without retry or alternate execution", () => {
    const result = runProtectedFrv("getRun", ["101"], "actions/runs/101", "protected");
    expect(result.status).toBe(19);
    expect(result.stderr).toContain("protected refusal");
    expect(result.calls).toHaveLength(1);
  });
});

function runProtectedFrv(
  method: string,
  args: Array<string | number>,
  endpoint: string,
  failure: "none" | "legacy-flag" | "protected" | "unrelated" = "none",
) {
  const root = mkdtempSync(join(tmpdir(), "frv-protected-"));
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
const fail = (message, code) => { console.error(message); process.exit(code); };
const failure = ${JSON.stringify(failure)};
if (failure === "protected") fail("protected refusal", 19);
if (args[0] !== "api" || !args.includes(${JSON.stringify(`repos/${REPOSITORY}/${endpoint}`)})) fail("unexpected request", 17);
if (!args.some((arg, i) => ["-H", "--header"].includes(arg) && args[i+1] === "Cache-Control: max-age=0")) fail("missing live header", 18);
if (${endpoint.endsWith("/logs")} && failure === "legacy-flag" && args.includes("--allow-escape-sequences")) fail("unknown flag: --allow-escape-sequences", 1);
if (${endpoint.endsWith("/logs")} && failure === "unrelated") fail("unrelated log failure", 23);
if (${endpoint.endsWith("/logs")} && failure === "none" && !args.includes("--allow-escape-sequences")) fail("missing escape-sequence flag", 20);
if (${endpoint.includes("/jobs?")}) {
  if (!args.includes("--paginate") || !args.includes(".jobs[] | @json")) fail("missing pagination", 17);
  console.log('{"id":1}\\n{"id":2}');
} else console.log(${endpoint.endsWith("/logs") ? JSON.stringify("job evidence") : JSON.stringify('{"run_attempt":2}')});
`,
  );
  chmodSync(gh, 0o755);
  try {
    const moduleUrl = pathToFileURL(join(process.cwd(), "scripts/frv.mjs")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {createClient} from ${JSON.stringify(moduleUrl)};
      try {
        console.log(JSON.stringify(await createClient(${JSON.stringify(REPOSITORY)})[${JSON.stringify(method)}](...${JSON.stringify(args)})));
      } catch (error) { console.error(error.message); process.exitCode = error.code; }
    `,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { HOME: root, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
      },
    );
    return {
      ...result,
      calls: readFileSync(join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PUBLISH_SHA = "c".repeat(40);
const PUBLISH_REF = `release-publish/${PUBLISH_SHA.slice(0, 12)}-88`;
const DIAGNOSTIC_FILE = "release-postpublish-diagnostics.json";
const PUBLISH_PATH = ".github/workflows/openclaw-release-publish.yml";
const FRV_PATH = ".github/workflows/full-release-validation.yml";

function publicationFixture() {
  const executionPlan = executionPlanArtifact();
  const publisher = {
    ...rootRun(),
    id: 88,
    workflow_id: 800,
    path: `${PUBLISH_PATH}@refs/tags/${PUBLISH_REF}`,
    head_branch: PUBLISH_REF,
    head_sha: PUBLISH_SHA,
    repository: { full_name: REPOSITORY },
  };
  const root = {
    ...rootRun(2, "success"),
    id: 77,
    workflow_id: 700,
    path: `${FRV_PATH}@${SOURCE_REF}`,
    head_branch: SOURCE_REF,
    head_sha: SHA,
    repository: { full_name: REPOSITORY },
  };
  const manifest = {
    version: 3,
    workflowName: "Full Release Validation",
    runId: "77",
    runAttempt: "2",
    workflowRef: SOURCE_REF,
    workflowFullRef: `refs/heads/${SOURCE_REF}`,
    workflowRefType: "branch",
    workflowSha: SHA,
    targetSha: TARGET_SHA,
    releaseProfile: "beta",
    rerunGroup: "all",
    runReleaseSoak: "false",
    controls: { performanceReportPublication: "artifact-only" },
    validationInputs: {},
    candidateBinding: null,
    executionPlanSha256: executionPlan.sha256,
    sourceParentRunAttempt: 1,
    childRuns: {
      normalCi: "101",
      npmTelegram: "",
      pluginPrerelease: "202",
      releaseChecks: "303",
      productPerformance: { runId: "404" },
    },
  };
  const stage = (state = "unattempted", publication = "unknown") => ({
    state,
    publication,
    error: null,
    packages: [],
    packagesTruncated: false,
  });
  const diagnostic = {
    schemaVersion: 1,
    kind: "release-postpublish-diagnostics",
    invocationId: "12345678-1234-4234-8234-123456789abc",
    context: {
      repository: REPOSITORY,
      releaseVersion: "2026.9.9",
      releaseTag: "v2026.9.9",
      npmDistTag: "latest",
      requestedSourceSha: TARGET_SHA,
      toolingSha: PUBLISH_SHA,
      suppliedToolingSha: PUBLISH_SHA,
      suppliedToolingRef: `refs/tags/${PUBLISH_REF}`,
      parentRunId: "88",
      parentRunAttempt: "1",
      validationEvidence: { mode: "full-release-validation", runId: "77", runAttempt: "2" },
    },
    selection: {
      plugins: [],
      pluginsTruncated: false,
      workflowRef: PUBLISH_REF,
      clawHubWorkflowRef: PUBLISH_REF,
    },
    verification: "failure",
    currentStage: "pluginNpm",
    stages: {
      checkout: stage("success"),
      githubRelease: stage("skipped"),
      coreNpm: stage("success", "observed"),
      postpublish: stage("success"),
      pluginNpm: stage("failure"),
      clawHub: stage(),
      fullReleaseValidation: stage(),
      pluginNpmRun: stage(),
      pluginClawHubRun: stage(),
      pluginClawHubBootstrap: stage("skipped"),
      openclawNpm: stage(),
      npmTelegram: stage("skipped"),
      evidence: stage(),
      binding: stage(),
      assets: stage(),
    },
    children: Object.fromEntries(
      [
        "fullReleaseValidation",
        "openclawNpm",
        "pluginNpm",
        "pluginClawHub",
        "pluginClawHubBootstrap",
        "npmTelegram",
      ].map((name) => [
        name,
        {
          suppliedRunId: null,
          runAttempt: null,
          producerRunAttempt: null,
          status: "unknown",
          conclusion: "unknown",
          failedJobCount: null,
          readbackArtifactId: null,
          packageArtifactId: null,
        },
      ]),
    ),
    jobOutcomeBeforeArtifactUploads: "failure",
    stepOutcomes: { coreStart: "success", completion: "failure" },
  };
  const publisherJobs = [
    {
      ...job("Publish plugins, then OpenClaw", "failure"),
      id: 8801,
      run_id: 88,
      run_attempt: 1,
      steps: [
        {
          number: 1,
          name: "Upload postpublish diagnostics",
          status: "completed",
          conclusion: "success",
        },
      ],
    },
  ];
  return { executionPlan, manifest, diagnostic, publisher, root, publisherJobs };
}

async function runPublicationCli(
  fixture = publicationFixture(),
  args = ["status", "--run", "77", "--publication-run", "88", "--json"],
  amend: (
    responses: Record<string, unknown>,
    addArtifact: (
      id: number,
      run: typeof fixture.root,
      name: string,
      filename: string,
      value: unknown,
      zipChange?: (zip: JSZip) => void,
    ) => Promise<void>,
  ) => void | Promise<void> = () => {},
  explicitBinary = false,
  clockStep = 0,
) {
  const directory = mkdtempSync(join(tmpdir(), "frv-publication-"));
  const legacy = !args.includes("--publication-run");
  const responses: Record<string, unknown> = {};
  const endpoint = (path: string) => `repos/${REPOSITORY}/${path}`;
  const artifactLists = new Map<number, unknown[]>();
  async function artifact(
    id: number,
    run: typeof fixture.root,
    name: string,
    filename: string,
    value: unknown,
    zipChange?: (zip: JSZip) => void,
  ) {
    const zip = new JSZip();
    zip.file(filename, JSON.stringify(value), { unixPermissions: 0o100644 });
    zipChange?.(zip);
    const bytes = await zip.generateAsync({
      type: "nodebuffer",
      platform: "UNIX",
      compression: "DEFLATE",
    });
    const metadata = {
      id,
      name,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size_in_bytes: bytes.length,
      expired: false,
      expires_at: "2099-01-01T00:00:00Z",
      workflow_run: { id: run.id, head_sha: run.head_sha },
    };
    responses[endpoint(`actions/artifacts/${id}`)] = metadata;
    responses[endpoint(`actions/artifacts/${id}/zip`)] = { binary: bytes.toString("base64") };
    const artifacts = [
      ...(artifactLists.get(run.id) ?? []).filter((item) => (item as { id: number }).id !== id),
      metadata,
    ];
    artifactLists.set(run.id, artifacts);
    responses[endpoint(`actions/runs/${run.id}/artifacts?per_page=100&page=1`)] = {
      total_count: artifacts.length,
      artifacts,
    };
  }
  await artifact(
    1,
    fixture.root,
    "full-release-execution-plan-77",
    "full-release-execution-plan.json",
    fixture.executionPlan,
  );
  await artifact(
    2,
    fixture.root,
    "full-release-validation-77-2",
    "full-release-validation-manifest.json",
    fixture.manifest,
  );
  await artifact(
    3,
    fixture.publisher,
    "openclaw-release-postpublish-diagnostics-88-1",
    DIAGNOSTIC_FILE,
    fixture.diagnostic,
  );
  for (const run of [fixture.root, fixture.publisher]) {
    responses[endpoint(`actions/runs/${run.id}`)] = run;
    responses[endpoint(`actions/runs/${run.id}/attempts/${run.run_attempt}`)] = run;
    responses[endpoint(`actions/workflows/${run.workflow_id}`)] = {
      id: run.workflow_id,
      path: run.id === 77 ? FRV_PATH : PUBLISH_PATH,
    };
    const artifacts = artifactLists.get(run.id) ?? [];
    responses[endpoint(`actions/runs/${run.id}/artifacts?per_page=100&page=1`)] = {
      total_count: artifacts.length,
      artifacts,
    };
  }
  responses[endpoint("actions/runs/88/attempts/1/jobs?per_page=100&page=1")] = {
    total_count: fixture.publisherJobs.length,
    jobs: fixture.publisherJobs,
  };
  for (const entry of requiredChildren()) {
    const run = { ...runFor(entry, 1, "success"), workflow_id: Number(entry.runId) + 1000 };
    responses[endpoint(`actions/runs/${entry.runId}`)] = run;
    responses[endpoint(`actions/workflows/${run.workflow_id}`)] = {
      id: run.workflow_id,
      path: run.path,
    };
    responses[endpoint(`actions/runs/${entry.runId}/attempts/1/jobs?per_page=100&page=1`)] = {
      total_count: 1,
      jobs: [{ ...job("test"), id: Number(entry.runId) * 10, run_id: run.id, run_attempt: 1 }],
    };
  }
  await amend(responses, artifact);
  writeFileSync(join(directory, "responses.json"), JSON.stringify(responses));
  writeFileSync(join(directory, "legacy-plan.json"), JSON.stringify(fixture.executionPlan));
  writeFileSync(
    join(directory, "no-network.mjs"),
    `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
globalThis.fetch = () => { throw new Error('unplanned Node fetch'); };
for (const name of ["execFileSync", "execFile", "spawn", "spawnSync"]) {
  const original = childProcess[name];
  const guarded = (method) => (command, ...args) => {
    if (command !== "gh" && command !== ${JSON.stringify(join(directory, "gh"))}) throw new Error("unplanned executable");
    return method(command, ...args);
  };
  childProcess[name] = guarded(original);
  const custom = Symbol.for("nodejs.util.promisify.custom");
  if (original[custom]) childProcess[name][custom] = guarded(original[custom]);
}
syncBuiltinESMExports();
${clockStep ? `let ticks = 0; const now = Date.now(); Date.now = () => now + ticks++ * ${clockStep};` : ""}
`,
  );
  const gh = join(directory, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
const reject = () => { console.error("unplanned or mutating request"); process.exit(23); };
const legacy = ${legacy};
if (legacy && args[0] === "run" && args[1] === "download" && args[2] === "77" && args[args.indexOf("--name") + 1] === "full-release-execution-plan-77") {
  fs.copyFileSync("legacy-plan.json", require("node:path").join(args[args.indexOf("--dir") + 1], "full-release-execution-plan.json"));
  process.exit(0);
}
if (args[0] !== "api" || (!legacy && (!args.includes("GET") || !args.includes("github.com"))) || !args.includes("Cache-Control: max-age=0")) reject();
if (args.includes("--include") || (!legacy && args.includes("--paginate"))) reject();
let path = args.find(a => a.startsWith("repos/"));
if (legacy && path.endsWith("/jobs?per_page=100")) path += "&page=1";
const table = JSON.parse(fs.readFileSync("responses.json", "utf8"));
if (!Object.hasOwn(table, path)) reject();
let value = table[path];
if (value.sequence) {
  const reads = fs.readFileSync("calls.jsonl", "utf8").trim().split("\\n").map(JSON.parse).filter(a => a.includes(path)).length;
  value = value.sequence[Math.min(reads - 1, value.sequence.length - 1)];
}
if (value.failure) { console.error(value.failure); process.exit(1); }
if (legacy && value.jobs) process.stdout.write(value.jobs.map(job => JSON.stringify(job)).join("\\n"));
else if (value.binary) process.stdout.write(Buffer.from(value.binary, "base64"));
else if (value.raw) process.stdout.write(value.raw);
else process.stdout.write(JSON.stringify(value));
`,
  );
  chmodSync(gh, 0o755);
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        join(directory, "no-network.mjs"),
        join(process.cwd(), "scripts/frv.mjs"),
        ...args,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          HOME: directory,
          PATH: directory,
          ...(explicitBinary ? { OPENCLAW_GH_BIN: gh, GH_TOKEN: "synthetic-fixture-token" } : {}),
        },
      },
    );
    let calls: string[][] = [];
    try {
      calls = readFileSync(join(directory, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      // Usage rejection must happen before the first CLI read.
    }
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("publication status real CLI", () => {
  it("joins a failed publisher to selected validation attempt two without erasing known readback", async () => {
    const fixture = publicationFixture();
    validateParentManifest(fixture.manifest, {
      runId: "77",
      runAttempt: 2,
      workflowRef: SOURCE_REF,
      workflowSha: SHA,
    });
    const result = await runPublicationCli(fixture);
    expect(
      result.status,
      `${result.stderr}\n${JSON.stringify(JSON.parse(result.stdout).publication.relationship)}\n${JSON.stringify(JSON.parse(result.stdout).publication.collection)}`,
    ).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.publication.relationship).toMatchObject({
      status: "verified",
      originalPlanAttempt: 1,
      validationAttempt: 2,
    });
    expect(value.publication.publisher).toMatchObject({
      runId: "88",
      runAttempt: 1,
      conclusion: "failure",
    });
    expect(value.publication.surfaces.coreNpm.verification.state).toBe("success");
    expect(value.publication.surfaces.pluginNpm.verification.state).toBe("failure");
    expect(value.publication.surfaces.activation.operation.state).toBe("unknown");
    expect(value.children).toHaveLength(4);
    expect(result.calls.length).toBeGreaterThan(0);
  });

  it.each([
    ["status", "--run", "77", "--publication-run"],
    ["status", "--run", "77", "--publication-run", "0"],
    ["status", "--run", "77", "--publication-run", "9007199254740992"],
    ["status", "--run", "77", "--publication-run", "88", "--publication-run", "89"],
    ["status", "--run", "77", "--run", "78", "--publication-run", "88"],
    ["status", "--run", "77", "--publication-run", "88", "--repo", "../private"],
    ["continue", "--failed", "--run", "77", "--publication-run", "88"],
    ["verify", "--run", "77", "--publication-run", "88"],
  ])("rejects invalid selectors before any read: %j", async (...args) => {
    const result = await runPublicationCli(publicationFixture(), args);
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("publication observation: usage");
  });

  it("uses the selected explicit binary without Node fetch and keeps the text section separate", async () => {
    const result = await runPublicationCli(
      publicationFixture(),
      ["status", "--run", "77", "--publication-run", "88"],
      undefined,
      true,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Publication observation (not release authorization)");
    expect(result.stdout).toContain("selected-attempt=2");
    expect(result.stdout).toContain(
      "pluginNpm: selection=unknown operation=unknown verification=failure",
    );
    expect(result.calls.every((call) => call[0] === "api" && call.includes("GET"))).toBe(true);
    expect(result.stdout + result.stderr).not.toContain("synthetic-fixture-token");
  });

  it.each([
    [
      "foreign repository",
      (fixture: ReturnType<typeof publicationFixture>) => {
        fixture.publisher.repository.full_name = "other/repository";
      },
    ],
    [
      "foreign event",
      (fixture) => {
        fixture.publisher.event = "push";
      },
    ],
    [
      "foreign path",
      (fixture) => {
        fixture.publisher.path = ".github/workflows/other.yml";
      },
    ],
    [
      "foreign path suffix",
      (fixture) => {
        fixture.publisher.path = `${PUBLISH_PATH}@main`;
      },
    ],
    [
      "wrong producer run",
      (fixture) => {
        fixture.diagnostic.context.parentRunId = "89";
      },
    ],
    [
      "wrong producer attempt",
      (fixture) => {
        fixture.diagnostic.context.parentRunAttempt = "2";
      },
    ],
    [
      "wrong tooling",
      (fixture) => {
        fixture.diagnostic.context.toolingSha = SHA;
      },
    ],
    [
      "wrong full ref",
      (fixture) => {
        fixture.diagnostic.context.suppliedToolingRef = "refs/heads/main";
      },
    ],
    [
      "wrong validation root",
      (fixture) => {
        fixture.diagnostic.context.validationEvidence.runId = "78";
      },
    ],
    [
      "future validation attempt",
      (fixture) => {
        fixture.diagnostic.context.validationEvidence.runAttempt = "3";
      },
    ],
    [
      "wrong candidate",
      (fixture) => {
        fixture.diagnostic.context.requestedSourceSha = PUBLISH_SHA;
      },
    ],
    [
      "wrong source attempt",
      (fixture) => {
        fixture.manifest.sourceParentRunAttempt = 2;
      },
    ],
    [
      "wrong plan checksum",
      (fixture) => {
        fixture.manifest.executionPlanSha256 = "0".repeat(64);
      },
    ],
    [
      "wrong manifest tooling",
      (fixture) => {
        fixture.manifest.workflowSha = PUBLISH_SHA;
      },
    ],
    [
      "unsuccessful upload",
      (fixture) => {
        fixture.publisherJobs[0]!.steps[0]!.conclusion = "failure";
      },
    ],
  ] satisfies [string, (fixture: ReturnType<typeof publicationFixture>) => void][])(
    "refuses %s",
    async (_name, mutate) => {
      const fixture = publicationFixture();
      mutate(fixture);
      const result = await runPublicationCli(fixture);
      expect(result.status, result.stdout).toBe(1);
      expect(JSON.parse(result.stdout).publication.collection.complete).toBe(false);
      expect(result.calls.every((call) => call[0] === "api" && call.includes("GET"))).toBe(true);
    },
  );

  it.each([
    "workflow-id",
    "artifact-digest",
    "artifact-size",
    "artifact-producer",
    "duplicate-name",
    "duplicate-id",
    "count-gap",
    "attempt-limit",
  ])("rejects independently observed %s", async (kind) => {
    const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
      const prefix = `repos/${REPOSITORY}/actions/`;
      const metadata = responses[`${prefix}artifacts/3`] as Record<string, unknown>;
      const list = responses[`${prefix}runs/88/artifacts?per_page=100&page=1`] as {
        total_count: number;
        artifacts: unknown[];
      };
      if (kind === "workflow-id") {
        Object.assign(responses[`${prefix}workflows/800`] as object, { id: 801 });
      }
      if (kind === "artifact-digest") {
        metadata.digest = `sha256:${"0".repeat(64)}`;
      }
      if (kind === "artifact-size") {
        metadata.size_in_bytes = 2 * 1024 * 1024 + 1;
      }
      if (kind === "artifact-producer") {
        metadata.workflow_run = { id: 89, head_sha: PUBLISH_SHA };
      }
      if (kind === "duplicate-name") {
        list.artifacts.push({ ...metadata, id: 33 });
        list.total_count++;
      }
      if (kind === "duplicate-id") {
        list.artifacts.push(metadata);
        list.total_count++;
      }
      if (kind === "count-gap") {
        list.total_count++;
      }
      if (kind === "attempt-limit") {
        Object.assign(responses[`${prefix}runs/101`] as object, { run_attempt: 100000000 });
      }
    });
    expect(result.status, result.stdout).toBe(1);
    expect(JSON.parse(result.stdout).publication.collection.complete).toBe(false);
  });

  it.each(["88", "77", "101"])(
    "refuses advancing run %s without restarting observation",
    async (runId) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const path = `repos/${REPOSITORY}/actions/runs/${runId}`;
        const before = responses[path] as { run_attempt: number };
        responses[path] = {
          sequence: [before, { ...before, run_attempt: before.run_attempt + 1 }],
        };
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).publication.collection.error).toBe("attempt-changed");
      expect(
        result.calls.filter((call) => call.includes(`repos/${REPOSITORY}/actions/runs/${runId}`)),
      ).toHaveLength(2);
    },
  );

  it.each(["missing", "expired", "legacy-only", "unsupported", "incomplete-link"])(
    "keeps authenticated historical %s unknown, not failed publication",
    async (kind) => {
      const fixture = publicationFixture();
      if (kind === "unsupported") {
        fixture.diagnostic.schemaVersion = 2;
      }
      if (kind === "incomplete-link") {
        Reflect.set(fixture.diagnostic.context.validationEvidence, "runAttempt", null);
      }
      const result = await runPublicationCli(fixture, undefined, (responses) => {
        const listPath = `repos/${REPOSITORY}/actions/runs/88/artifacts?per_page=100&page=1`;
        if (kind === "missing") {
          responses[listPath] = { total_count: 0, artifacts: [] };
        }
        if (kind === "legacy-only") {
          responses[listPath] = {
            total_count: 1,
            artifacts: [{ id: 99, name: "openclaw-release-postpublish-evidence-v2026.9.9" }],
          };
        }
        if (kind === "expired") {
          Object.assign(responses[`repos/${REPOSITORY}/actions/artifacts/3`] as object, {
            expired: true,
          });
        }
      });
      expect(result.status, result.stdout).toBe(0);
      const publication = JSON.parse(result.stdout).publication;
      expect(publication.collection.complete).toBe(true);
      expect(publication.relationship.status).toBe("unverified");
      expect(publication.surfaces.coreNpm.operation.state).toBe("unknown");
      expect(publication.diagnostics.state).toBe(kind === "incomplete-link" ? "available" : kind);
    },
  );

  it.each(["403 quota", "404 unavailable", "network timeout"])(
    "classifies %s as unavailable, never absence",
    async (failure) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        responses[`repos/${REPOSITORY}/actions/runs/88/artifacts?per_page=100&page=1`] = {
          failure: `${failure}: /private/fixture/credential synthetic-secret`,
        };
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).publication.collection).toEqual({
        complete: false,
        error: "transport",
      });
      expect(result.stdout + result.stderr).not.toMatch(
        /synthetic-secret|private\/fixture|quota|404 unavailable/u,
      );
    },
  );

  it("retains partial package successes and truncation without declaring a complete observation", async () => {
    const fixture = publicationFixture();
    Object.assign(fixture.diagnostic.stages.pluginNpm, {
      packages: [
        { name: "@openclaw/first", state: "success", publication: "observed", error: null },
        {
          name: "@openclaw/second",
          state: "failure",
          publication: "unknown",
          error: { class: "registry-not-visible", status: 1 },
        },
      ],
      packagesTruncated: true,
    });
    const result = await runPublicationCli(fixture);
    const publication = JSON.parse(result.stdout).publication;
    expect(result.status).toBe(1);
    expect(publication.relationship.status).toBe("verified");
    expect(publication.collection.error).toBe("incomplete");
    expect(publication.surfaces.pluginNpm.packages).toHaveLength(2);
    expect(publication.surfaces.pluginNpm.packages[0].publication).toBe("observed");
    expect(publication.surfaces.pluginNpm.packages[1].error.class).toBe("registry-not-visible");
  });

  it("keeps successful verification separate from failed binding, assets and skipped activation", async () => {
    const fixture = publicationFixture();
    fixture.diagnostic.verification = "success";
    fixture.diagnostic.stages.binding.state = "failure";
    fixture.diagnostic.stages.assets.state = "failure";
    fixture.publisher.conclusion = "success";
    fixture.publisherJobs.push({
      ...job("Finalize GitHub release", "skipped"),
      id: 8802,
      run_id: 88,
      run_attempt: 1,
      steps: [],
    });
    const result = await runPublicationCli(fixture);
    const publication = JSON.parse(result.stdout).publication;
    expect(result.status).toBe(0);
    expect(publication.verification.state).toBe("success");
    expect(publication.binding.state).toBe("failure");
    expect(publication.assets.state).toBe("failure");
    expect(publication.surfaces.activation.operation.state).toBe("unknown");
    expect(publication.surfaces.activation.jobs[0].conclusion).toBe("skipped");
  });

  it("retains unattempted verification when an earlier publisher prerequisite failed", async () => {
    const fixture = publicationFixture();
    fixture.diagnostic.verification = "unattempted";
    fixture.diagnostic.stages.coreNpm.state = "unattempted";
    fixture.diagnostic.stages.coreNpm.publication = "unknown";
    const result = await runPublicationCli(fixture);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).publication.surfaces.coreNpm).toMatchObject({
      selection: "unknown",
      verificationSelection: "unknown",
      operation: { state: "unknown" },
      verification: { state: "unattempted" },
    });
  });

  it("keeps Docker-only readback and advisory VCR API step conclusions separate from writer receipts", async () => {
    const fixture = publicationFixture();
    fixture.publisherJobs.push(
      {
        ...job("Verify already-published core npm package"),
        id: 8802,
        run_id: 88,
        run_attempt: 1,
        steps: [],
      },
      {
        ...job("Publish Docker images / publish"),
        id: 8803,
        run_id: 88,
        run_attempt: 1,
        steps: [],
      },
      {
        ...job("Mirror Docker images to Vercel Container Registry / mirror", "failure"),
        id: 8804,
        run_id: 88,
        run_attempt: 1,
        steps: [
          {
            number: 1,
            name: "Copy and verify immutable release images",
            status: "completed",
            conclusion: "success",
          },
          {
            number: 2,
            name: "Run custom-image Sandbox smoke",
            status: "completed",
            conclusion: "failure",
          },
          {
            number: 3,
            name: "Promote and verify channel aliases",
            status: "completed",
            conclusion: "skipped",
          },
        ],
      },
    );
    const result = await runPublicationCli(fixture);
    expect(result.status).toBe(0);
    const surfaces = JSON.parse(result.stdout).publication.surfaces;
    expect(surfaces.coreNpm.registryObservation.state).toBe("observed");
    expect(surfaces.coreNpm.operation.state).toBe("unknown");
    expect(surfaces.docker.children).toEqual([]);
    expect(surfaces.vcr.advisory).toBe(true);
    expect(
      surfaces.vcr.jobs[0].steps.map((step: { conclusion: string }) => step.conclusion),
    ).toEqual(["success", "failure", "skipped"]);
  });

  it("observes a supplied original core child without inventing a publisher-attempt receipt", async () => {
    const fixture = publicationFixture();
    Reflect.set(fixture.diagnostic.children.openclawNpm!, "suppliedRunId", "909");
    const result = await runPublicationCli(fixture, undefined, (responses) => {
      responses[`repos/${REPOSITORY}/actions/runs/909`] = {
        ...fixture.publisher,
        id: 909,
        run_attempt: 3,
        workflow_id: 9090,
        head_sha: SHA,
        head_branch: "older-tooling",
        path: ".github/workflows/openclaw-npm-release.yml",
        conclusion: "success",
      };
      responses[`repos/${REPOSITORY}/actions/workflows/9090`] = {
        id: 9090,
        path: ".github/workflows/openclaw-npm-release.yml",
      };
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).publication.surfaces.coreNpm.children).toEqual([
      {
        runId: "909",
        workflowSha: SHA,
        workflowRef: "older-tooling",
        recordedAttempt: null,
        observedAttempt: 3,
        status: "completed",
        conclusion: "success",
        relation: "supplied",
      },
    ]);
  });

  it("retains a verified relationship when an unrelated child workflow is invalid", async () => {
    const fixture = publicationFixture();
    Reflect.set(fixture.diagnostic.children.openclawNpm!, "suppliedRunId", "909");
    const result = await runPublicationCli(fixture, undefined, (responses) => {
      responses[`repos/${REPOSITORY}/actions/runs/909`] = {
        ...fixture.publisher,
        id: 909,
        workflow_id: 9090,
        path: ".github/workflows/wrong.yml",
      };
      responses[`repos/${REPOSITORY}/actions/workflows/9090`] = {
        id: 9090,
        path: ".github/workflows/wrong.yml",
      };
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).publication.collection.error).toBe("identity-mismatch");
    expect(JSON.parse(result.stdout).publication.relationship.status).toBe("verified");
  });

  it("retains a verified relationship when a validation child advances after the join", async () => {
    const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
      const path = `repos/${REPOSITORY}/actions/runs/101`;
      const before = responses[path] as object;
      responses[path] = { sequence: [before, { ...before, run_attempt: 2 }] };
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).publication.collection.error).toBe("attempt-changed");
    expect(JSON.parse(result.stdout).publication.relationship.status).toBe("verified");
  });

  it.each(["transport", "workflow", "attempt-limit"])(
    "authenticates the publisher before a validation child %s failure",
    async (kind) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const path = `repos/${REPOSITORY}/actions/runs/101`;
        if (kind === "transport") {
          responses[path] = { failure: "403" };
        } else {
          Object.assign(
            responses[path] as object,
            kind === "workflow"
              ? { path: ".github/workflows/wrong.yml" }
              : { run_attempt: 100000000 },
          );
        }
      });
      expect(result.status).toBe(1);
      const publication = JSON.parse(result.stdout).publication;
      expect(publication.collection.complete).toBe(false);
      expect(publication.relationship.status).toBe("verified");
      expect(publication.surfaces.coreNpm.registryObservation.state).toBe("observed");
    },
  );

  it.each([
    ["77", "advances"],
    ["88", "advances"],
    ["77", "is unavailable"],
    ["88", "is unavailable"],
  ])(
    "rechecks joined run %s when it %s after a child collection failure",
    async (runId, outcome) => {
      const path = `repos/${REPOSITORY}/actions/runs/${runId}`;
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const before = responses[path] as { run_attempt: number };
        responses[path] = {
          sequence: [
            before,
            outcome === "advances"
              ? { ...before, run_attempt: before.run_attempt + 1 }
              : { failure: "403" },
          ],
        };
        responses[`repos/${REPOSITORY}/actions/runs/101`] = { failure: "403" };
      });
      expect(result.status).toBe(1);
      const publication = JSON.parse(result.stdout).publication;
      expect(publication.relationship.status).toBe(
        outcome === "advances" ? "invalid" : "unverified",
      );
      expect(publication.relationship.reason).toBe(
        outcome === "advances" ? "attempt-changed" : "transport",
      );
      expect(publication.collection.complete).toBe(false);
      expect(publication.surfaces.coreNpm.registryObservation.state).toBe("observed");
      expect(result.calls.filter((call) => call.includes(path))).toHaveLength(2);
    },
  );

  it.each(["77", "88"])(
    "does not retain a verified relationship when final joined run %s cannot be rechecked",
    async (runId) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const path = `repos/${REPOSITORY}/actions/runs/${runId}`;
        responses[path] = { sequence: [responses[path], { failure: "403" }] };
      });
      expect(result.status).toBe(1);
      const publication = JSON.parse(result.stdout).publication;
      expect(publication.collection).toEqual({ complete: false, error: "transport" });
      expect(publication.relationship.status).toBe("unverified");
      expect(publication.relationship.reason).toBe("transport");
    },
  );

  it("preserves producer-valid passive twenty-digit diagnostic IDs", async () => {
    const fixture = publicationFixture();
    Object.assign(fixture.diagnostic.children.pluginNpm!, {
      readbackArtifactId: "12345678901234567890",
      packageArtifactId: "12345678901234567",
      producerRunAttempt: "12345678901234567890",
    });
    const result = await runPublicationCli(fixture);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).publication.relationship.status).toBe("verified");
    expect(JSON.parse(result.stdout).publication.surfaces.coreNpm.registryObservation.state).toBe(
      "observed",
    );
    expect(result.calls.flat().join(" ")).not.toContain("123456789012345");
  });

  it.each(["77", "88"])(
    "invalidates the relationship when joined run %s advances",
    async (runId) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const path = `repos/${REPOSITORY}/actions/runs/${runId}`;
        const before = responses[path] as { run_attempt: number };
        responses[path] = {
          sequence: [before, { ...before, run_attempt: before.run_attempt + 1 }],
        };
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).publication.relationship.status).toBe("invalid");
    },
  );

  it.each(["77", "88"])(
    "retains the relationship when joined run %s completes the same attempt",
    async (runId) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const path = `repos/${REPOSITORY}/actions/runs/${runId}`;
        const before = responses[path] as object;
        responses[path] = {
          sequence: [
            { ...before, status: "in_progress", conclusion: null },
            { ...before, display_title: "Updated workflow display title" },
          ],
        };
      });
      expect(result.status, result.stderr).toBe(0);
      const publication = JSON.parse(result.stdout).publication;
      expect(publication.relationship.status).toBe("verified");
      expect(publication.collection.complete).toBe(true);
    },
  );

  it.each(["77", "88"])(
    "rejects an immutable SHA change in joined run %s without attempt advancement",
    async (runId) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const path = `repos/${REPOSITORY}/actions/runs/${runId}`;
        responses[path] = {
          sequence: [responses[path], { ...(responses[path] as object), head_sha: "f".repeat(40) }],
        };
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).publication.relationship.status).toBe("invalid");
    },
  );

  it.each(["main", "foreign"])(
    "binds a normal ClawHub child to its recorded %s ref, not the alpha publisher ref",
    async (childRef) => {
      const fixture = publicationFixture();
      const parentRef = "tideclaw/alpha/fixture";
      fixture.publisher.head_branch = parentRef;
      fixture.publisher.path = `${PUBLISH_PATH}@refs/heads/${parentRef}`;
      fixture.diagnostic.context.suppliedToolingRef = `refs/heads/${parentRef}`;
      fixture.diagnostic.selection.clawHubWorkflowRef = "main";
      const result = await runPublicationCli(fixture, undefined, async (responses, artifact) => {
        await artifact(4, fixture.publisher, "openclaw-release-children-88-1", "dispatch.json", {
          schemaVersion: 1,
          repository: REPOSITORY,
          parentRunId: "88",
          parentRunAttempt: "1",
          parentWorkflow: PUBLISH_PATH,
          toolingRef: parentRef,
          toolingFullRef: `refs/heads/${parentRef}`,
          toolingSha: PUBLISH_SHA,
          candidateSha: TARGET_SHA,
          normalClawHubRunId: "909",
          normalClawHubRunAttempt: "1",
        });
        responses[`repos/${REPOSITORY}/actions/runs/909`] = {
          ...fixture.publisher,
          id: 909,
          workflow_id: 9090,
          head_branch: childRef,
          path: ".github/workflows/plugin-clawhub-release.yml",
        };
        responses[`repos/${REPOSITORY}/actions/workflows/9090`] = {
          id: 9090,
          path: ".github/workflows/plugin-clawhub-release.yml",
        };
      });
      expect(result.status).toBe(childRef === "main" ? 0 : 1);
      const publication = JSON.parse(result.stdout).publication;
      expect(publication.relationship.status).toBe("verified");
      if (childRef === "main") {
        expect(publication.surfaces.clawHub.children[0]).toMatchObject({
          runId: "909",
          workflowRef: "main",
          workflowSha: PUBLISH_SHA,
          recordedAttempt: 1,
        });
      }
    },
  );

  it("bounds active twenty-digit child IDs before attempting a metadata GET", async () => {
    const fixture = publicationFixture();
    Reflect.set(fixture.diagnostic.children.pluginNpm!, "suppliedRunId", "12345678901234567890");
    const result = await runPublicationCli(fixture);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).publication.collection.error).toBe("limits");
    expect(JSON.parse(result.stdout).publication.relationship.status).toBe("verified");
    expect(result.calls.flat().join(" ")).not.toContain("12345678901234567890");
  });

  it.each(["in_progress", "failure"])(
    "observes detached Windows %s without equating acknowledgement and promotion",
    async (state) => {
      const fixture = publicationFixture();
      fixture.publisherJobs.push({
        ...job("Dispatch Windows assets after publication"),
        id: 8802,
        run_id: 88,
        run_attempt: 1,
        steps: [
          {
            number: 1,
            name: "Upload Windows dispatch evidence",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
      const native = {
        ...fixture.publisher,
        id: 909,
        workflow_id: 9090,
        path: ".github/workflows/windows-node-release.yml",
        status: state === "failure" ? "completed" : "in_progress",
        conclusion: state === "failure" ? "failure" : null,
      };
      const dispatch = {
        tag: "v2026.9.9",
        sourceTag: "windows-v1",
        installerDigests: "fixture-digests",
        state: "dispatched",
        childRunId: "909",
      };
      const result = await runPublicationCli(fixture, undefined, async (responses, artifact) => {
        await artifact(
          4,
          fixture.publisher,
          "windows-release-dispatch-88-1",
          "windows-dispatch.json",
          dispatch,
        );
        responses[`repos/${REPOSITORY}/actions/runs/909`] = native;
        responses[`repos/${REPOSITORY}/actions/workflows/9090`] = { id: 9090, path: native.path };
        responses[`repos/${REPOSITORY}/actions/runs/909/artifacts?per_page=100&page=1`] = {
          total_count: 0,
          artifacts: [],
        };
        if (state === "failure") {
          await artifact(5, native, "windows-release-promotion-909-1", "windows-promotion.json", {
            schemaVersion: 1,
            ...dispatch,
            outcome: "success",
            runUrl: `https://github.com/${REPOSITORY}/actions/runs/909`,
          });
          responses[`repos/${REPOSITORY}/actions/runs/909/attempts/1/jobs?per_page=100&page=1`] = {
            total_count: 1,
            jobs: [
              {
                ...job("Promote signed Windows installers", "failure"),
                id: 9091,
                run_id: 909,
                run_attempt: 1,
                steps: [
                  {
                    number: 1,
                    name: "Upload Windows promotion evidence",
                    status: "completed",
                    conclusion: "success",
                  },
                ],
              },
            ],
          };
        }
      });
      expect(result.status, result.stdout).toBe(0);
      const surface = JSON.parse(result.stdout).publication.surfaces.nativeWindows;
      expect(surface.children[0].recordedAttempt).toBeNull();
      expect(surface.children[0].status).toBe(native.status);
      expect(surface.children[0].conclusion).toBe(native.conclusion);
      expect(surface.operation.state).toBe("unknown");
      expect(surface.terminalMarker.state).toBe(state === "failure" ? "success" : "unknown");
      if (state === "failure") {
        expect(surface.jobs).toContainEqual({
          jobId: 9091,
          runId: "909",
          runAttempt: 1,
          status: "completed",
          conclusion: "failure",
          steps: [],
        });
      }
    },
  );

  it("limits the dispatch inventory claim to normal ClawHub", async () => {
    const fixture = publicationFixture();
    const result = await runPublicationCli(fixture, undefined, async (_responses, artifact) => {
      await artifact(4, fixture.publisher, "openclaw-release-children-88-1", "dispatch.json", {
        schemaVersion: 1,
        repository: REPOSITORY,
        parentRunId: "88",
        parentRunAttempt: "1",
        parentWorkflow: PUBLISH_PATH,
        toolingRef: PUBLISH_REF,
        toolingFullRef: `refs/tags/${PUBLISH_REF}`,
        toolingSha: PUBLISH_SHA,
        candidateSha: TARGET_SHA,
        normalClawHubRunId: null,
        normalClawHubRunAttempt: null,
      });
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).publication.dispatches[0]).toMatchObject({
      scope: "normal-clawhub",
      state: "not-dispatched",
    });
    expect(JSON.parse(result.stdout).publication.surfaces.pluginNpm.selection).toBe("unknown");
  });

  it.each(["complete", "denied", "duplicate", "changed-total"])(
    "handles a second artifact page: %s",
    async (kind) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const prefix = `repos/${REPOSITORY}/actions/runs/88/artifacts?per_page=100&page=`;
        const first = responses[`${prefix}1`] as { artifacts: unknown[] };
        const diagnostic = first.artifacts[0];
        responses[`${prefix}1`] = {
          total_count: 101,
          artifacts: Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `other-${i}` })),
        };
        responses[`${prefix}2`] =
          kind === "denied"
            ? { failure: "403" }
            : {
                total_count: kind === "changed-total" ? 102 : 101,
                artifacts: [kind === "duplicate" ? { id: 1000, name: "duplicate" } : diagnostic],
              };
      });
      expect(result.status, result.stdout).toBe(kind === "complete" ? 0 : 1);
      expect(JSON.parse(result.stdout).publication.collection.complete).toBe(kind === "complete");
    },
  );

  it.each(["traversal", "unexpected-entry", "expanded", "truncated", "corrupt", "duplicate-entry"])(
    "refuses %s archives before projecting diagnostics",
    async (kind) => {
      const fixture = publicationFixture();
      const result = await runPublicationCli(fixture, undefined, async (responses, artifact) => {
        await artifact(
          3,
          fixture.publisher,
          "openclaw-release-postpublish-diagnostics-88-1",
          DIAGNOSTIC_FILE,
          fixture.diagnostic,
          (zip) => {
            if (kind === "traversal") {
              zip.file("../escape.json", "{}");
            }
            if (kind === "unexpected-entry") {
              zip.file("extra.json", "{}");
            }
            if (kind === "expanded") {
              zip.file(DIAGNOSTIC_FILE, " ".repeat(128 * 1024 + 1));
            }
            if (kind === "duplicate-entry") {
              zip.file("x".repeat(DIAGNOSTIC_FILE.length), "{}");
            }
          },
        );
        const archive = responses[`repos/${REPOSITORY}/actions/artifacts/3/zip`] as {
          binary: string;
        };
        let bytes = Buffer.from(archive.binary, "base64");
        if (kind === "truncated") {
          bytes = bytes.subarray(0, -10);
        }
        if (kind === "corrupt") {
          bytes[0] = 0;
        }
        if (kind === "duplicate-entry") {
          const needle = Buffer.from("x".repeat(DIAGNOSTIC_FILE.length));
          for (let offset = bytes.indexOf(needle); offset !== -1; offset = bytes.indexOf(needle)) {
            bytes.set(Buffer.from(DIAGNOSTIC_FILE), offset);
          }
        }
        archive.binary = bytes.toString("base64");
        Object.assign(responses[`repos/${REPOSITORY}/actions/artifacts/3`] as object, {
          size_in_bytes: bytes.length,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        });
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).publication.verification.state).toBe("unknown");
    },
  );

  it.each(["metadata-drift", "postread-expiry", "page-limit", "json-limit"])(
    "bounds %s without fallback",
    async (kind) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const metadataPath = `repos/${REPOSITORY}/actions/artifacts/3`;
        if (kind === "metadata-drift" || kind === "postread-expiry") {
          const original = responses[metadataPath] as object;
          responses[metadataPath] = {
            sequence: [
              original,
              {
                ...original,
                ...(kind === "metadata-drift" ? { id: 4 } : { expires_at: "2000-01-01T00:00:00Z" }),
              },
            ],
          };
        }
        if (kind === "page-limit") {
          responses[`repos/${REPOSITORY}/actions/runs/88/artifacts?per_page=100&page=1`] = {
            total_count: 1001,
            artifacts: [],
          };
        }
        if (kind === "json-limit") {
          responses[`repos/${REPOSITORY}/actions/runs/88`] = {
            raw: " ".repeat(2 * 1024 * 1024 + 1),
          };
        }
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).publication.collection.complete).toBe(false);
    },
  );

  it("enforces the whole-command deadline independently of continuation settings", async () => {
    const result = await runPublicationCli(
      publicationFixture(),
      undefined,
      undefined,
      false,
      100000,
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).publication.collection.error).toBe("deadline");
    expect(result.calls).toHaveLength(1);
  });

  it.each([
    [1, true],
    [100, true],
    [100, false],
  ] as const)(
    "caps final output with %i steps (JSON=%s) without erasing observations",
    async (steps, json) => {
      const fixture = publicationFixture();
      Reflect.set(
        fixture.diagnostic.stages.pluginNpm,
        "packages",
        Array.from({ length: 256 }, (_, index) => ({
          name: `@openclaw/fixture-${index}`,
          state: "success",
          publication: "observed",
          error: null,
        })),
      );
      const args = [
        "status",
        "--run",
        "77",
        "--publication-run",
        "88",
        ...(json ? ["--json"] : []),
      ];
      const result = await runPublicationCli(fixture, args, (responses) => {
        const jobs = Array.from({ length: 999 }, (_, i) => ({
          ...job("Mirror Docker images to Vercel Container Registry / mirror"),
          id: 10000 + i,
          run_id: 88,
          run_attempt: 1,
          steps: Array.from({ length: steps }, (_step, index) => ({
            number: index + 1,
            name: "Copy and verify immutable release images",
            status: "completed",
            conclusion: "success",
          })),
        }));
        jobs.unshift(publicationFixture().publisherJobs[0]!);
        for (let page = 1; page <= 10; page++) {
          responses[
            `repos/${REPOSITORY}/actions/runs/88/attempts/1/jobs?per_page=100&page=${page}`
          ] = {
            total_count: jobs.length,
            jobs: jobs.slice((page - 1) * 100, page * 100),
          };
        }
      });
      expect(result.status).toBe(1);
      if (json) {
        const publication = JSON.parse(result.stdout).publication;
        expect(publication.collection).toEqual({
          complete: false,
          error: "limits",
          outputTruncated: true,
          validationStatusOmitted: true,
        });
        expect(publication.publisher).toMatchObject({ runId: "88", runAttempt: 1 });
        expect(publication.relationship).toMatchObject({
          status: "verified",
          originalPlanAttempt: 1,
          validationAttempt: 2,
        });
        expect(publication.diagnostics).toMatchObject({ state: "available", artifactId: 3 });
        expect(publication.surfaces.coreNpm.registryObservation.state).toBe("observed");
        expect(publication.surfaces.vcr.jobs).toHaveLength(4);
        expect(publication.surfaces.vcr.jobsOmitted).toBe(995);
        expect(publication.surfaces.vcr.jobs[0].steps).toHaveLength(steps);
        expect(publication.surfaces.vcr.jobs[0].steps[0].conclusion).toBe("success");
        expect(publication.surfaces.pluginNpm.packages).toHaveLength(4);
        expect(publication.surfaces.pluginNpm.packagesOmitted).toBe(252);
        expect(publication.surfaces.pluginNpm.packages[0]).toMatchObject({
          name: "@openclaw/fixture-0",
          state: "success",
          publication: "observed",
        });
      } else {
        expect(result.stdout).toContain("relationship: verified");
        expect(result.stdout).toContain("publisher: 88 attempt=1");
        expect(result.stdout).toContain("registry-observation=observed");
        expect(result.stdout).toContain("jobs omitted: 995");
        expect(result.stdout).toContain("packages omitted: 252");
        expect(result.stdout).toContain("validation detail omitted: output limit");
      }
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(256 * 1024);
    },
  );

  it("preserves legacy status JSON and performs no publication reads without the selector", async () => {
    const result = await runPublicationCli(publicationFixture(), [
      "status",
      "--run",
      "77",
      "--json",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(Object.keys(value)).toEqual(["children", "failed", "active", "missing", "passed"]);
    expect(value.children).toHaveLength(4);
    expect(value.passed).toHaveLength(4);
    expect(result.calls).toHaveLength(9);
    expect(result.calls.flat().join(" ")).not.toMatch(
      /publication|runs\/88|workflows\/|artifacts\//u,
    );
  });

  it.each(["continue", "verify"])(
    "preserves legacy %s plan refusal without publication reads",
    async (command) => {
      const fixture = publicationFixture();
      Object.assign(fixture.executionPlan, historicalExecutionPlanArtifact());
      for (const key of ["attemptEvidenceVersion", "candidate", "candidateRequest", "repository"]) {
        Reflect.deleteProperty(fixture.executionPlan, key);
      }
      const result = await runPublicationCli(fixture, [
        command,
        "--run",
        "77",
        ...(command === "continue" ? ["--failed"] : []),
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("predates attempt-aware immutable plans");
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]?.slice(0, 3)).toEqual(["run", "download", "77"]);
    },
  );

  it("strips arbitrary artifact extras, job names, URLs and control characters from output", async () => {
    const fixture = publicationFixture();
    const unsafe = "synthetic-secret /private/fixture/key \u001b[31m";
    Reflect.set(fixture.diagnostic, "rawError", unsafe);
    fixture.publisher.display_title = unsafe;
    fixture.publisherJobs.push({ ...job(unsafe), id: 8899, run_id: 88, run_attempt: 1, steps: [] });
    const result = await runPublicationCli(fixture);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toMatch(/synthetic-secret|private\/fixture/u);
    expect(result.stdout + result.stderr).not.toContain("\u001b");
  });
});
