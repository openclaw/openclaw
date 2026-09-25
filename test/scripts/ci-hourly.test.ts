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
    for (const name of [...auxiliaryNames, "docs"]) {
      const workflow = readWorkflow(`.github/workflows/${name}.yml`);
      const entry = Object.entries(workflow.jobs).find(([id]) => id !== "scope")![1] as {
        if: string;
      };
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

  it.each(["github", "hybrid", "runson", "blacksmith", ""] as const)(
    "preserves automatic runner and cache policy for scheduled %s runs",
    (runnerBackend) => {
      for (const runAttempt of [1, 2]) {
        const shared = {
          ...base,
          runAttempt,
          runnerBackend,
          runnerEnvironment: "self-hosted" as const,
          matrix: { runner: "blacksmith-8vcpu-ubuntu-2404", check_name: "fixture", task: "lint" },
        };
        const scheduled = { ...shared, eventName: "schedule" as const };
        const push = { ...shared, eventName: "push" as const };
        for (const [name, raw] of Object.entries(ci.jobs)) {
          if (name === "pr-fail-fast") {
            expect(evaluate(ci.jobs[name].if, scheduled), name).toBe(false);
            expect(evaluate(ci.jobs[name].if, push), name).toBe(false);
            continue;
          }
          const job = raw as { "runs-on"?: string; steps?: { with?: Record<string, unknown> }[] };
          if (job["runs-on"]) {
            expect(evaluate(job["runs-on"], scheduled), name).toEqual(
              evaluate(job["runs-on"], push),
            );
          }
          for (const step of job.steps ?? []) {
            const cache = step.with?.["dependency-cache"];
            if (typeof cache === "string" && cache.startsWith("${{")) {
              expect(evaluate(cache, scheduled), name).toBe(evaluate(cache, push));
              expect(
                evaluate(cache, { ...scheduled, runnerEnvironment: "github-hosted" }),
                name,
              ).toBe("false");
            }
          }
        }
      }
    },
  );

  it("keeps manual hourly-shaped inputs strict and outside schedule concurrency", () => {
    const schedule = { ...base, eventName: "schedule" as const };
    const manual = {
      ...base,
      eventName: "workflow_dispatch" as const,
      dispatchId: "hourly-main-123-1",
      validationTier: "main" as const,
      runnerBackend: "hybrid" as const,
    };
    expect(evaluate(ci.jobs.preflight["runs-on"], manual)).toBe("ubuntu-24.04");
    expect(evaluate(ci.concurrency.group, manual)).not.toBe(
      evaluate(ci.concurrency.group, schedule),
    );
    for (const surface of ["control_ui", "native"]) {
      const output = ci.jobs.preflight.outputs["strict_" + surface + "_i18n"];
      const strict = String(evaluate(output, manual));
      const advisory = String(
        evaluate(output, { ...schedule, steps: { changed_scope: { outputs: {} } } }),
      );
      expect(strict).toBe("true");
      expect(advisory).not.toBe("true");
      const parity = ci.jobs[surface === "native" ? "native-i18n" : "control-ui-i18n"].steps.find(
        (step: { name?: string }) =>
          step.name ===
          (surface === "native"
            ? "Check native app generated locale parity"
            : "Check Control UI locale parity"),
      );
      for (const [context, value, manualStrict] of [
        [manual, strict, true],
        [schedule, advisory, false],
      ] as const) {
        const finalContext = {
          ...context,
          preflightOutputs: { ["strict_" + surface + "_i18n"]: value },
        };
        if (surface === "native") {
          expect(evaluate(parity.if, finalContext)).toBe(manualStrict);
        } else {
          expect(evaluate(parity["continue-on-error"], finalContext)).toBe(!manualStrict);
        }
      }
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

  it("schedules complete main coverage at the workflow revision without a diff filter", () => {
    const childSha = "b".repeat(40);
    const context = {
      ...base,
      eventName: "schedule",
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
    expect(evaluate(ci.jobs.android.strategy["max-parallel"], context)).toBe(2);
    expect(evaluate(ci.jobs["macos-swift"].env.OPENCLAWKIT_TEST_EXECUTION, context)).toBe("serial");
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
