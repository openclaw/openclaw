import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runBarnacleAutoResponse } from "../../scripts/github/barnacle-auto-response.mjs";
import { evaluatePullRequestContext } from "../../scripts/github/real-behavior-proof-policy.mjs";

type ManualPolicy =
  | { mode: "absent" }
  | { mode: "isolated per-run" | "same-SHA cancels" | "same-ref queues"; group: string };

type WorkflowPolicy = {
  file: string;
  prGroup: string;
  manual: ManualPolicy;
  manualAdmission?: string;
  push?: { group: string; cancel: boolean };
  convertToDraft?: true;
};
const fixtureSha = "a".repeat(40);
const workflowPath = (name: string) => `.github/workflows/${name}.yml`;
const WORKFLOWS: WorkflowPolicy[] = [
  ...[
    ["ci-check-testbox", "Blacksmith Testbox"],
    ["ci-check-arm-testbox", "Blacksmith ARM Testbox"],
    ["ci-build-artifacts-testbox", "Blacksmith Build Artifacts Testbox"],
  ].map(([name, label]) => ({
    file: workflowPath(name!),
    prGroup: `${label}-pr-v1-123`,
    manual: { mode: "isolated per-run" as const, group: `${label}-manual-v1-201` },
    manualAdmission: "admission",
  })),
  ...[
    ["ios-periphery", "ios-periphery-iOS Periphery Dead Code"],
    ["macos-periphery", "macos-periphery-macOS Periphery Dead Code"],
    ["shared-openclawkit-periphery", "shared-openclawkit-periphery"],
    ["linux-app", "linux-app-Linux App"],
    ["node-runtime-conformance", "node-runtime-conformance", "-pull_request", "-workflow_dispatch"],
  ].map(([name, prefix, prSuffix = "", manualSuffix = ""]) => ({
    file: workflowPath(name!),
    prGroup: `${prefix}${prSuffix}-123`,
    convertToDraft: true as const,
    manual: { mode: "same-SHA cancels" as const, group: `${prefix}${manualSuffix}-${fixtureSha}` },
  })),
  {
    file: workflowPath("website-installer-sync"),
    prGroup: "website-installer-sync-refs/pull/123/merge",
    convertToDraft: true,
    manual: { mode: "isolated per-run", group: "website-installer-sync-201" },
    manualAdmission: "sync-website",
  },
  {
    file: workflowPath("opengrep-precise"),
    prGroup: "opengrep-pr-diff-OpenGrep — PR Diff-123",
    manual: { mode: "absent" },
  },
  ...(
    [
      ["sandbox-common-smoke", "Sandbox Common Smoke", "-workflow_dispatch", true],
      ["plugin-init-scaffold-validation", "Plugin Init Scaffold Validation", "", false],
    ] as const
  ).map(([name, label, suffix, cancel]) => ({
    file: workflowPath(name),
    prGroup: `${label}-123`,
    manual: { mode: "same-ref queues" as const, group: `${label}${suffix}-refs/heads/main` },
    push: { group: `${label}-push-refs/heads/main`, cancel },
    convertToDraft: cancel ? (true as const) : undefined,
  })),
];

type Job = {
  if?: string | boolean;
  concurrency?: Concurrency;
  outputs?: Record<string, string>;
  steps: {
    if?: string;
    uses?: string;
    env?: Record<string, string>;
    with?: { script?: string };
  }[];
};
type Concurrency = { group: string; "cancel-in-progress": string | boolean };
type Workflow = {
  name: string;
  on: Partial<Record<"pull_request" | "pull_request_target" | "issues", { types: string[] }>> & {
    workflow_dispatch?: unknown;
    schedule?: unknown;
    push?: { branches: string[] };
  };
  concurrency?: Concurrency;
  jobs: Record<string, Job>;
};
type GithubEvent = {
  action?: string;
  pull_request?: {
    number: number;
    draft: boolean;
    head: { sha: string };
    user?: { login?: string; type?: string };
    author_association?: string;
  };
  issue?: { number: number; author_association?: string };
  changes?: Record<string, unknown>;
};
type Github = {
  workflow: string;
  repository: string;
  event_name: keyof Workflow["on"];
  run_id: number;
  sha: string;
  ref: string;
  event: GithubEvent;
  actor?: string;
};

