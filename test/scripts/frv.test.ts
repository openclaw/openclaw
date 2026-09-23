import { describe, expect, it, vi } from "vitest";
import {
  continueFailed,
  createClient,
  inspectContinuation,
  loadPlan,
  preflightContinuation,
} from "../../scripts/frv.mjs";
import {
  releaseChildSpec,
  releaseCompositeJobsSha256,
  releaseExecutionPlanSha256,
  validateReleaseExecutionPlanArtifact,
} from "../../scripts/full-release-validation-policy.mjs";
import { createReleaseEvidenceClient } from "../../scripts/release-ci-summary.mjs";
import {
  SHA,
  TARGET_SHA,
  SOURCE_REF,
  REPOSITORY,
  job,
  child,
  withoutChildRunIdentity,
  plan,
  executionPlanArtifact,
  historicalExecutionPlanArtifact,
  runFor,
  rootRun,
} from "./frv.test-support.js";

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
    getReleaseEvidenceClient: () => ({
      ...createReleaseEvidenceClient(REPOSITORY),
      getWorkflowSource: () => "name: Full Release Validation\n",
    }),
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
    getRun: async (runId: string) => (runId === "77" ? rootRun() : childRun(byRunId.get(runId)!)),
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
  function artifactFixture(stage = "npm") {
    const selected = child("normalCi", "101");
    const methods = preflightMethods([selected], (entry) => runFor(entry, 1, "success"));
    const producer = {
      id: 81,
      run_attempt: 1,
      event: "workflow_dispatch",
      path: ".github/workflows/full-release-artifacts.yml",
      repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY },
      head_sha: SHA,
      head_branch: SOURCE_REF,
      display_title: `Full Release Artifacts full-release-validation-77-1-artifacts-${stage}`,
      status: "completed",
      conclusion: "success" as string | null,
      html_url: `https://github.com/${REPOSITORY}/actions/runs/81`,
    };
    const logs = {
      dispatch: `TARGET_SHA: ${TARGET_SHA}\nDispatched full-release-artifacts.yml: https://github.com/${REPOSITORY}/actions/runs/81 (attempt 1)`,
    };
    const client = {
      ...methods,
      getReleaseEvidenceClient: () => ({
        ...methods.getReleaseEvidenceClient(),
        getWorkflowSource: () =>
          "name: Full Release Validation\njobs:\n  prepare:\n    steps:\n      - run: node scripts/full-release-artifacts.mjs resolve\n",
      }),
      getParentJobs: async () => [
        ...(await methods.getParentJobs()),
        ...[
          ["Prepare release npm artifacts", "npm"],
          ["Prepare release Docker artifacts", "docker"],
          ["Acquire full release candidate", "candidate"],
        ].map(([name, kind]) => ({
          id: 90,
          name,
          run_attempt: 1,
          status: "completed",
          conclusion: kind === stage ? "success" : "skipped",
        })),
      ],
      getJobLog: async (id: number) => (id === 90 ? logs.dispatch : methods.getJobLog(id)),
      getRun: vi.fn(async (id: string) => (id === "81" ? producer : methods.getRun(id))),
      getAttemptJobs: async () => [job("test")],
      rerunFailed: vi.fn(),
      rerunParent: vi.fn(),
    };
    return { client, producer, logs, selected, plan: plan([selected]) };
  }

  it("retries only failed npm producer jobs, preserves green diagnostics, and verifies the parent", async () => {
    const fixture = artifactFixture();
    fixture.producer.conclusion = "failure";
    let parentAttempt = 1;
    const read = fixture.client.getRun.getMockImplementation()!;
    fixture.client.getRun.mockImplementation(async (id) =>
      id === "77"
        ? rootRun(parentAttempt, parentAttempt === 1 ? "failure" : "success")
        : structuredClone(await read(id)),
    );
    fixture.client.rerunFailed.mockImplementation(async (id: string) => {
      expect(id).toBe("81");
      fixture.producer.run_attempt = 2;
      fixture.producer.conclusion = "success";
    });
    fixture.client.rerunParent.mockImplementation(async () => {
      parentAttempt = 2;
    });
    const verify = vi.fn();
    await expect(
      continueFailed(fixture.plan, "77", { ...fixture.client, verify }),
    ).resolves.toMatchObject({ action: "reran-parent" });
    expect(fixture.client.rerunFailed).toHaveBeenCalledExactlyOnceWith("81");
    expect(fixture.client.rerunParent).toHaveBeenCalledExactlyOnceWith("77");
    expect(verify).toHaveBeenCalledWith("77", fixture.plan, expect.any(Number), {
      "77": 2,
      "101": 1,
    });
  });

  it("recovers a failed child before the npm dispatch job exposes its completed log", async () => {
    const fixture = artifactFixture();
    const readParentJobs = fixture.client.getParentJobs;
    let childAttempt = 1;
    let parentAttempt = 1;
    fixture.client.getParentJobs = async () =>
      (await readParentJobs()).map((entry) =>
        entry.name === "Prepare release npm artifacts" && childAttempt === 1
          ? Object.assign(entry, { status: "in_progress", conclusion: "" })
          : entry,
      );
    fixture.client.getRun.mockImplementation(async (id: string) =>
      id === "81"
        ? fixture.producer
        : id === "77"
          ? rootRun(parentAttempt, parentAttempt === 1 ? "failure" : "success")
          : runFor(fixture.selected, childAttempt, childAttempt === 1 ? "failure" : "success"),
    );
    fixture.client.getAttemptJobs = async () => [
      job("test", childAttempt === 1 ? "failure" : "success"),
    ];
    fixture.client.rerunFailed.mockImplementation(async (id: string) => {
      expect(id).toBe("101");
      childAttempt = 2;
    });
    fixture.client.rerunParent.mockImplementation(async () => {
      parentAttempt = 2;
    });
    vi.useFakeTimers();
    try {
      const result = expect(
        continueFailed(
          fixture.plan,
          "77",
          {
            ...fixture.client,
            verify: async () => "{}",
          },
          { operationDeadline: Date.now() + 60_000 },
        ),
      ).resolves.toMatchObject({ action: "reran-parent" });
      await Promise.all([result, vi.advanceTimersByTimeAsync(60_000)]);
    } finally {
      vi.useRealTimers();
    }
    expect(fixture.client.rerunFailed).toHaveBeenCalledExactlyOnceWith("101");
  });

  it.each(["failure", "cancelled", "timed_out"])(
    "offers failed-job producer recovery for %s without mutating during dry run",
    async (conclusion) => {
      const fixture = artifactFixture();
      fixture.producer.conclusion = conclusion;
      await expect(
        continueFailed(fixture.plan, "77", fixture.client, { dryRun: true }),
      ).resolves.toMatchObject({
        action: "would-rerun",
        status: { failed: [expect.objectContaining({ key: "artifact:npm", runId: "81" })] },
      });
      expect(fixture.client.rerunFailed).not.toHaveBeenCalled();
      expect(fixture.client.rerunParent).not.toHaveBeenCalled();
    },
  );

  it.each(["before-verify", "after-verify", "after-seal"])(
    "does not accept changed npm producer evidence %s",
    async (boundary) => {
      for (const update of [
        { run_attempt: 3 },
        { conclusion: "failure" },
        { head_sha: "c".repeat(40) },
      ]) {
        const fixture = artifactFixture();
        fixture.producer.run_attempt = 2;
        let parentAttempt = boundary === "after-seal" ? 2 : 1;
        const read = fixture.client.getRun.getMockImplementation()!;
        fixture.client.getRun.mockImplementation(async (id) =>
          id === "77"
            ? rootRun(parentAttempt, parentAttempt === 1 ? "failure" : "success")
            : structuredClone(await read(id)),
        );
        const changeProducer = () => Object.assign(fixture.producer, update);
        fixture.client.rerunParent.mockImplementation(async () => {
          parentAttempt = 2;
          if (boundary === "before-verify") {
            changeProducer();
          }
        });
        const verify = vi.fn(async () => {
          changeProducer();
        });
        const verifySeal = vi.fn(async () => {
          changeProducer();
          return true;
        });
        await expect(
          continueFailed(fixture.plan, "77", {
            ...fixture.client,
            verify,
            ...(boundary === "after-seal" ? { verifySeal } : {}),
          }),
        ).rejects.toThrow(/Artifact producer (?:run identity changed|changed during recovery)/u);
        expect(fixture.client.rerunFailed).not.toHaveBeenCalled();
        if (boundary === "before-verify") {
          expect(verify).not.toHaveBeenCalled();
        } else if (boundary === "after-verify") {
          expect(verify).toHaveBeenCalledOnce();
        } else {
          expect(verifySeal).toHaveBeenCalledOnce();
          expect(fixture.client.rerunParent).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("adopts an already successful newer producer attempt without rerunning it", async () => {
    const fixture = artifactFixture();
    fixture.producer.run_attempt = 2;
    await expect(
      continueFailed(fixture.plan, "77", fixture.client, { dryRun: true }),
    ).resolves.toMatchObject({ action: "would-rerun-parent" });
    expect(fixture.client.rerunFailed).not.toHaveBeenCalled();
  });

  it.each([
    ["different tooling", { head_sha: "c".repeat(40) }],
    ["different dispatch", { display_title: "Full Release Artifacts unrelated" }],
    ["regressed attempt", { run_attempt: 0 }],
  ])("rejects %s producer evidence without mutations", async (_label, update) => {
    const fixture = artifactFixture();
    Object.assign(fixture.producer, update);
    await expect(
      continueFailed(fixture.plan, "77", fixture.client, { dryRun: true }),
    ).rejects.toThrow();
    expect(fixture.client.rerunFailed).not.toHaveBeenCalled();
    expect(fixture.client.rerunParent).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])(
    "keeps successful producers eligible after a collector %s",
    async (conclusion) => {
      const fixture = artifactFixture();
      const jobs = fixture.client.getParentJobs;
      fixture.client.getParentJobs = async () => {
        const entries = await jobs();
        for (const entry of entries) {
          if (entry.name === "Prepare release npm artifacts") {
            entry.conclusion = conclusion;
          }
        }
        return entries;
      };
      await expect(
        continueFailed(fixture.plan, "77", fixture.client, { dryRun: true }),
      ).resolves.toMatchObject({ action: "would-rerun-parent" });
    },
  );

  it("rejects ambiguous producer dispatch logs", async () => {
    const fixture = artifactFixture();
    fixture.logs.dispatch += `\n${fixture.logs.dispatch}`;
    await expect(continueFailed(fixture.plan, "77", fixture.client)).rejects.toThrow(
      "dispatch identity is unavailable or ambiguous",
    );
    expect(fixture.client.rerunParent).not.toHaveBeenCalled();
  });

  it("rechecks the producer after child inspection and before parent mutation", async () => {
    const fixture = artifactFixture();
    const read = fixture.client.getRun.getMockImplementation()!;
    fixture.client.getRun.mockImplementation(async (id) => {
      if (id === "77") {
        fixture.producer.head_sha = "c".repeat(40);
      }
      return read(id);
    });
    await expect(continueFailed(fixture.plan, "77", fixture.client)).rejects.toThrow(
      "identity changed",
    );
    expect(fixture.client.rerunParent).not.toHaveBeenCalled();
  });

  it("rechecks the producer before retrying a failed diagnostic child", async () => {
    const fixture = artifactFixture();
    const read = fixture.client.getRun.getMockImplementation()!;
    let childReads = 0;
    fixture.client.getRun.mockImplementation(async (id) => {
      if (id === "101") {
        if (++childReads === 2) {
          fixture.producer.head_sha = "c".repeat(40);
        }
        return runFor(child("normalCi", "101"), 1, "failure");
      }
      return read(id);
    });
    fixture.client.getAttemptJobs = async () => [job("test", "failure")];
    await expect(continueFailed(fixture.plan, "77", fixture.client)).rejects.toThrow(
      "identity changed",
    );
    expect(fixture.client.rerunFailed).not.toHaveBeenCalled();
    expect(fixture.client.rerunParent).not.toHaveBeenCalled();
  });
  it("rejects deleted B admission before continuation can select rerun effects", async () => {
    const selected = child("normalCi", "101");
    const client = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure")),
      getReleaseEvidenceClient: () => ({
        ...createReleaseEvidenceClient(REPOSITORY),
        getWorkflowSource: () =>
          'env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n  FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1"\n',
      }),
      getAttemptJobs: vi.fn(async () => [job("test", "failure")]),
      getRun: vi.fn(async () => runFor(selected, 1, "failure")),
      rerunFailed: vi.fn(),
      rerunParent: vi.fn(),
    };
    await expect(continueFailed(plan([selected]), "77", client, { dryRun: true })).rejects.toThrow(
      "continuation admission differs from its immutable source workflow contract",
    );
    expect(client.getRun).not.toHaveBeenCalled();
    expect(client.rerunFailed).not.toHaveBeenCalled();
    expect(client.rerunParent).not.toHaveBeenCalled();
  });

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
        getReleaseEvidenceClient: () => {
          reads += 1;
          throw new Error("unexpected evidence client");
        },
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
        getReleaseEvidenceClient: () => {
          downstreamReads += 1;
          throw new Error("unexpected evidence client");
        },
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

  it("retries each terminal child while the parent and other child attempts are still active", async () => {
    const first = child("normalCi", "101");
    const second = child("pluginPrerelease", "202");
    const children = [first, second];
    const childRuns = new Map<string, { attempt: number; conclusion: string | null }>([
      ["101", { attempt: 1, conclusion: "failure" }],
      ["202", { attempt: 1, conclusion: null }],
    ]);
    const parent = { attempt: 1, conclusion: null as string | null };
    const events: string[] = [];
    const client = {
      ...controllerClient(children, childRuns, parent),
      rerunFailed: async (runId: string) => {
        expect(parent.conclusion).toBeNull();
        events.push(runId);
        if (runId === "101") {
          expect(childRuns.get("202")?.conclusion).toBeNull();
          childRuns.set("101", { attempt: 2, conclusion: null });
          childRuns.set("202", { attempt: 1, conclusion: "failure" });
        } else {
          expect(childRuns.get("101")?.conclusion).toBeNull();
          childRuns.set("101", { attempt: 2, conclusion: "success" });
          childRuns.set("202", { attempt: 2, conclusion: "success" });
          parent.conclusion = "failure";
        }
      },
      rerunParent: async () => {
        events.push("parent");
        parent.attempt = 2;
        parent.conclusion = "success";
      },
      verify: vi.fn(async () => "{}"),
    };
    vi.useFakeTimers();
    try {
      const result = expect(
        continueFailed(plan(children), "77", client, {
          operationDeadline: Date.now() + 100,
        }),
      ).resolves.toMatchObject({
        action: "reran-parent",
        reruns: [
          { child: "normalCi", sourceRunAttempt: 1, runAttempt: 2 },
          { child: "pluginPrerelease", sourceRunAttempt: 1, runAttempt: 2 },
        ],
      });
      await Promise.all([result, vi.advanceTimersByTimeAsync(60_000)]);
    } finally {
      vi.useRealTimers();
    }
    expect(events).toEqual(["101", "202", "parent"]);
    expect(client.verify).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "reruns the exact carried failed job once, including ambiguous response=%s",
    async (ambiguous) => {
      const selected = child("normalCi", "101");
      const childRuns = new Map([["101", { attempt: 2, conclusion: "failure" }]]);
      const parent = { attempt: 1, conclusion: "failure" };
      const client = {
        ...controllerClient([selected], childRuns, parent),
        getAttemptJobs: async (_runId: string, attempt: number) =>
          attempt === 1
            ? [
                { ...job("selected", "failure"), id: 11, run_id: 101, run_attempt: 1 },
                { ...job("unrelated", "failure"), id: 12, run_id: 101, run_attempt: 1 },
              ]
            : attempt === 2
              ? [job("other", "success")]
              : [job("selected", "success")],
        rerunJob: vi.fn(async () => {
          childRuns.set("101", { attempt: 3, conclusion: "failure" });
          if (ambiguous) {
            throw Object.assign(new Error("read ECONNRESET after dispatch"), {
              code: "ECONNRESET",
            });
          }
        }),
        rerunFailed: vi.fn(async () => {
          throw new Error("HTTP 403: targeted job must not use failed-jobs API");
        }),
        rerunParent: vi.fn(),
        verify: vi.fn(),
      };
      await expect(
        continueFailed(plan([selected]), "77", client, {
          job: "normalCi:selected",
        }),
      ).rejects.toThrow("complete green composite: normalCi");
      expect(client.rerunJob).toHaveBeenCalledExactlyOnceWith(11);
      expect(client.rerunFailed).not.toHaveBeenCalled();
      expect(client.rerunParent).not.toHaveBeenCalled();
    },
  );

  it("waits only for the selected child before sending a targeted job rerun and reseals afterward", async () => {
    const selected = child("normalCi", "101");
    const sibling = child("pluginPrerelease", "202");
    const childRuns = new Map<string, { attempt: number; conclusion: string | null }>([
      ["101", { attempt: 1, conclusion: null }],
      ["202", { attempt: 1, conclusion: null }],
    ]);
    const parent = { attempt: 1, conclusion: null as string | null };
    const controller = controllerClient([selected, sibling], childRuns, parent);
    let selectedReads = 0;
    const client = {
      ...controller,
      getRun: async (runId: string) => {
        if (runId === "101" && ++selectedReads === 2) {
          childRuns.set("101", { attempt: 1, conclusion: "failure" });
        }
        return controller.getRun(runId);
      },
      getAttemptJobs: async (runId: string, attempt: number) => [
        {
          ...job("selected", attempt === 1 && runId === "101" ? "failure" : "success"),
          id: 11,
          run_id: Number(runId),
          run_attempt: attempt,
        },
      ],
      rerunJob: vi.fn(async () => {
        expect(childRuns.get("202")?.conclusion).toBeNull();
        expect(parent.conclusion).toBeNull();
        childRuns.set("101", { attempt: 2, conclusion: "success" });
        childRuns.set("202", { attempt: 1, conclusion: "success" });
        parent.conclusion = "failure";
      }),
      rerunFailed: vi.fn(),
      rerunParent: vi.fn(async () => {
        parent.attempt = 2;
        parent.conclusion = "success";
      }),
      verify: vi.fn(async () => "{}"),
    };
    vi.useFakeTimers();
    try {
      const result = expect(
        continueFailed(plan([selected, sibling]), "77", client, {
          job: "normalCi:selected",
          operationDeadline: Date.now() + 60_000,
        }),
      ).resolves.toMatchObject({
        action: "reran-parent",
        reruns: [{ jobId: 11, jobName: "selected", sourceRunAttempt: 1, runAttempt: 2 }],
      });
      await Promise.all([result, vi.advanceTimersByTimeAsync(60_000)]);
    } finally {
      vi.useRealTimers();
    }
    expect(client.rerunJob).toHaveBeenCalledExactlyOnceWith(11);
    expect(client.rerunFailed).not.toHaveBeenCalled();
    expect(client.rerunParent).toHaveBeenCalledExactlyOnceWith("77");
  });

  it.each([
    ["normalCi", "success"],
    ["normalCi", "neutral"],
    ["npmTelegram", "failure"],
  ])("honors exact job eligibility independently of %s child policy", async (key, conclusion) => {
    const selected = child(key, "101");
    const selectedPlan = { ...plan([selected]), releaseProfile: "full" };
    const childRuns = new Map([["101", { attempt: 1, conclusion }]]);
    const parent = { attempt: 1, conclusion: "success" };
    const client = {
      ...controllerClient([selected], childRuns, parent),
      getAttemptJobs: async (_id: string, attempt: number) => [
        {
          ...job("selected", attempt === 1 ? conclusion : "success"),
          id: 11,
          run_id: 101,
          run_attempt: attempt,
        },
      ],
      rerunJob: vi.fn(async () => {
        childRuns.set("101", { attempt: 2, conclusion: "success" });
      }),
      rerunFailed: vi.fn(),
      rerunParent: vi.fn(async () => {
        parent.attempt = 2;
      }),
      verify: vi.fn(async () => "{}"),
    };
    const result = continueFailed(selectedPlan, "77", client, { job: `${key}:selected` });
    await expect(result).resolves.toMatchObject({ action: "reran-parent" });
    expect(client.rerunJob).toHaveBeenCalledExactlyOnceWith(11);
    expect(client.rerunFailed).not.toHaveBeenCalled();
  });

  it.each(["attempt", "triggering actor"])(
    "revalidates the selected child %s immediately before its targeted mutation",
    async (change) => {
      const scenario = rerunScenario({
        childBefore: [
          [1, "failure"],
          [1, "failure"],
          change === "attempt"
            ? [2, "success"]
            : [1, "failure", undefined, undefined, "other-operator"],
        ],
      });
      const client = {
        ...scenario.client,
        getAttemptJobs: async (_id: string, attempt: number) => [
          {
            ...job("test", attempt === 1 ? "failure" : "success"),
            id: 11,
            run_id: 101,
            run_attempt: attempt,
          },
        ],
        rerunJob: vi.fn(async () => {
          throw new Error("HTTP 403: unexpected job dispatch");
        }),
      };
      await expect(
        continueFailed(plan([scenario.selected]), "77", client, { job: "normalCi:test" }),
      ).rejects.toThrow("child 101 changed before rerun dispatch");
      expect(client.rerunJob).not.toHaveBeenCalled();
    },
  );

  it.each(["conclusion", "run_id", "run_attempt", "duplicate"])(
    "rejects changed %s job evidence before a targeted POST",
    async (change) => {
      const selected = child("normalCi", "101");
      const scenario = rerunScenario({});
      let reads = 0;
      const client = {
        ...scenario.client,
        getAttemptJobs: async () => {
          const raw = { ...job("test", "failure"), id: 11, run_id: 101, run_attempt: 1 };
          if (++reads > 1) {
            if (change === "duplicate") {
              return [raw, { ...raw, id: 12 }];
            }
            Reflect.set(raw, change, change === "conclusion" ? "success" : 999);
          }
          return [raw];
        },
        rerunJob: vi.fn(),
      };
      await expect(
        continueFailed(plan([selected]), "77", client, { job: "normalCi:test" }),
      ).rejects.toThrow("job identity changed");
      expect(client.rerunJob).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["settles", "normalCi", "success"],
    ["persists", "normalCi", "success"],
    ["attempt changes", "normalCi", "success"],
    ["attempt changes after jobs", "normalCi", "success"],
    ["settles", "releaseChecks", "failure"],
  ])(
    "bounds duplicate job materialization when it %s for %s with %s",
    async (outcome, key, conclusion) => {
      const selected = child(key, "101");
      let latestReads = 0;
      const client = {
        getRun: async () =>
          runFor(
            selected,
            (outcome === "attempt changes" && latestReads > 0) ||
              (outcome === "attempt changes after jobs" && latestReads > 1)
              ? 3
              : 2,
            conclusion,
          ),
        getAttemptJobs: async (_runId: string, attempt: number) => {
          const jobs = [job("test", attempt === 1 ? "failure" : conclusion)];
          if (attempt === 2 && (++latestReads === 1 || outcome === "persists")) {
            jobs.push(job("test"));
          }
          return jobs;
        },
        repository: REPOSITORY,
      };
      vi.useFakeTimers();
      vi.stubEnv("OPENCLAW_FRV_RECONCILE_TIMEOUT_MS", "100");
      vi.stubEnv("OPENCLAW_FRV_POLL_MS", "50");
      try {
        const inspection = inspectContinuation(plan([selected]), client);
        const result =
          outcome === "settles"
            ? expect(inspection).resolves.toMatchObject({
                children: [
                  {
                    effectiveRunAttempt: 2,
                    status: conclusion === "success" ? "passed" : "failed",
                  },
                ],
              })
            : expect(inspection).rejects.toThrow(
                outcome === "persists"
                  ? "duplicate job identity"
                  : "changed during attempt materialization",
              );
        await Promise.all([result, vi.advanceTimersByTimeAsync(60_000)]);
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }
      expect(latestReads).toBe(outcome === "attempt changes" ? 1 : 2);
    },
  );

  it("caps continuation materialization reads at the operation deadline", async () => {
    const scenario = rerunScenario({ childSource: [2, "failure"] });
    const readTimes: number[] = [];
    const client = {
      ...scenario.client,
      getRun: async (runId: string) => {
        readTimes.push(Date.now());
        return scenario.client.getRun(runId);
      },
      getAttemptJobs: async (_runId: string, attempt: number) =>
        attempt === 2 ? [job("test", "failure"), job("test", "failure")] : [job("test")],
    };
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_FRV_RECONCILE_TIMEOUT_MS", "10");
    try {
      const operationDeadline = Date.now() + 5;
      const result = expect(
        continueFailed(plan([scenario.selected]), "77", client, { operationDeadline }),
      ).rejects.toThrow("duplicate job identity");
      await Promise.all([result, vi.advanceTimersByTimeAsync(20)]);
      expect(Math.max(...readTimes)).toBeLessThan(operationDeadline);
      expect(scenario.counters.posts).toEqual({ child: 0, parent: 0 });
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
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

describe("FRV manual and automatic retry ownership", () => {
  function scenario(includeSibling = false) {
    const selected = child("normalCi", "101");
    const children = includeSibling ? [selected, child("pluginPrerelease", "202")] : [selected];
    const childRuns = new Map(
      children.map((entry) => [entry.runId, { attempt: 1, conclusion: "failure" }]),
    );
    const parent = { attempt: 1, conclusion: "failure" as string | null };
    const owner = (key: string, attempt = 1) => ({
      name: `Automatic retry (${key})`,
      run_attempt: attempt,
      status: "completed",
    });
    const state = {
      originalActive: false,
      owners: children.map((entry) => owner(entry.key)),
      parentSha: SHA,
    };
    const base = controllerClient(children, childRuns, parent);
    const client = {
      ...base,
      getRun: async (id: string) => ({
        ...(await base.getRun(id)),
        ...(id === "77" ? { head_sha: state.parentSha } : {}),
      }),
      getRunAttempt: async (id: string) =>
        id === "77" ? rootRun(1, state.originalActive ? null : "failure") : base.getRunAttempt(id),
      getParentJobs: async () => [...(await base.getParentJobs()), ...state.owners],
      getAttemptJobs: async (id: string, attempt: number) => [
        {
          ...job("test", attempt === 1 ? "failure" : "success"),
          id: Number(id) * 10,
          run_id: Number(id),
          run_attempt: attempt,
        },
      ],
      getManualRetryAuthority: vi.fn(async (_plan: Record<string, unknown>, _key: string) => ({
        outcome: "not-attempted" as "not-attempted" | "rejected",
      })),
      rerunFailed: vi.fn(async (id: string) => {
        childRuns.set(id, { attempt: childRuns.get(id)!.attempt + 1, conclusion: "success" });
      }),
      rerunJob: vi.fn(async () => {
        childRuns.set("101", { attempt: childRuns.get("101")!.attempt + 1, conclusion: "success" });
      }),
      rerunParent: vi.fn(async () => {
        parent.attempt += 1;
        parent.conclusion = "success";
      }),
      verify: vi.fn(async () => "{}"),
    };
    return {
      childRuns,
      client,
      owner,
      parent,
      plan: { ...plan(children), knownFlakyJobs: children.map((entry) => `${entry.key}:declared`) },
      state,
    };
  }

  it.each(["active", "missing", "duplicate", "current-active", "current-missing"])(
    "waits for %s automatic ownership even when the selected job is not declared flaky",
    async (kind) => {
      const fixture = scenario();
      fixture.parent.conclusion = null;
      fixture.state.originalActive = !kind.startsWith("current-");
      if (kind === "active") {
        fixture.state.owners[0]!.status = "in_progress";
      }
      if (kind === "missing") {
        fixture.state.owners = [];
      }
      if (kind === "duplicate") {
        fixture.state.owners.push(fixture.owner("normalCi"));
      }
      if (kind.startsWith("current-")) {
        fixture.parent.attempt = 2;
      }
      if (kind === "current-active") {
        fixture.state.owners.push({ ...fixture.owner("normalCi", 2), status: "in_progress" });
      }
      vi.useFakeTimers();
      vi.stubEnv("OPENCLAW_FRV_POLL_MS", "50");
      try {
        const result = expect(
          continueFailed(fixture.plan, "77", fixture.client, {
            job: "normalCi:test",
            operationDeadline: Date.now() + 200,
          }),
        ).resolves.toMatchObject({ action: "reran-parent" });
        await vi.advanceTimersByTimeAsync(25);
        expect(fixture.client.rerunJob).not.toHaveBeenCalled();
        expect(fixture.client.getManualRetryAuthority).not.toHaveBeenCalled();
        fixture.state.originalActive = false;
        fixture.state.owners = [fixture.owner("normalCi")];
        fixture.parent.conclusion = "failure";
        await Promise.all([result, vi.advanceTimersByTimeAsync(100)]);
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }
      expect(fixture.client.rerunJob).toHaveBeenCalledExactlyOnceWith(1010);
      expect(fixture.client.getManualRetryAuthority).toHaveBeenCalledOnce();
    },
  );

  it.each(["missing", "duplicate"])(
    "refuses %s original ownership after completion",
    async (kind) => {
      const fixture = scenario();
      fixture.state.owners =
        kind === "missing" ? [] : [fixture.owner("normalCi"), fixture.owner("normalCi")];
      await expect(continueFailed(fixture.plan, "77", fixture.client)).rejects.toThrow(
        "automatic retry original owner is missing or ambiguous: normalCi",
      );
      expect(fixture.client.rerunFailed).not.toHaveBeenCalled();
      expect(fixture.client.getManualRetryAuthority).not.toHaveBeenCalled();
    },
  );

  it.each(["not-attempted", "rejected"] as const)(
    "admits attempt one only after the shared helper proves %s",
    async (outcome) => {
      const fixture = scenario();
      fixture.client.getManualRetryAuthority.mockResolvedValue({ outcome });
      await expect(continueFailed(fixture.plan, "77", fixture.client)).resolves.toMatchObject({
        reruns: [{ child: "normalCi", sourceRunAttempt: 1, runAttempt: 2 }],
      });
      expect(fixture.client.rerunFailed).toHaveBeenCalledExactlyOnceWith("101");
    },
  );

  it.each([false, true])(
    "holds unresolved receipts locally and provenance failures globally=%s",
    async (global) => {
      const fixture = scenario(true);
      fixture.client.getManualRetryAuthority.mockImplementation(async (_plan, key) => {
        if (key === "normalCi") {
          throw Object.assign(
            new Error("unresolved retry receipt"),
            global ? { code: "FRV_PARENT_PROVENANCE" } : {},
          );
        }
        return { outcome: "not-attempted" };
      });
      await expect(continueFailed(fixture.plan, "77", fixture.client)).rejects.toThrow(
        "unresolved retry receipt",
      );
      expect(fixture.client.rerunFailed.mock.calls).toEqual(global ? [] : [["202"]]);
      expect(fixture.client.rerunParent).not.toHaveBeenCalled();
    },
  );

  it("retries an eligible child while its sibling automatic owner is active", async () => {
    const fixture = scenario(true);
    fixture.state.originalActive = true;
    fixture.parent.conclusion = null;
    fixture.state.owners[1]!.status = "in_progress";
    fixture.client.rerunFailed.mockImplementation(async (id) => {
      expect(id).toBe("101");
      expect(fixture.state.owners[1]!.status).toBe("in_progress");
      fixture.childRuns.set("101", { attempt: 2, conclusion: "success" });
      fixture.childRuns.set("202", { attempt: 2, conclusion: "success" });
      fixture.state.owners[1]!.status = "completed";
      fixture.state.originalActive = false;
      fixture.parent.conclusion = "failure";
    });
    await expect(continueFailed(fixture.plan, "77", fixture.client)).resolves.toMatchObject({
      reruns: [{ child: "normalCi", runAttempt: 2 }],
    });
    expect(fixture.client.rerunFailed).toHaveBeenCalledExactlyOnceWith("101");
    expect(fixture.client.getManualRetryAuthority.mock.calls.map((call) => call[1])).toEqual([
      "normalCi",
    ]);
  });

  it("finishes delayed global owner admission before posting an undeclared sibling retry", async () => {
    const fixture = scenario(true);
    fixture.plan.knownFlakyJobs = ["normalCi:declared"];
    let signalOwnerRead!: () => void;
    const readingOwner = new Promise<void>((resolve) => {
      signalOwnerRead = resolve;
    });
    let allowOwnerRead!: () => void;
    const releaseOwner = new Promise<void>((resolve) => {
      allowOwnerRead = resolve;
    });
    const getRun = fixture.client.getRun;
    let parentReads = 0;
    fixture.client.getRun = async (id) => {
      if (id === "77" && ++parentReads === 2) {
        signalOwnerRead();
        await releaseOwner;
        fixture.state.parentSha = "f".repeat(40);
      }
      return getRun(id);
    };
    vi.useFakeTimers();
    try {
      const result = expect(
        continueFailed(fixture.plan, "77", fixture.client),
      ).rejects.toMatchObject({ code: "FRV_PARENT_PROVENANCE" });
      await readingOwner;
      await vi.advanceTimersByTimeAsync(0);
      const postsWhileOwnerPending = fixture.client.rerunFailed.mock.calls.length;
      allowOwnerRead();
      await result;
      expect(postsWhileOwnerPending).toBe(0);
      expect(fixture.client.rerunFailed).not.toHaveBeenCalled();
      expect(fixture.client.rerunParent).not.toHaveBeenCalled();
    } finally {
      allowOwnerRead();
      vi.useRealTimers();
    }
  });

  it("checks common parent provenance after all final child reads and before any POST", async () => {
    const fixture = scenario(true);
    fixture.plan.knownFlakyJobs = ["normalCi:declared"];
    const getRun = fixture.client.getRun;
    let siblingReads = 0;
    fixture.client.getRun = async (id) => {
      const run = await getRun(id);
      if (id === "202" && ++siblingReads === 3) {
        fixture.state.parentSha = "f".repeat(40);
      }
      return run;
    };
    await expect(continueFailed(fixture.plan, "77", fixture.client)).rejects.toMatchObject({
      code: "FRV_PARENT_PROVENANCE",
    });
    expect(fixture.client.rerunFailed).not.toHaveBeenCalled();
    expect(fixture.client.rerunParent).not.toHaveBeenCalled();
  });

  it("readmits a newer parent attempt before sending a retry admitted by its older owner", async () => {
    const fixture = scenario();
    const getRun = fixture.client.getRun;
    let childReads = 0;
    fixture.client.getRun = async (id) => {
      const run = await getRun(id);
      if (id === "101" && ++childReads === 3) {
        fixture.parent.attempt = 2;
        fixture.parent.conclusion = null;
        fixture.state.owners.push({ ...fixture.owner("normalCi", 2), status: "in_progress" });
      }
      return run;
    };
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_FRV_POLL_MS", "50");
    try {
      const result = expect(
        continueFailed(fixture.plan, "77", fixture.client, {
          operationDeadline: Date.now() + 200,
        }),
      ).resolves.toMatchObject({ action: "reran-parent" });
      await vi.advanceTimersByTimeAsync(25);
      const postsWhileNewOwnerActive = fixture.client.rerunFailed.mock.calls.length;
      fixture.state.owners[1]!.status = "completed";
      fixture.parent.conclusion = "failure";
      await Promise.all([result, vi.advanceTimersByTimeAsync(100)]);
      expect(postsWhileNewOwnerActive).toBe(0);
      expect(fixture.client.rerunFailed).toHaveBeenCalledExactlyOnceWith("101");
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("permits manual attempt three for a carried attempt-one job without repeating historical authority", async () => {
    const fixture = scenario();
    fixture.childRuns.set("101", { attempt: 2, conclusion: "failure" });
    const readJobs = fixture.client.getAttemptJobs;
    fixture.client.getAttemptJobs = async (id, attempt) =>
      attempt === 2
        ? [{ ...job("other", "success"), id: 1011, run_id: 101, run_attempt: 2 }]
        : readJobs(id, attempt);
    await expect(
      continueFailed(fixture.plan, "77", fixture.client, { job: "normalCi:test" }),
    ).resolves.toMatchObject({
      reruns: [{ sourceRunAttempt: 2, acceptedRunAttempt: 1, runAttempt: 3 }],
    });
    expect(fixture.client.getManualRetryAuthority).not.toHaveBeenCalled();
    expect(fixture.client.rerunJob).toHaveBeenCalledExactlyOnceWith(1010);
  });

  it.each(["parent", "owner"])(
    "rechecks live %s after awaited historical authority",
    async (changed) => {
      const fixture = scenario();
      fixture.client.getManualRetryAuthority.mockImplementation(async () => {
        if (changed === "parent") {
          fixture.state.parentSha = "f".repeat(40);
        } else {
          fixture.state.owners[0]!.status = "in_progress";
        }
        return { outcome: "not-attempted" };
      });
      vi.useFakeTimers();
      try {
        const result = expect(
          continueFailed(fixture.plan, "77", fixture.client, {
            operationDeadline: Date.now() + 100,
          }),
        ).rejects.toThrow(changed === "parent" ? "parent identity changed" : "timed out");
        await Promise.all([result, vi.advanceTimersByTimeAsync(200)]);
      } finally {
        vi.useRealTimers();
      }
      expect(fixture.client.rerunFailed).not.toHaveBeenCalled();
      expect(fixture.client.rerunParent).not.toHaveBeenCalled();
    },
  );
});

describe("FRV rerun API", () => {
  it("uses the direct failed-jobs and parent rerun endpoints", async () => {
    const calls: string[][] = [];
    const client = createClient(REPOSITORY, {
      mutate: async (args: string[]) => {
        calls.push(args);
      },
    });
    await client.rerunJob(1001);
    await client.rerunFailed("101");
    await client.rerunParent("77");
    expect(calls).toEqual([
      ["api", "-X", "POST", `repos/${REPOSITORY}/actions/jobs/1001/rerun`],
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
