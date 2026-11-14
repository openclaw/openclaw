import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  acceptsWorkflowPaths,
  evaluateWorkflowExpression,
  readCiWorkflow,
  readWorkflow,
} from "./ci-workflow.test-support.js";

const auxiliary = [
  "node-runtime-conformance",
  "plugin-init-scaffold-validation",
  "sandbox-common-smoke",
  "vitest-cache-warm",
  "plugin-npm-release",
].map((name) => [name, readWorkflow(`.github/workflows/${name}.yml`)] as const);
const ci = readCiWorkflow();
const base = { repository: "openclaw/openclaw", runAttempt: 1, releasePriorityRun: "123" } as const;
type Context = Parameters<typeof evaluateWorkflowExpression>[1];

function evaluate(expression: string, context: Partial<Context> = {}) {
  return evaluateWorkflowExpression(
    expression.startsWith("${{") ? expression : "${{ " + expression + " }}",
    { ...base, eventName: "schedule", ...context },
  );
}
function expectAdmission(expression: string, mainOnly = false) {
  expect(evaluate(expression)).toBe(true);
  expect(evaluate(expression, { repository: "fork/openclaw" })).toBe(false);
  if (mainOnly) {
    expect(evaluate(expression, { ref: "refs/heads/topic" })).toBe(false);
  }
}