function pr(
  workflow: Workflow,
  runId: number,
  action: string,
  draft = false,
  head = "a",
  number = 123,
): Github {
  return {
    ...refEvent(workflow, "workflow_dispatch", runId, "e", `refs/pull/${number}/merge`),
    event_name: "pull_request",
    event: { action, pull_request: { number, draft, head: { sha: head.repeat(40) } } },
  };
}

function targetEvent(
  workflow: Workflow,
  runId: number,
  action: string,
  changes?: Github["event"]["changes"],
  draft = false,
): Github {
  const github = pr(workflow, runId, action, draft);
  github.event_name = "pull_request_target";
  github.actor = "contributor";
  github.event.changes = changes;
  Object.assign(github.event.pull_request!, {
    user: { login: "contributor", type: "User" },
    author_association: "NONE",
  });
  return github;
}

function refEvent(
  workflow: Workflow,
  eventName: keyof Workflow["on"],
  runId: number,
  sha = "a",
  ref = "refs/heads/main",
): Github {
  const event: GithubEvent = {};
  return {
    workflow: workflow.name,
    repository: "openclaw/openclaw",
    event_name: eventName,
    run_id: runId,
    sha: sha.repeat(40),
    ref,
    event,
    actor: undefined,
  };
}

function subscribes(workflow: Workflow, github: Github): boolean {
  if (
    github.event_name === "pull_request" ||
    github.event_name === "pull_request_target" ||
    github.event_name === "issues"
  ) {
    return workflow.on[github.event_name]?.types.includes(github.event.action!) ?? false;
  }
  if (github.event_name === "push") {
    return workflow.on.push?.branches.includes(github.ref.replace(/^refs\/heads\//u, "")) ?? false;
  }
  return Object.hasOwn(workflow.on, github.event_name);
}

function workflowConcurrency(workflow: Workflow): Concurrency {
  if (!workflow.concurrency) {
    throw new Error("Expected workflow-level concurrency");
  }
  return workflow.concurrency;
}

const readWorkflow = (file: string) => parse(readFileSync(file, "utf8")) as Workflow;
type Admission = Awaited<ReturnType<typeof admission>>;
const groupsOf = (runs: Admission[]) => runs.map(({ group }) => group);
const cancellations = (runs: Admission[]) => runs.map(({ cancel }) => cancel);
const uniqueGroups = (values: string[]) => new Set(values.map((group) => group.toLowerCase())).size;
const nonScopeJobs = (result: Admission) =>
  Object.entries(result.eligibility.jobs).filter(([id]) => id !== "scope");
const evaluateRecord = (values: Record<string, string>, context: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, evaluate(value, context)]));

function expectPolicies(runs: Admission[], group: string, cancel: boolean) {
  for (const run of runs) {
    expect(run).toMatchObject({ group, cancel });
  }
}

function expectRejected(run: Admission) {
  expect(run.group).toBe("");
  expect(Object.values(run.eligibility.jobs).every((eligible) => !eligible)).toBe(true);
}

// Evaluate the fixtures' Actions subset; missing properties are empty strings.
// Fixtures avoid JS/Actions coercion differences; admission folds group case.
function expression(source: string, context: Record<string, unknown>): unknown {
  return runInNewContext(
    source.replace(
      /\b(?:github|needs|steps|vars|inputs)(?:\.[A-Za-z_][\w-]*)+/gu,
      (reference) => `lookup(${JSON.stringify(reference)})`,
    ),
    {
      lookup: (reference: string) =>
        reference
          .split(".")
          .reduce<unknown>(
            (value, key) =>
              value !== null && typeof value === "object"
                ? ((value as Record<string, unknown>)[key] ?? "")
                : "",
            context,
          ),
      format: (template: string, ...values: unknown[]) =>
        template.replace(/\{(\d+)\}/gu, (_match, index: string) => String(values[Number(index)])),
      always: () => true,
      cancelled: () => context.cancelled === true,
      fromJSON: JSON.parse,
      contains: (values: string[], value: string) =>
        values.some((item) => item.toLowerCase() === value.toLowerCase()),
      startsWith: (value: string, prefix: string) =>
        value.toLowerCase().startsWith(prefix.toLowerCase()),
      endsWith: (value: string, suffix: string) =>
        value.toLowerCase().endsWith(suffix.toLowerCase()),
    },
  );
}

