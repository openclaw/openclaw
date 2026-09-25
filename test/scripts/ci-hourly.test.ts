import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  readWorkflow,
} from "./ci-workflow.test-support.js";

const auxiliaryNames = [
  "docs",
  "node-runtime-conformance",
  "plugin-init-scaffold-validation",
  "sandbox-common-smoke",
  "vitest-cache-warm",
  "plugin-npm-release",
];
const hourly = readWorkflow(".github/workflows/ci-hourly.yml");
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
  it.each([
    ["", false],
    ["false", false],
    ["1", false],
    ["true", true],
  ])("opts main pushes into full CI only with %s", (ciOnPush, admitted) => {
    const context = { ...base, eventName: "push", ciOnPush } as const;
    expect(evaluate(ci.jobs.preflight.if, context)).toBe(admitted);
    expect(evaluate(ci.jobs["ci-gate"].if, context)).toBe(admitted);
    // This job uses !cancelled(), so a skipped preflight does not skip security.
    expect(evaluate(ci.jobs["security-fast"].if, context)).toBe(true);
    if (!admitted) {
      for (const [name, job] of Object.entries(ci.jobs)) {
        if (name !== "security-fast") {
          expect(evaluate((job as { if: string }).if, { ...context, runCheck: false }), name).toBe(
            false,
          );
        }
      }
    }
    for (const name of auxiliaryNames) {
      const workflow = readWorkflow(`.github/workflows/${name}.yml`);
      const entry = Object.values(workflow.jobs)[0] as { if: string };
      expect(evaluate(entry.if, context), name).toBe(admitted);
    }
  });

  it.each([false, true])("preserves PR admission with draft=%s", (draft) => {
    const context = { ...base, eventName: "pull_request", draft } as const;
    for (const name of ["preflight", "security-fast", "ci-gate"]) {
      expect(evaluate(ci.jobs[name].if, context), name).toBe(!draft);
    }
  });

  it.each(["refs/heads/main", "refs/heads/release/2026.9", "refs/tags/v2026.9.5"])(
    "preserves manual validation on %s",
    (ref) => {
      const context = { ...base, eventName: "workflow_dispatch", ref } as const;
      expect(evaluate(ci.jobs.preflight.if, context)).toBe(true);
      expect(evaluate(ci.jobs["ci-gate"].if, context)).toBe(true);
      expect(evaluate(ci.jobs.preflight.if, { ...context, releaseGate: true })).toBe(true);
    },
  );

  it("admits hourly work only in the canonical repo even during release validation", () => {
    const context = { ...base, eventName: "schedule" } as const;
    expect(evaluate(hourly.jobs.dispatch.if, context)).toBe(true);
    expect(evaluate(hourly.jobs.dispatch.if, { ...context, repository: "fork/openclaw" })).toBe(
      false,
    );
    expect(evaluate(hourly.jobs.dispatch.if, { ...context, releasePriorityRun: "123" })).toBe(true);
    expect(
      evaluate(hourly.jobs.dispatch.if, {
        ...context,
        eventName: "workflow_dispatch",
        releasePriorityRun: "123",
      }),
    ).toBe(true);
    for (const name of auxiliaryNames) {
      const workflow = readWorkflow(`.github/workflows/${name}.yml`);
      expect(workflow.on.schedule).toHaveLength(1);
      const cron = workflow.on.schedule[0].cron.split(" ");
      expect(cron).toHaveLength(5);
      expect(cron.slice(1)).toEqual(["*", "*", "*", "*"]);
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
      eventName: "workflow_dispatch",
      dispatchId: "hourly-main-123-1",
    } as const;
    const hourlyGroup = evaluate(ci.concurrency.group, child);
    expect(hourlyGroup).not.toBe(full);
    expect(hourlyGroup).not.toBe(push);
    expect(
      evaluate(ci.concurrency.group, { ...child, runId: 999, dispatchId: "hourly-main-999-1" }),
    ).toBe(hourlyGroup);
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

  it("dispatches the complete main tier without freezing an obsolete scheduler SHA", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const summary = {
      addHeading: vi.fn().mockReturnThis(),
      addRaw: vi.fn().mockReturnThis(),
      write: vi.fn(),
    };
    const sha = "a".repeat(40);
    const script = hourly.jobs.dispatch.steps[0].with.script;
    await runInNewContext(`(async () => { ${script} })()`, {
      github: { rest: { actions: { createWorkflowDispatch: dispatch } } },
      context: { repo: { owner: "openclaw", repo: "openclaw" }, sha, runId: 123 },
      process: { env: { GITHUB_RUN_ATTEMPT: "1" } },
      core: { summary },
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      owner: "openclaw",
      repo: "openclaw",
      workflow_id: "ci.yml",
      ref: "main",
      inputs: {
        include_android: "true",
        validation_tier: "main",
        release_gate: "false",
        release_scope: "full",
        dispatch_id: "hourly-main-123-1",
      },
    });
    const childSha = "b".repeat(40);
    const context = {
      ...base,
      eventName: "workflow_dispatch",
      includeAndroid: true,
      validationTier: "main",
      sha: childSha,
      workflowSha: childSha,
    } as const;
    const checkout = ci.jobs.preflight.steps.find(
      (step: { name?: string }) => step.name === "Checkout",
    );
    expect(evaluate(checkout.env.CHECKOUT_REF, context)).toBe(childSha);
    expect(evaluate(checkout.env.WORKFLOW_SHA, context)).toBe(childSha);
    const manifest = ci.jobs.preflight.steps.find(
      (step: { id?: string }) => step.id === "manifest",
    );
    for (const [key, expression] of Object.entries(manifest.env)) {
      if (
        /^OPENCLAW_CI_RUN_(NODE|MACOS|MACOS_NODE|IOS_BUILD|ANDROID|WINDOWS|SKILLS_PYTHON|CONTROL_UI_I18N|UI_TESTS|NATIVE_I18N)$/.test(
          key,
        )
      ) {
        expect(evaluate(expression as string, context), key).toBe("true");
      }
    }
    expect(evaluate(manifest.env.OPENCLAW_CI_DOCS_ONLY, context)).toBe("false");
    expect(evaluate(manifest.env.OPENCLAW_CI_DOCS_CHANGED, context)).toBe("true");
    expect(evaluate(manifest.env.OPENCLAW_CI_VALIDATION_TIER, context)).toBe("main");
    for (const id of ["docs_scope", "changed_scope"]) {
      expect(
        evaluate(
          ci.jobs.preflight.steps.find((step: { id?: string }) => step.id === id).if,
          context,
        ),
      ).toBe(false);
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
