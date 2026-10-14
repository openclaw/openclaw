import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compileFunction, constants } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { inspectReadiness, readinessLabel } from "../../scripts/ci-readiness.mjs";
import { evaluateWorkflowCondition } from "./ci-workflow.test-support.js";

const repository = "openclaw/openclaw";
const base = "b".repeat(40);
const testedSha = "c".repeat(40);
const policy = { version: 1, mode: "canary", pullRequests: [42] };
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const publishedDriver = parse(
  readFileSync(".github/workflows/ci-published-driver-update.yml", "utf8"),
);
const require = createRequire(import.meta.url);
const bootstrapFiles = new Set([
  ".github/ci-readiness.json",
  "scripts/ci-readiness.mjs",
  "scripts/lib/plain-gh.mjs",
  "scripts/pr-lib/gh-api-preflight.mjs",
  "scripts/lib/direct-run.mjs",
]);
type BootstrapStep = {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: { script?: string };
  "continue-on-error"?: boolean;
};
type Admission = { enforced: string; request_id?: string };

const generatedEntries = Object.entries(workflow.jobs)
  .filter(
    ([id]) =>
      ![
        "readiness",
        "security-fast",
        "ios-release-e2e",
        "ci-gate",
        "seal_release_child_evidence",
        "pr-failure-report",
        "published-driver-update",
      ].includes(id),
  )
  .map(([id]) => id);
const workEntries = [...generatedEntries, "published-driver-update"];
function workSteps(id: string): BootstrapStep[] {
  return id === "published-driver-update"
    ? publishedDriver.jobs.update.steps
    : workflow.jobs[id].steps;
}

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const pr = {
    number: 42,
    state: "open",
    draft: false,
    merge_commit_sha: testedSha,
    head: { sha: "a".repeat(40), ref: "feature", repo: { full_name: repository } },
    base: { sha: base, ref: "main", repo: { full_name: repository } },
    labels: [] as { name: string }[],
  };
  const label = readinessLabel(pr, policy);
  pr.labels.push({ name: label });
  const event = {
    action: "labeled",
    label: { name: label },
    sender: { login: "maintainer", id: 7 },
    pull_request: structuredClone(pr),
  };
  const ledger = [{ id: 101, event: "labeled", label: { name: label }, actor: event.sender }];
  const access = { permission: "write", user: { id: 7 } };
  const api = vi.fn(async (path: string): Promise<unknown> => {
    if (path.endsWith("/pulls/42")) {
      return structuredClone(pr);
    }
    if (path.includes("/events?")) {
      return structuredClone(ledger);
    }
    if (path.endsWith("/permission")) {
      return structuredClone(access);
    }
    if (path.includes("/compare/")) {
      return { status: "ahead", merge_base_commit: { sha: base } };
    }
    throw new Error("Unexpected API: " + path);
  });
  const github = {
    request: vi.fn(async (route: string) => {
      expect(route.startsWith("GET /")).toBe(true);
      return { data: await api(route.slice(5)) };
    }),
    rest: {
      repos: {
        getContent: vi.fn(
          async (input: { owner: string; repo: string; path: string; ref: string }) => {
            expect(input).toMatchObject({ owner: "openclaw", repo: "openclaw", ref: base });
            expect(bootstrapFiles.has(input.path)).toBe(true);
            const content =
              input.path === ".github/ci-readiness.json"
                ? JSON.stringify(policy)
                : readFileSync(input.path, "utf8");
            return {
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from(content).toString("base64"),
              },
            };
          },
        ),
      },
    },
  };
  return { pr, event, ledger, access, api, github };
}
function admit(f: ReturnType<typeof fixture>) {
  return inspectReadiness({ api: f.api, repository, event: f.event, policy, testedSha });
}
async function executeBootstrap(
  f: ReturnType<typeof fixture>,
  step: BootstrapStep,
  admission: Admission,
  options: { attempt?: string; admittedAttempt?: string; eventName?: string } = {},
) {
  vi.stubEnv("GITHUB_RUN_ATTEMPT", options.attempt ?? "1");
  vi.stubEnv("GITHUB_TRIGGERING_ACTOR", "maintainer");
  vi.stubEnv("READINESS_ENFORCED", admission.enforced);
  vi.stubEnv("READINESS_REQUEST_ID", admission.request_id ?? "");
  vi.stubEnv("READINESS_ATTEMPT", options.admittedAttempt ?? "1");
  vi.stubEnv("READINESS_PHASE", step.env?.READINESS_PHASE ?? "");
  const script = step.with?.script;
  if (typeof script !== "string") {
    throw new Error("Workflow bootstrap script missing");
  }
  // Vitest uses a VM; load immutable base modules through the native ESM loader.
  const execute = compileFunction(
    "return (async () => {\n" + script + "\n})();",
    ["github", "context", "core", "require", "process"],
    {
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    },
  );
  await execute(
    f.github,
    {
      eventName: options.eventName ?? "pull_request",
      payload: f.event,
      sha: testedSha,
      repo: { owner: "openclaw", repo: "openclaw" },
    },
    { info: vi.fn() },
    require,
    process,
  );
}
async function startBuild(f: ReturnType<typeof fixture>, admission: Admission) {
  const job = workflow.jobs["build-artifacts"];
  expect(
    evaluateWorkflowCondition(job.if, {
      eventName: "pull_request",
      repository,
      runAttempt: 1,
      preflightOutputs: {
        run_build_artifacts: "true",
        readiness_enforced: admission.enforced,
        readiness_attempt: "1",
      },
    }),
  ).toBe(true);
  const effects: string[] = [];
  let failure: unknown;
  for (const step of workSteps("build-artifacts")) {
    if (step.name === "Verify CI readiness before work") {
      try {
        await executeBootstrap(f, step, admission);
      } catch (error) {
        failure = error;
      }
    }
    if (step.name === "Setup Node environment") {
      expect(step.if).toBeUndefined();
      if (!failure) {
        effects.push("dependency setup");
      }
      break;
    }
  }
  return { effects, failure };
}
function guard(id = "build-artifacts") {
  const step = workSteps(id).find((candidate) => candidate.id === "readiness_work_start");
  if (!step) {
    throw new Error("Missing work-start authority for " + id);
  }
  return step;
}