function evaluate(
  value: string | boolean,
  context: Record<string, unknown>,
  implicitIf = false,
): unknown {
  if (typeof value === "boolean") {
    return value;
  }
  const part = /\$\{\{([\s\S]*?)\}\}/u.exec(value);
  if (!part) {
    return implicitIf ? expression(value, context) : value;
  }
  const source = part[1];
  if (part[0] === value.trim() && source !== undefined) {
    return expression(source, context);
  }
  return value.replace(/\$\{\{([\s\S]*?)\}\}/gu, (_match, body: string) =>
    String(expression(body, context)),
  );
}

async function eligibleJobs(workflow: Workflow, github: Github, vars: Record<string, string> = {}) {
  const jobs: Record<string, boolean> = {};
  const needs: Record<string, { outputs: Record<string, unknown>; result: string }> = {};
  let diffCalls = 0;
  let checkouts = 0;
  const scope = workflow.jobs.scope;
  if (scope) {
    const context = { github, needs, vars, steps: { checkout: { outcome: "success" } } };
    jobs.scope = Boolean(evaluate(scope.if ?? true, context, true));
    const outputs: Record<string, string> = {};
    if (jobs.scope) {
      for (const step of scope.steps) {
        if (!evaluate(step.if ?? true, context, true)) {
          continue;
        }
        if (step.uses?.startsWith("actions/checkout@")) {
          checkouts++;
        }
        if (step.uses === "./.github/actions/detect-scheduled-changes") {
          // Admission ordering uses changed inputs; the cost suite owns proof-reuse decisions.
          outputs.changed = "true";
        }
        if (!step.with?.script) {
          continue;
        }
        await runInNewContext(`(async () => {\n${step.with.script}\n})()`, {
          require: createRequire(import.meta.url),
          context: { eventName: github.event_name, payload: github.event },
          process: { env: evaluateRecord(step.env ?? {}, context) },
          core: {
            info() {},
            warning() {},
            setOutput: (key: string, value: string) => {
              outputs[key] = value;
            },
          },
          exec: {
            getExecOutput: async (command: string, args: string[]) => {
              expect(command).toBe("git");
              expect(args.filter((arg) => arg !== "--no-renames").slice(0, 5)).toEqual(
                "diff --quiet HEAD^1 HEAD --".split(" "),
              );
              diffCalls++;
              return { exitCode: 1 }; // A scoped change; path selection has its own suite.
            },
          },
        });
      }
    }
    needs.scope = {
      outputs: evaluateRecord(scope.outputs ?? {}, { steps: { scope: { outputs } } }),
      result: jobs.scope ? "success" : "skipped",
    };
  }
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id === "scope") {
      continue;
    }
    jobs[id] = Boolean(evaluate(job.if ?? true, { github, needs, vars }, true));
    needs[id] = { outputs: {}, result: jobs[id] ? "success" : "skipped" };
  }
  return { jobs, diffCalls, checkouts };
}

// Observe the workflow-owned inputs to GitHub admission; GitHub owns queue scheduling.
async function admission(workflow: Workflow, github: Github, vars: Record<string, string> = {}) {
  expect(subscribes(workflow, github), `${workflow.name}: ${github.event_name}`).toBe(true);
  const eligibility = await eligibleJobs(workflow, github, vars);
  let policy = workflow.concurrency;
  if (!policy) {
    const admitted = Object.entries(workflow.jobs).filter(([id]) => eligibility.jobs[id]);
    if (!admitted.length) {
      return { group: "", cancel: false, eligibility };
    }
    expect(admitted).toHaveLength(1);
    policy = admitted[0]?.[1].concurrency;
  }
  if (!policy) {
    throw new Error("Expected concurrency on the workflow or its admitted job");
  }
  return {
    group: String(evaluate(policy.group, { github })),
    cancel: Boolean(evaluate(policy["cancel-in-progress"], { github })),
    eligibility,
  };
}