describe("hourly main CI admission", () => {
  it("admits hourly work only in the canonical repo even during release validation", () => {
    expect(ci.on.schedule).toEqual([{ cron: "23 * * * *" }]);
    for (const name of ["preflight", "security-fast", "ci-gate"]) {
      expectAdmission(ci.jobs[name].if, true);
    }
    for (const [name, workflow] of auxiliary) {
      expect(workflow.on.schedule).toHaveLength(1);
      const hour = name === "sandbox-common-smoke" ? "5" : "*";
      expect(workflow.on.schedule[0].cron.split(" ")).toEqual([
        expect.any(String),
        hour,
        "*",
        "*",
        "*",
      ]);
      const entry = Object.values(workflow.jobs)[0] as { if: string };
      expectAdmission(entry.if);
    }
  });

  it("isolates full manual CI from a later skip-only main push", () => {
    const common = { workflow: "CI", runId: 123, runNumber: 456 };
    const full = evaluate(ci.concurrency.group, { ...common, eventName: "workflow_dispatch" });
    const push = evaluate(ci.concurrency.group, { ...common, eventName: "push" });
    const hourlyGroup = evaluate(ci.concurrency.group, common);
    expect(new Set([full, push, hourlyGroup]).size).toBe(3);
    expect(evaluate(ci.concurrency.group, { ...common, runId: 999 })).not.toBe(hourlyGroup);
    for (const eventName of ["schedule", "push"] as const) {
      expect(evaluate(ci.concurrency["cancel-in-progress"], { ...common, eventName })).toBe(false);
    }
    for (const [name, workflow] of auxiliary) {
      const entries = workflow.concurrency ? [workflow] : Object.values(workflow.jobs);
      const context = {
        ...common,
        githubEvent: { pull_request: {} },
        matrix: { platform: "linux" },
      };
      for (const entry of entries as { concurrency: { group: string } }[]) {
        const render = (eventName: Context["eventName"]) =>
          entry.concurrency.group.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) =>
            String(evaluate(expression, { ...context, eventName })),
          );
        expect(render("push"), name).not.toBe(render("schedule"));
        expect(render("push"), name).not.toBe(render("workflow_dispatch"));
      }
    }
  });

  it("serializes only scheduled iOS proof while admitting overlapping hourly runs", () => {
    const scheduled = { workflow: "CI", runId: 123, matrix: { phase: "tests" } };
    const next = { ...scheduled, runId: 124 };
    const ios = ci.jobs["ios-build"];
    const group = (context: Partial<Context>) => evaluate(ci.concurrency.group, context);
    expect(group(scheduled)).not.toBe(group(next));
    expect(evaluate(ios.concurrency.group, scheduled)).toBe(evaluate(ios.concurrency.group, next));
    expect(ios.concurrency["cancel-in-progress"]).toBe(false);
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
      eventName: "push",
      steps: {
        diff_base: { outputs: { sha: baseSha } },
        guard_setup: { outputs: {}, outcome: "success" },
        guard_ripgrep: { outputs: {}, outcome: "success" },
      },
    } as const;
    expect(evaluate(guards.if, context)).toBe(true);
    expect(
      evaluate(guards.if, {
        ...context,
        steps: { ...context.steps, guard_ripgrep: { outputs: {}, outcome: "failure" } },
      }),
    ).toBe(false);
    for (const name of ["BASE_SHA", "PROTOCOL_SINCE_BASE_SHA"]) {
      expect(evaluate(guards.env[name], context)).toBe(baseSha);
    }
    for (const eventName of ["workflow_dispatch", "schedule"] as const) {
      expect(evaluate(guards.if, { ...context, eventName })).toBe(false);
    }
    expect(evaluate(guards.if, { ...context, ciOnPush: "true" })).toBe(false);
  });

  it("runs shutdown and suppression regressions on every main push", () => {
    const steps = ci.jobs["security-fast"].steps;
    const setup = steps.find((step: { id?: string }) => step.id === "push_test_bun");
    const proof = steps.find(
      (step: { name?: string }) =>
        step.name === "Check main push shutdown and suppression regressions",
    );
    expect(proof).toBeDefined();
    expect(setup.uses).toBe("./.ci-harness/.github/actions/setup-test-bun");
    const context = {
      eventName: "push",
      failed: true,
      steps: {
        guard_setup: { outputs: {}, outcome: "success" },
        push_test_bun: { outputs: {}, outcome: "success" },
      },
    } as const;
    expect(evaluate(proof.if, context)).toBe(true);
    expect(evaluate(proof.if, { ...context, ciOnPush: "true" })).toBe(true);
    for (const override of [
      { eventName: "schedule" as const },
      { eventName: "pull_request" as const },
      { ref: "refs/heads/topic" },
      { cancelled: true },
      { steps: { guard_setup: { outputs: {}, outcome: "failure" } } },
      { steps: { ...context.steps, push_test_bun: { outputs: {}, outcome: "failure" } } },
    ] as const) {
      expect(evaluate(proof.if, { ...context, ...override })).toBe(false);
    }
  });

  it("schedules only nonpublishing plugin previews with no last-commit path filter", () => {
    const workflow = readWorkflow(".github/workflows/plugin-npm-release.yml");
    const preview = workflow.jobs.preview_plugins_npm;
    for (const name of ["Validate publishable plugin metadata", "Resolve plugin release plan"]) {
      const step = preview.steps.find((candidate: { name?: string }) => candidate.name === name);
      expect(
        [step.env.BASE_REF, step.env.PUBLISH_SCOPE].map((expression) => evaluate(expression)),
      ).toEqual(["", ""]);
    }
    const inputs = Object.fromEntries(
      Object.entries(workflow.on.workflow_dispatch.inputs).map(([key, input]) => [
        key,
        (input as { default?: unknown }).default ?? "",
      ]),
    );
    const eligible = Object.entries(workflow.jobs)
      .filter(([, job]) =>
        runInNewContext((job as { if: string }).if.replace(/^\$\{\{\s*|\s*\}\}$/gu, ""), {
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
        }),
      )
      .map(([name]) => name);
    expect(eligible).toEqual(["preview_plugins_npm", "preview_plugin_pack"]);
  });

  it("batches CodeQL hourly without cancelling active scans and retains push workflow checks", () => {
    const context = { eventName: "push" } as const;
    const codeql = readWorkflow(".github/workflows/codeql.yml");
    expect(codeql.on.push).toBeUndefined();
    expect(codeql.on.schedule).toEqual([{ cron: "23 * * * *" }]);
    const renderGroup = (eventName: Context["eventName"], runId: number) =>
      codeql.concurrency.group.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) =>
        String(
          evaluate(expression, { eventName, runId, workflow: "CodeQL", pullRequestNumber: 123 }),
        ),
      );
    expect(renderGroup("schedule", 1)).toBe(renderGroup("schedule", 2));
    expect(renderGroup("schedule", 1)).not.toBe(renderGroup("pull_request", 1));
    expect(renderGroup("schedule", 1)).not.toBe(renderGroup("workflow_dispatch", 1));
    expect(renderGroup("workflow_dispatch", 1)).not.toBe(renderGroup("workflow_dispatch", 2));
    for (const eventName of ["schedule", "workflow_dispatch", "pull_request"] as const) {
      expect(evaluate(codeql.concurrency["cancel-in-progress"], { eventName })).toBe(
        eventName === "pull_request",
      );
    }
    const sanity = readWorkflow(".github/workflows/workflow-sanity.yml");
    expect(evaluate(sanity.jobs.actionlint.if, context)).toBe(true);
  });
});