describe("queued CI work-start authority", () => {
  it.each(["write", "read"])(
    "rechecks %s permission after admission and before dependency setup",
    async (permission) => {
      const f = fixture();
      const admission = await admit(f);
      expect(admission).toMatchObject({ broad_ci: "true", enforced: "true", request_id: "101" });
      f.access.permission = permission;
      const execution = await startBuild(f, admission);
      expect(execution.effects).toEqual(permission === "write" ? ["dependency setup"] : []);
      if (permission === "read") {
        expect(String(execution.failure)).toContain("no longer has repository write permission");
      } else {
        expect(execution.failure).toBeUndefined();
      }
    },
  );
  it.each(workEntries)(
    "%s revalidates its own queued start with immutable base code",
    async (id) => {
      const f = fixture();
      const admission = await admit(f);
      f.access.permission = "read";
      const step = guard(id);
      expect(step.env?.READINESS_PHASE).toBe("work-start");
      expect(step["continue-on-error"]).toBeUndefined();
      await expect(executeBootstrap(f, step, admission)).rejects.toThrow(
        "no longer has repository write permission",
      );
      expect(f.github.rest.repos.getContent).toHaveBeenCalledTimes(bootstrapFiles.size);
    },
  );
  it("covers preflight, every workload, and the reusable callee without counting diagnostics as work", () => {
    expect(generatedEntries).toHaveLength(35);
    expect(workEntries).toHaveLength(36);
    expect(workEntries).toContain("postgres-conformance");
    expect(workEntries).not.toContain("pr-failure-report");
    for (const id of workEntries) {
      const steps = workSteps(id);
      const at = steps.findIndex((step) => step.id === "readiness_work_start");
      expect(at, id).toBeGreaterThan(0);
      expect(
        steps[at - 1].name === "Checkout" || steps[at - 1].uses?.startsWith("actions/checkout@"),
        id,
      ).toBe(true);
    }
    expect(guard("published-driver-update").with?.script).toBe(guard().with?.script);
  });
  it.each(["request", "lifecycle", "base", "tested-merge", "unavailable"])(
    "rejects %s changes after admission",
    async (change) => {
      const f = fixture();
      const admission = await admit(f);
      if (change === "request") {
        f.ledger.push({ ...f.ledger[0], id: 102 });
      }
      if (change === "lifecycle") {
        f.ledger.push({ ...f.ledger[0], id: 102, event: "unlabeled" });
      }
      if (change === "base") {
        f.pr.base.sha = "d".repeat(40);
      }
      if (change === "tested-merge") {
        f.pr.merge_commit_sha = "e".repeat(40);
      }
      if (change === "unavailable") {
        const original = f.api.getMockImplementation()!;
        f.api.mockImplementation(async (path) => {
          if (path.endsWith("/permission")) {
            throw new Error("Authority unavailable");
          }
          return original(path);
        });
      }
      const execution = await startBuild(f, admission);
      expect(execution.effects).toEqual([]);
      expect(execution.failure).toBeDefined();
    },
  );
  it.each(["request", "attempt", "stale-attempt", "enforcement"])(
    "fails closed on a missing or stale %s binding",
    async (missing) => {
      const f = fixture();
      const admission = await admit(f);
      if (missing === "request") {
        admission.request_id = "";
      }
      if (missing === "enforcement") {
        admission.enforced = "";
      }
      await expect(
        executeBootstrap(f, guard(), admission, {
          admittedAttempt: missing === "attempt" ? "" : "1",
          attempt: missing === "stale-attempt" ? "2" : "1",
        }),
      ).rejects.toThrow();
    },
  );
  it("preserves published-driver PR callers with omitted optional readiness inputs", async () => {
    const f = fixture();
    const defaults = publishedDriver.on.workflow_call.inputs;
    await expect(
      executeBootstrap(
        f,
        guard("published-driver-update"),
        {
          enforced: defaults.readiness_enforced.default,
          request_id: defaults.readiness_request_id.default,
        },
        { admittedAttempt: defaults.readiness_attempt.default },
      ),
    ).resolves.toBeUndefined();
    expect(f.github.request).not.toHaveBeenCalled();
    expect(f.github.rest.repos.getContent).not.toHaveBeenCalled();
  });
  it.each(["enforcement", "request", "attempt"])(
    "rejects an explicit published-driver PR caller with a missing %s binding",
    async (missing) => {
      const f = fixture();
      const admission = await admit(f);
      const defaults = publishedDriver.on.workflow_call.inputs;
      if (missing === "enforcement") {
        admission.enforced = "";
      }
      if (missing === "request") {
        admission.request_id = defaults.readiness_request_id.default;
      }
      await expect(
        executeBootstrap(f, guard("published-driver-update"), admission, {
          admittedAttempt: missing === "attempt" ? defaults.readiness_attempt.default : "1",
        }),
      ).rejects.toThrow();
    },
  );
  it("does not fall back to candidate code when immutable source is unavailable", async () => {
    const f = fixture();
    const admission = await admit(f);
    f.github.rest.repos.getContent.mockRejectedValue(new Error("Base source unavailable"));
    const execution = await startBuild(f, admission);
    expect(execution.effects).toEqual([]);
    expect(String(execution.failure)).toContain("Base source unavailable");
  });
  it.each(["off", "workflow_dispatch", "push"])(
    "preserves %s execution without readiness API calls",
    async (mode) => {
      const f = fixture();
      const admission =
        mode === "off"
          ? await inspectReadiness({
              api: f.api,
              repository,
              event: f.event,
              policy: { version: 1, mode: "off", pullRequests: [] },
              testedSha,
            })
          : { enforced: "" };
      await expect(
        executeBootstrap(f, guard(), admission, {
          eventName: mode === "off" ? "pull_request" : mode,
        }),
      ).resolves.toBeUndefined();
      expect(f.github.request).not.toHaveBeenCalled();
      expect(f.github.rest.repos.getContent).not.toHaveBeenCalled();
    },
  );
  it.each(["ci-gate", "pr-failure-report"])(
    "%s permits only result-phase forward-base tolerance and still rejects revoked authority",
    async (id) => {
      const f = fixture();
      const admission = await admit(f);
      f.pr.base.sha = "d".repeat(40);
      f.pr.merge_commit_sha = "e".repeat(40);
      const result = workflow.jobs[id].steps.find(
        (step: BootstrapStep) => step.id === "readiness_result",
      );
      expect(result.env.READINESS_PHASE).toBe("result");
      await expect(executeBootstrap(f, guard(), admission)).rejects.toThrow("superseded");
      await expect(executeBootstrap(f, result, admission)).resolves.toBeUndefined();
      f.access.permission = "read";
      await expect(executeBootstrap(f, result, admission)).rejects.toThrow(
        "no longer has repository write permission",
      );
    },
  );
  it.each(["success", "failure", "skipped"] as const)(
    "independent central lint continues after ordinary failures only with %s authorization",
    (outcome) => {
      const step = workflow.jobs["check-lint-hosted-core-shard"].steps.find(
        (candidate: BootstrapStep) => candidate.name === "Run shared central lint",
      );
      expect(
        Boolean(
          evaluateWorkflowCondition(step.if, {
            eventName: "pull_request",
            repository,
            runAttempt: 1,
            failed: true,
            matrix: { shared_central_lint_selection_json: "fixture-selection" },
            steps: { readiness_work_start: { outputs: {}, outcome } },
          }),
        ),
      ).toBe(outcome === "success");
    },
  );
});