function expectDraftSkipped(result: Admission) {
  for (const [id, eligible] of nonScopeJobs(result)) {
    expect(eligible, id).toBe(false);
  }
  expect(result.eligibility).toMatchObject({ diffCalls: 0, checkouts: 0 });
}

function expectUseful(...results: Admission[]) {
  for (const result of results) {
    expect(nonScopeJobs(result).some(([, eligible]) => eligible)).toBe(true);
  }
}

describe.each(WORKFLOWS)("ancillary admission: $file", (policy) => {
  const { file, prGroup, manual, push, convertToDraft } = policy;
  const workflow = readWorkflow(file);

  it("admits useful and intentional draft changes together while isolating passive drafts and other PRs", async () => {
    const ready = await admission(workflow, pr(workflow, 100, "ready_for_review"));
    const newer = await admission(workflow, pr(workflow, 101, "synchronize", false, "b"));
    const other = await admission(workflow, pr(workflow, 102, "opened", false, "a", 124));
    expectPolicies([ready, newer], prGroup, true);
    expect(other.cancel).toBe(true);
    expect(other.group).not.toBe(prGroup);
    expectUseful(ready, newer, other);
    for (const [id, eligible] of nonScopeJobs(ready)) {
      expect(eligible, id).toBe(id !== policy.manualAdmission);
    }
    const passiveGroups: string[] = [];
    for (const [index, action] of [
      "opened",
      "opened",
      "reopened",
      "synchronize",
      ...(convertToDraft ? ["converted_to_draft"] : []),
    ].entries()) {
      const draft = await admission(workflow, pr(workflow, 103 + index, action, true));
      expectDraftSkipped(draft);
      if (action === "converted_to_draft") {
        expectPolicies([draft], prGroup, true);
      } else {
        passiveGroups.push(draft.group);
      }
    }
    expect(uniqueGroups([prGroup, other.group, ...passiveGroups])).toBe(6);
  });

  it(`retains the manual contract: ${manual.mode}`, async () => {
    expect(Object.hasOwn(workflow.on, "workflow_dispatch")).toBe(manual.mode !== "absent");
    if (manual.mode === "absent") {
      return;
    }
    const runs = await Promise.all([
      admission(workflow, refEvent(workflow, "workflow_dispatch", 201)),
      admission(workflow, refEvent(workflow, "workflow_dispatch", 202)),
      admission(workflow, refEvent(workflow, "workflow_dispatch", 203, "b")),
      admission(workflow, refEvent(workflow, "workflow_dispatch", 204, "a", "refs/heads/release")),
    ]);
    expect(runs[0]!.group).toBe(manual.group);
    expectUseful(...runs);
    expect(runs.every(({ group }) => group !== prGroup)).toBe(true);
    expect(cancellations(runs)).toEqual(Array(4).fill(manual.mode === "same-SHA cancels"));
    if (manual.mode === "same-ref queues") {
      expect(groupsOf(runs.slice(0, 3))).toEqual(Array(3).fill(manual.group));
      expect(runs[3]!.group).toBe(manual.group.replace("refs/heads/main", "refs/heads/release"));
    } else {
      expect(runs[1]!.group === runs[0]!.group).toBe(manual.mode === "same-SHA cancels");
      expect(runs[2]!.group).not.toBe(runs[0]!.group);
      expect(uniqueGroups(groupsOf(runs.slice(0, 3)))).toBe(
        manual.mode === "same-SHA cancels" ? 2 : 3,
      );
    }
  });

  if (push) {
    it("isolates push admission from PR, hourly and manual work", async () => {
      const vars = { OPENCLAW_CI_ON_PUSH: "true" };
      const enabled = await admission(workflow, refEvent(workflow, "push", 201), vars);
      const newer = await admission(workflow, refEvent(workflow, "push", 202, "b"), vars);
      expectPolicies([enabled, newer], push.group, push.cancel);
      const hourly = await admission(workflow, refEvent(workflow, "schedule", 203));
      const laterHourly = await admission(workflow, refEvent(workflow, "schedule", 206, "b"));
      const manualRun = await admission(workflow, refEvent(workflow, "workflow_dispatch", 204));
      const skipped = await admission(workflow, refEvent(workflow, "push", 205, "c"));
      expect(uniqueGroups([prGroup, ...groupsOf([enabled, hourly, manualRun])])).toBe(4);
      expect(skipped.group).toBe(enabled.group);
      expectUseful(enabled, newer, hourly, laterHourly, manualRun);
      expect(laterHourly.group).toBe(hourly.group);
      expect([hourly.cancel, laterHourly.cancel, manualRun.cancel]).toEqual([false, false, false]);
      expect(nonScopeJobs(skipped).every(([, eligible]) => !eligible)).toBe(true);
    });
  }
});

