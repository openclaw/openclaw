import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  readWorkflow,
} from "./ci-workflow.test-support.js";

const auxiliaryNames = [
  "node-runtime-conformance",
  "plugin-init-scaffold-validation",
  "sandbox-common-smoke",
  "vitest-cache-warm",
  "plugin-npm-release",
];
const ci = readCiWorkflow();
const base = { repository: "openclaw/openclaw", runAttempt: 1, releasePriorityRun: "123" } as const;
type Context = Parameters<typeof evaluateWorkflowExpression>[1];

function evaluate(expression: string, context: Context) {
  return evaluateWorkflowExpression(
    expression.startsWith("${{") ? expression : "${{ " + expression + " }}",
    context,
  );
}

describe("hourly main CI admission", () => {
  it("admits hourly work only in the canonical repo even during release validation", () => {
    const context = { ...base, eventName: "schedule" } as const;
    expect(ci.on.schedule).toEqual([{ cron: "23 * * * *" }]);
    for (const name of ["preflight", "security-fast", "ci-gate"]) {
      expect(evaluate(ci.jobs[name].if, context), name).toBe(true);
      expect(evaluate(ci.jobs[name].if, { ...context, repository: "fork/openclaw" }), name).toBe(
        false,
      );
      expect(evaluate(ci.jobs[name].if, { ...context, ref: "refs/heads/topic" }), name).toBe(false);
    }
    for (const name of auxiliaryNames) {
      const workflow = readWorkflow(`.github/workflows/${name}.yml`);
      expect(workflow.on.schedule).toHaveLength(1);
      const cron = workflow.on.schedule[0].cron.split(" ");
      expect(cron).toHaveLength(5);
      expect(cron.slice(1)).toEqual(
        name === "sandbox-common-smoke" ? ["5", "*", "*", "*"] : ["*", "*", "*", "*"],
      );
      const entry = Object.values(workflow.jobs)[0] as { if: string };
      expect(evaluate(entry.if, context), name).toBe(true);
      expect(evaluate(entry.if, { ...context, repository: "fork/openclaw" }), name).toBe(false);
    }
  });

  it("isolates full manual CI from a later skip-only main push", () => {
    const common = { ...base, workflow: "CI", runId: 123, runNumber: 456 } as const;
    const full = evaluate(ci.concurrency.group, { ...common, eventName: "workflow_dispatch" });
    const push = evaluate(ci.concurrency.group, { ...common, eventName: "push" });
    expect(full).not.toBe(push);
    const child = {
      ...common,
      eventName: "schedule",
    } as const;
    const hourlyGroup = evaluate(ci.concurrency.group, child);
    expect(hourlyGroup).not.toBe(full);
    expect(hourlyGroup).not.toBe(push);
    expect(evaluate(ci.concurrency.group, { ...child, runId: 999 })).not.toBe(hourlyGroup);
    expect(evaluate(ci.concurrency["cancel-in-progress"], child)).toBe(false);
    expect(evaluate(ci.concurrency["cancel-in-progress"], { ...common, eventName: "push" })).toBe(
      false,
    );
    for (const name of auxiliaryNames) {
      const workflow = readWorkflow(`.github/workflows/${name}.yml`);
      const entries = workflow.concurrency ? [workflow] : Object.values(workflow.jobs);
      for (const entry of entries as { concurrency: { group: string } }[]) {
        // A shared event-only interpolation still separates jobs when ref/SHA match.
        const render = (eventName: Context["eventName"]) =>
          entry.concurrency.group.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) =>
            String(
              evaluate(expression, {
                ...common,
                eventName,
                githubEvent: { pull_request: {} },
                matrix: { platform: "linux" },
              }),
            ),
          );
        expect(render("push"), name).not.toBe(render("schedule"));
        expect(render("push"), name).not.toBe(render("workflow_dispatch"));
      }
    }
  });

  it("serializes only scheduled iOS proof while admitting overlapping hourly runs", () => {
    const scheduled = {
      ...base,
      eventName: "schedule",
      workflow: "CI",
      runId: 123,
      matrix: { phase: "tests" },
    } as const;
    const next = { ...scheduled, runId: 124 };
    const ios = ci.jobs["ios-build"];
    expect(evaluate(ci.concurrency.group, scheduled)).not.toBe(
      evaluate(ci.concurrency.group, next),
    );
    expect(evaluate(ios.concurrency.group, scheduled)).toBe(evaluate(ios.concurrency.group, next));
    expect(ios.concurrency["cancel-in-progress"]).toBe(false);
    // GitHub's default single pending slot replaces pending work, never the active proof.
    expect(ios.concurrency.queue ?? "single").toBe("single");
    const hourly = evaluate(ios.concurrency.group, scheduled);
    for (const eventName of ["workflow_dispatch", "pull_request", "push"] as const) {
      for (const releaseGate of [false, true]) {
        const groups = [123, 124].flatMap((runId) =>
          ["tests", "release", "smoke"].map((phase) =>
            evaluate(ios.concurrency.group, {
              ...scheduled,
              eventName,
              releaseGate,
              runId,
              matrix: { phase },
            }),
          ),
        );
        expect(new Set(groups).size).toBe(groups.length);
        expect(groups).not.toContain(hourly);
      }
    }
  });

  it("keeps differential guards on the push range, not hourly main-against-itself", () => {
    const guards = ci.jobs["security-fast"].steps.find(
      (step: { name?: string }) => step.name === "Check main push ratchets and protocol additions",
    );
    const baseSha = "b".repeat(40);
    const context = {
      ...base,
      eventName: "push",
      steps: { diff_base: { outputs: { sha: baseSha } } },
    } as const;
    expect(evaluate(guards.if, context)).toBe(true);
    expect(evaluate(guards.env.BASE_SHA, context)).toBe(baseSha);
    expect(evaluate(guards.env.PROTOCOL_SINCE_BASE_SHA, context)).toBe(baseSha);
    expect(evaluate(guards.if, { ...context, eventName: "workflow_dispatch" })).toBe(false);
    expect(evaluate(guards.if, { ...context, eventName: "schedule" })).toBe(false);
    expect(evaluate(guards.if, { ...context, ciOnPush: "true" })).toBe(false);
  });

  it("schedules only nonpublishing plugin previews with no last-commit path filter", () => {
    const workflow = readWorkflow(".github/workflows/plugin-npm-release.yml");
    const context = { ...base, eventName: "schedule" } as const;
    const preview = workflow.jobs.preview_plugins_npm;
    for (const name of ["Validate publishable plugin metadata", "Resolve plugin release plan"]) {
      const step = preview.steps.find((candidate: { name?: string }) => candidate.name === name);
      expect(evaluate(step.env.BASE_REF, context)).toBe("");
      expect(evaluate(step.env.PUBLISH_SCOPE, context)).toBe("");
    }
    const inputs = Object.fromEntries(
      Object.entries(workflow.on.workflow_dispatch.inputs).map(([key, input]) => [
        key,
        (input as { default?: unknown }).default ?? "",
      ]),
    );
    const eligible: string[] = [];
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const expression = (job as { if: string }).if.replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
      if (
        runInNewContext(expression, {
          github: { event_name: "schedule", repository: base.repository, ref: "refs/heads/main" },
          inputs,
          vars: {},
          always: () => true,
          cancelled: () => false,
          needs: {
            preview_plugins_npm: {
              result: "success",
              outputs: { has_candidates: "true", has_selection: "true" },
            },
          },
        })
      ) {
        eligible.push(name);
      }
    }
    expect(eligible).toEqual(["preview_plugins_npm", "preview_plugin_pack"]);
  });

  it("retains real per-push CodeQL and workflow security checks", () => {
    const context = { ...base, eventName: "push" } as const;
    const codeql = readWorkflow(".github/workflows/codeql.yml");
    expect(codeql.on.push.branches).toContain("main");
    expect(evaluate(codeql.jobs["security-high"].if, context)).toBe(true);
    const sanity = readWorkflow(".github/workflows/workflow-sanity.yml");
    expect(evaluate(sanity.jobs.actionlint.if, context)).toBe(true);
  });
});