describe("CodeQL language selection", () => {
  const workflow = readWorkflow(".github/workflows/codeql.yml");
  const scope = workflow.jobs.scope;
  const selection = scope.steps.find((step: { id?: string }) => step.id === "scope");
  const categories = [
    "core-auth-secrets",
    "channel-runtime-boundary",
    "network-ssrf-boundary",
    "mcp-process-tool-boundary",
    "process-exec-boundary",
    "plugin-trust-boundary",
    "actions",
  ];

  function selectionCase(
    files = [".github/workflows/docs.yml"],
    expected = categories,
    options: {
      eventName?: string;
      exitCode?: number;
      checkoutOutcome?: string;
      actionsChanged?: string;
      javascriptChanged?: string;
      unchangedCategories?: string[];
      scheduledProofs?: string;
    } = {},
  ) {
    return { files, expected, ...options };
  }
  it.each([
    selectionCase(undefined, ["actions"]),
    selectionCase([".github/actions/example/action.yml"], ["actions"]),
    selectionCase([".github/workflows/codeql.yml"]),
    selectionCase([".github/codeql/codeql-actions-critical-security.yml"]),
    ...[".gitattributes", "apps/.gitattributes", ".hidden/.gitattributes"].map((file) =>
      selectionCase([file]),
    ),
    selectionCase(["src/main.ts"], categories.slice(0, -1)),
    selectionCase(["packages/example/README.md"], categories.slice(0, -1)),
    selectionCase([".github/workflows/docs.yml", "src/main.ts"]),
    selectionCase([]),
    selectionCase(undefined, undefined, { checkoutOutcome: "failure" }),
    ...["{", "null", '{"actions":"false"}', "{}"].map((scheduledProofs) =>
      selectionCase(undefined, undefined, { eventName: "schedule", scheduledProofs }),
    ),
    selectionCase(undefined, undefined, { exitCode: 128 }),
    ...["schedule", "workflow_dispatch"].map((eventName) =>
      selectionCase(undefined, undefined, { eventName }),
    ),
    selectionCase(
      undefined,
      categories.filter((category) => category !== "network-ssrf-boundary"),
      {
        eventName: "schedule",
        unchangedCategories: ["network-ssrf-boundary"],
      },
    ),
    selectionCase(undefined, ["actions"], {
      eventName: "schedule",
      actionsChanged: "true",
      javascriptChanged: "false",
    }),
    selectionCase(undefined, categories.slice(0, -1), {
      eventName: "schedule",
      actionsChanged: "false",
      javascriptChanged: "true",
    }),
    selectionCase(undefined, [], {
      eventName: "schedule",
      actionsChanged: "false",
      javascriptChanged: "false",
    }),
    selectionCase(undefined, undefined, {
      eventName: "workflow_dispatch",
      actionsChanged: "false",
      javascriptChanged: "false",
    }),
  ])(
    "selects $expected for $files/$eventName/$exitCode",
    async ({ files, expected, ...options }) => {
      let matrix: { include: Array<Record<string, string | number>> } | undefined;
      let hasWork: boolean | undefined;
      await runInNewContext(`(async () => { ${selection.with.script} })()`, {
        context: { eventName: options.eventName ?? "pull_request" },
        process: {
          env: {
            CODEQL_CHECKOUT_OUTCOME: options.checkoutOutcome ?? "success",
            CODEQL_SCHEDULED_PROOFS:
              options.scheduledProofs ??
              JSON.stringify({
                ...Object.fromEntries(
                  categories.map((category) => [
                    category,
                    (category === "actions"
                      ? options.actionsChanged
                      : options.javascriptChanged) !== "false",
                  ]),
                ),
                ...Object.fromEntries(
                  (options.unchangedCategories ?? []).map((category) => [category, false]),
                ),
              }),
          },
        },
        core: {
          setOutput: (name: string, value: string | boolean) => {
            if (name === "matrix") {
              matrix = JSON.parse(String(value));
            }
            if (name === "has_work") {
              hasWork = Boolean(value);
            }
          },
          warning: () => {},
        },
        exec: {
          getExecOutput: async (_command: string, args: string[]) => {
            expect(args).toEqual(["diff", "--no-renames", "--name-only", "-z", "HEAD^1", "HEAD"]);
            return {
              exitCode: options.exitCode ?? 0,
              stdout: files.join("\0") + (files.length ? "\0" : ""),
            };
          },
        },
      });
      expect(matrix?.include).toEqual(
        expected.map((category) => ({
          category,
          language: category === "actions" ? "actions" : "javascript-typescript",
          runs_on: "ubuntu-24.04",
          timeout_minutes: category === "actions" ? 10 : 25,
          config_file: `./.github/codeql/codeql-${category}-critical-security.yml`,
        })),
      );
      expect(hasWork).toBe(expected.length > 0);
      expect(
        evaluate(workflow.jobs["security-high"].if, {
          eventName: (options.eventName ?? "pull_request") as Context["eventName"],
          inputs: { profile: "all" },
          additionalNeeds: { scope: { outputs: { has_work: String(hasWork) } } },
        }),
      ).toBe(expected.length > 0);
    },
  );

  it("admits root and nested attribute changes while excluding unrelated docs", () => {
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([".gitattributes", "**/.gitattributes"]),
    );
    for (const file of [".gitattributes", "apps/.gitattributes"]) {
      expect(acceptsWorkflowPaths(workflow.on.pull_request.paths, [file])).toBe(true);
    }
    expect(acceptsWorkflowPaths(workflow.on.pull_request.paths, ["docs/intro.md"])).toBe(false);
  });

  it("keeps event admission and exact merge identity", () => {
    expectAdmission(scope.if);
    const checkout = scope.steps.find(
      (step: { name?: string }) => step.name === "Checkout event merge",
    );
    expect(selection.env.CODEQL_CHECKOUT_OUTCOME).toBe("${{ steps.checkout.outcome }}");
    expect(checkout).toMatchObject({
      "continue-on-error": true,
      with: { ref: "${{ github.sha }}", "fetch-depth": 2, "persist-credentials": false },
    });
    expect(workflow.jobs["security-high"]).toMatchObject({
      needs: "scope",
      strategy: { matrix: "${{ fromJSON(needs.scope.outputs.matrix) }}" },
    });
    const scheduledCheckout = scope.steps.find(
      (step: { name?: string }) => step.name === "Checkout scheduled admission",
    );
    expect(scheduledCheckout).toMatchObject({
      if: "github.event_name == 'schedule'",
      with: { ref: "${{ github.sha }}", "persist-credentials": false },
    });
    expect(scope.permissions).toMatchObject({ actions: "read", contents: "read" });
  });
});