it("honors cancellation after a schedule-only scope job is skipped", () => {
  const workflow = readWorkflow(workflowPath("plugin-init-scaffold-validation"));
  const guard = workflow.jobs["validate-provider-scaffold"]!.if!;
  const context = {
    github: pr(workflow, 100, "ready_for_review"),
    needs: { scope: { result: "skipped", outputs: {} } },
    vars: {},
  };
  expect(evaluate(guard, { ...context, cancelled: false }, true)).toBe(true);
  expect(evaluate(guard, { ...context, cancelled: true }, true)).toBe(false);
});

describe("Labeler admission", () => {
  const workflow = readWorkflow(workflowPath("labeler"));
  const bodyChange = { body: { from: "Previous description" } };
  function event(
    runId: number,
    action: string,
    changes?: Github["event"]["changes"],
    draft = false,
  ): Github {
    return { ...targetEvent(workflow, runId, action, changes, draft), ref: "refs/heads/main" };
  }

  it.each([
    { action: "opened", changes: undefined },
    { action: "edited", changes: { title: { from: "old" } } },
    { action: "edited", changes: { base: { ref: { from: "old" } } } },
  ])("admits $action/$changes but rejects irrelevant edits", async ({ action, changes }) => {
    const useful = await admission(workflow, event(100, action, changes, true));
    expect(useful).toMatchObject({
      group: "Labeler-123",
      cancel: true,
      eligibility: { jobs: { label: true } },
    });
    for (const ignored of [bodyChange, undefined]) {
      const rejected = await admission(workflow, event(101, "edited", ignored));
      expectRejected(rejected);
    }
  });

  it("retains a non-cancelling manual ref group", async () => {
    const active = await admission(workflow, {
      ...refEvent(workflow, "workflow_dispatch", 200),
      event: { action: "edited" },
    });
    const repeated = await admission(workflow, refEvent(workflow, "workflow_dispatch", 201));
    expectPolicies([active, repeated], "Labeler-refs/heads/main", false);
    expectUseful(active, repeated);
  });

  it("isolates issues and coalesces title edits without admitting body-only edits", async () => {
    const issue = (
      number: number,
      runId: number,
      changes?: Github["event"]["changes"],
    ): Github => ({
      ...refEvent(workflow, "workflow_dispatch", runId),
      event_name: "issues",
      event: { action: changes ? "edited" : "opened", issue: { number }, changes },
    });
    const first = await admission(workflow, issue(1, 100));
    const other = await admission(workflow, issue(2, 101));
    const edited = await admission(workflow, issue(1, 102, { title: { from: "Old title" } }));
    const body = await admission(workflow, issue(1, 103, bodyChange));
    expect([first.group, other.group, edited.group, body.group]).toEqual([
      "Labeler-issue-1",
      "Labeler-issue-2",
      "Labeler-issue-1",
      "",
    ]);
    expect([first.cancel, other.cancel, edited.cancel]).toEqual([true, true, true]);
    expectUseful(first, other, edited);
    expect(Object.values(body.eligibility.jobs).every((eligible) => !eligible)).toBe(true);
  });
});

describe("PR context admission", () => {
  const workflow = readWorkflow(workflowPath("real-behavior-proof"));
  const event = (runId: number, action: string, changes?: Github["event"]["changes"]) =>
    targetEvent(workflow, runId, action, changes);

  it.each([
    ["contributor", "User", "NONE"],
    ["contributor", "User", "FIRST_TIMER"],
    ["maintainer", "User", "OWNER"],
    ["maintainer", "User", "MEMBER"],
    ["contributor", "User", "COLLABORATOR"],
    ["automation", "Bot", "NONE"],
    ["automation[bot]", "User", "NONE"],
    ["app/automation", "User", "NONE"],
  ])("matches the owner exemption for %s/%s/%s", async (login, type, association) => {
    const github = event(100, "opened");
    const pullRequest = {
      ...github.event.pull_request!,
      user: { login, type },
      author_association: association,
    };
    github.event.pull_request = pullRequest;
    expect((await eligibleJobs(workflow, github)).jobs["real-behavior-proof"]).toBe(
      evaluatePullRequestContext({ pullRequest }).applies,
    );
  });

  it("replaces body validation without allowing a skipped title edit into its group", async () => {
    const old = await admission(workflow, event(100, "opened"));
    const latest = await admission(workflow, event(101, "edited", { body: { from: "old" } }));
    const irrelevant = await admission(workflow, event(102, "edited", { title: { from: "old" } }));
    expect(old.group).toBe(latest.group);
    expect([old.cancel, latest.cancel]).toEqual([true, true]);
    expectUseful(old, latest);
    expect(irrelevant.group).toBe("");
    expect(irrelevant.eligibility.jobs["real-behavior-proof"]).toBe(false);
  });
});

describe("Auto response admission", () => {
  const workflow = readWorkflow(workflowPath("auto-response"));
  const event = (runId: number, action: string, changes?: Github["event"]["changes"]) =>
    targetEvent(workflow, runId, action, changes);

  it.each(["OWNER", "MEMBER", "COLLABORATOR"])(
    "rejects the owner's known %s exemption before allocation",
    async (association) => {
      for (const eventName of ["issues", "pull_request_target"] as const) {
        const github = event(100, "opened");
        github.event_name = eventName;
        github.event =
          eventName === "issues"
            ? { action: "opened", issue: { number: 123, author_association: association } }
            : {
                ...github.event,
                pull_request: { ...github.event.pull_request!, author_association: association },
              };
        expect((await eligibleJobs(workflow, github)).jobs["auto-response"]).toBe(false);
        await expect(
          runBarnacleAutoResponse({
            github: {},
            context: { payload: github.event },
            core: { info() {} },
          }),
        ).resolves.toBeUndefined();
      }
    },
  );

  it.each(["title", "body", "base"])(
    "admits edited %s inputs without losing relevant label events to unrelated edits",
    async (field) => {
      const useful = await admission(workflow, event(100, "edited", { [field]: { from: "old" } }));
      const pending = await admission(workflow, event(101, "synchronize"));
      const irrelevant = await admission(
        workflow,
        event(102, "edited", { maintainer_can_modify: { from: false } }),
      );
      expect(useful.eligibility.jobs["auto-response"]).toBe(true);
      expect(useful.group).toBe(pending.group);
      expect(pending.cancel).toBe(true);
      expectUseful(pending);
      expect(irrelevant.group).toBe("");
      for (const action of ["labeled", "unlabeled"]) {
        expect((await eligibleJobs(workflow, event(103, action))).jobs["auto-response"]).toBe(true);
      }
    },
  );
});

it("isolates supported useful, passive, manual and push events across the tracked workflows", () => {
  for (const event of ["ready_for_review", "opened", "workflow_dispatch", "push"] as const) {
    const groups = WORKFLOWS.flatMap(({ file }) => {
      const workflow = readWorkflow(file);
      const github =
        event === "workflow_dispatch" || event === "push"
          ? refEvent(workflow, event, 201)
          : pr(workflow, 101, event, event === "opened");
      return subscribes(workflow, github)
        ? [String(evaluate(workflowConcurrency(workflow).group, { github })).toLowerCase()]
        : [];
    });
    expect(new Set(groups).size).toBe(groups.length);
  }
});
