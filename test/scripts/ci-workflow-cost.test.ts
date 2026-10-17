import { matchesGlob } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { readCiWorkflow, readWorkflow } from "./ci-workflow.test-support.js";

const before = "a".repeat(40);
const head = "b".repeat(40);
const context = {
  repo: { owner: "openclaw", repo: "openclaw" },
  ref: "refs/heads/main",
  sha: head,
  runId: 100,
};
const action = readWorkflow(".github/actions/detect-scheduled-changes/action.yml");
const script = action.runs.steps[0].with.script;

function acceptsPaths(patterns: string[], files: readonly string[]) {
  return files.some((file) =>
    patterns.reduce(
      (selected, pattern) =>
        pattern.startsWith("!")
          ? selected && !matchesGlob(file, pattern.slice(1))
          : selected || matchesGlob(file, pattern),
      false,
    ),
  );
}

const locale = "native-app-locale-refresh";
const scaffold = "plugin-init-scaffold-validation";
const runtime = "node-runtime-conformance";
it.each<[string, readonly string[], boolean]>([
  [locale, ["apps/ios/README.md"], false],
  [locale, ["apps/ios/AGENTS.md"], false],
  [locale, ["apps/ios/README.md", "apps/ios/AGENTS.md"], false],
  [locale, ["apps/ios/README.md", "apps/ios/Sources/App.swift"], true],
  [locale, ["apps/ios/Info.plist"], true],
  [locale, ["apps/ios/Localizable.xcstrings"], true],
  [locale, ["apps/.i18n/native-source.json"], true],
  [locale, ["scripts/native-app-i18n.ts"], true],
  [locale, [".github/workflows/native-app-locale-refresh.yml"], true],
  [scaffold, ["src/plugin-sdk/AGENTS.md"], false],
  [scaffold, ["src/plugin-sdk/index.ts"], true],
  [scaffold, ["src/plugin-sdk/AGENTS.md", "src/plugin-sdk/index.ts"], true],
  [scaffold, ["src/plugin-sdk/runtime-fixture.md"], true],
  [scaffold, [".github/workflows/plugin-init-scaffold-validation.yml"], true],
  [runtime, ["patches/README.md"], false],
  [runtime, ["patches/vitest@5.0.1.patch"], true],
  [runtime, ["patches/README.md", "patches/vitest@5.0.1.patch"], true],
  [runtime, ["patches/runtime-fixture.md"], true],
  [runtime, ["crates/openclaw-node-host/SIDECAR_PROTOCOL.md"], false],
  [
    runtime,
    ["crates/openclaw-node-host/SIDECAR_PROTOCOL.md", "crates/openclaw-node-host/src/main.rs"],
    true,
  ],
  [runtime, ["crates/openclaw-node-host/Cargo.toml"], true],
  [runtime, ["crates/openclaw-node-host/tests/fixtures/README.md"], true],
  [runtime, [".github/workflows/node-runtime-conformance.yml"], true],
])("%s routes %j", (name, files, expected) => {
  const workflow = readWorkflow(`.github/workflows/${name}.yml`);
  for (const event of name === locale ? ["push"] : ["push", "pull_request"]) {
    expect(acceptsPaths(workflow.on[event].paths, files)).toBe(expected);
  }
  expect(workflow.on.workflow_dispatch).toBeDefined();
  if (name !== locale) {
    expect(workflow.on.schedule).toBeDefined();
  }
});

type ScheduledScopeOptions = {
  files?: Array<{ filename: string; previous_filename?: string }>;
  status?: string;
  ageHours?: number;
  skipFirst?: boolean;
  unavailable?: boolean;
  paths?: string;
  missingProof?: boolean;
  identical?: boolean;
};
async function scheduledScope(options: ScheduledScopeOptions = {}) {
  const proof = {
    id: 90,
    event: "schedule",
    head_sha: options.identical ? head : before,
    run_attempt: 1,
    head_repository: { full_name: "openclaw/openclaw" },
  };
  const jobs = [
    {
      name: "Proof",
      head_sha: options.identical ? head : before,
      conclusion: "success",
      completed_at: new Date(Date.now() - (options.ageHours ?? 1) * 3600_000).toISOString(),
    },
  ];
  const list = vi.fn().mockResolvedValue({
    data: { workflow_runs: options.skipFirst ? [{ ...proof, id: 99 }, proof] : [proof] },
  });
  if (options.unavailable) {
    list.mockRejectedValue(new Error("unavailable"));
  }
  const paginate = vi
    .fn()
    .mockImplementation((_method, args) =>
      args.run_id === 99
        ? [{ ...jobs[0], conclusion: "skipped" }]
        : options.missingProof
          ? []
          : jobs,
    );
  const output = vi.fn();
  const notice = vi.fn();
  await runInNewContext(`(async () => { ${script} })()`, {
    require: () => ({ matchesGlob }),
    context,
    process: {
      env: {
        SCHEDULED_PATHS: options.paths ?? "src/contracts/**\n.github/actions/**",
        SCHEDULED_PROOF_JOBS: "Proof",
        SCHEDULED_WORKFLOW_REF: "openclaw/openclaw/.github/workflows/example.yml@refs/heads/main",
      },
    },
    core: { setOutput: output, notice, warning: vi.fn() },
    github: {
      paginate,
      rest: {
        actions: { listWorkflowRuns: list, listJobsForWorkflowRunAttempt: vi.fn() },
        repos: {
          compareCommitsWithBasehead: vi.fn().mockResolvedValue({
            data: { status: options.status ?? "ahead", files: options.files ?? [] },
          }),
        },
      },
    },
  });
  return { output, notice, paginate };
}

describe("bounded scheduled proof reuse", () => {
  it.each<[string, boolean, ScheduledScopeOptions]>([
    ["unchanged inputs", false, { files: [{ filename: "docs/intro.md" }] }],
    ["changed contract", true, { files: [{ filename: "src/contracts/node.ts" }] }],
    [
      "renamed contract",
      true,
      { files: [{ filename: "retired.ts", previous_filename: "src/contracts/node.ts" }] },
    ],
    [
      "truncated diff",
      true,
      {
        files: Array.from({ length: 300 }, (_, index) => ({ filename: `docs/${index}.md` })),
      },
    ],
    ["same SHA", false, { identical: true }],
    ["missing completed jobs", true, { missingProof: true }],
    ["diverged history", true, { status: "diverged" }],
    ["daily external drift", true, { ageHours: 25 }],
    ["unavailable proof", true, { unavailable: true }],
    ["skip-only success never advances the baseline", false, { skipFirst: true }],
  ])("%s", async (_label, expected, options) => {
    const { output, notice, paginate } = await scheduledScope(options);
    expect(output).toHaveBeenCalledExactlyOnceWith("changed", expected);
    expect(notice).toHaveBeenCalledOnce();
    if (options.skipFirst) {
      expect(paginate.mock.calls.map(([, args]) => args.run_id)).toEqual([99, 90]);
    }
  });

  it.each(["node-runtime-conformance", "plugin-init-scaffold-validation"])(
    "covers event inputs and transitive proof dependencies for %s",
    async (name) => {
      const workflow = readWorkflow(`.github/workflows/${name}.yml`);
      const scope = workflow.jobs.scope.steps.find((step: { id?: string }) => step.id === "scope");
      const patterns = scope.with.paths.trim().split("\n");
      expect(workflow.on.push.paths).toEqual(workflow.on.pull_request.paths);
      for (const path of workflow.on.push.paths.filter(
        (pattern: string) => !pattern.startsWith("!"),
      )) {
        expect(
          patterns.some((pattern: string) => matchesGlob(path, pattern)),
          path,
        ).toBe(true);
      }
      for (const filename of [
        "src/cli/plugins-scaffold-config.ts",
        "src/gateway/node-command-policy.ts",
        "src/infra/node-commands.ts",
        "packages/normalization-core/src/record-coerce.ts",
        "scripts/test-projects.mts",
        "scripts/postinstall-bundled-plugins.mjs",
        "vitest.config.ts",
      ]) {
        const { output } = await scheduledScope({ paths: scope.with.paths, files: [{ filename }] });
        expect(output, filename).toHaveBeenCalledExactlyOnceWith("changed", true);
      }
      for (const [id, job] of Object.entries(workflow.jobs) as [string, { if: string }][]) {
        if (id === "scope") {
          continue;
        }
        const evaluate = (event: string, changed: string) =>
          runInNewContext(job.if.slice(3, -2), {
            github: {
              event_name: event,
              repository: "openclaw/openclaw",
              ref: "refs/heads/main",
              event: { pull_request: { draft: false } },
            },
            vars: {},
            cancelled: () => false,
            needs: { scope: { outputs: { changed } } },
          });
        expect([
          evaluate("schedule", "false"),
          evaluate("schedule", "true"),
          evaluate("pull_request", ""),
          evaluate("workflow_dispatch", ""),
        ]).toEqual([false, true, true, true]);
      }
    },
  );
});

describe("workflow cost admission", () => {
  it.each(["ci-check-testbox", "ci-check-arm-testbox", "ci-build-artifacts-testbox"])(
    "keeps %s scoped to its hydration inputs",
    (name) => {
      const workflow = readWorkflow(`.github/workflows/${name}.yml`);
      const accepts = (file: string) => acceptsPaths(workflow.on.pull_request.paths, [file]);
      expect(accepts(".github/workflows/docs.yml")).toBe(false);
      for (const path of ["scripts/README.md", "scripts/AGENTS.md", "patches/README.md"]) {
        expect(accepts(path), path).toBe(false);
      }
      for (const path of [
        `.github/workflows/${name}.yml`,
        ".github/actions/setup-node-env/install-dependencies.sh",
        ".github/actions/prepare-testbox-shell/preserve-command-cwd.py",
        "scripts/postinstall-bundled-plugins.mjs",
        "scripts/lib/fs-safe-prebuild.mjs",
        "scripts/lib/pnpm-lockfile-documents.mjs",
        "scripts/prepare-git-hooks.mjs",
        "scripts/ci-hydrate-testbox-env.sh",
        ".npmrc",
        "packages/fs-safe/package.json",
        "patches/vitest@5.0.1.patch",
        "patches/runtime-fixture.md",
      ]) {
        expect(accepts(path), path).toBe(true);
      }
      expect(workflow.on.workflow_dispatch).toBeDefined();
    },
  );

  it("keeps conflict markers global and scopes workflow audits only after successful lookup", async () => {
    const workflow = readWorkflow(".github/workflows/workflow-sanity.yml");
    expect(workflow.jobs["no-tabs"]).toBeUndefined();
    const steps = workflow.jobs.actionlint.steps;
    expect(
      steps.find(
        (step: { name: string }) => step.name === "Disallow tracked merge conflict markers",
      ).if,
    ).toBeUndefined();
    const scope = steps.find((step: { id?: string }) => step.id === "scope");
    for (const { eventName, filename, changed } of [
      { eventName: "pull_request", filename: "docs/intro.md", changed: false },
      { eventName: "pull_request", filename: ".github/actions/example/action.yml", changed: true },
      { eventName: "pull_request", filename: null, changed: true },
      { eventName: "push", filename: null, changed: true },
    ]) {
      const output = vi.fn();
      const warning = vi.fn();
      const lookup = filename
        ? vi.fn().mockResolvedValue([{ filename }])
        : vi.fn().mockRejectedValue(new Error("unavailable"));
      await runInNewContext(`(async () => { ${scope.with.script} })()`, {
        require: () => ({ matchesGlob }),
        context: { ...context, eventName, issue: { number: 1 }, payload: { before } },
        core: { setOutput: output, warning },
        github: {
          paginate: lookup,
          rest: { pulls: { listFiles: vi.fn() }, repos: { compareCommitsWithBasehead: lookup } },
        },
      });
      expect(output).toHaveBeenCalledExactlyOnceWith("changed", changed);
      if (filename === null) {
        expect(lookup).toHaveBeenCalledOnce();
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          "Workflow scope lookup failed; running full workflow audits.",
        );
      }
    }
    for (const name of [
      "Fail on tabs in workflow files",
      "Install pre-commit",
      "Install ShellCheck",
      "Setup Go",
      "Install actionlint",
      "Audit all workflows with zizmor",
    ]) {
      expect(steps.find((step: { name: string }) => step.name === name).if).toBe(
        "steps.scope.outputs.changed == 'true'",
      );
    }
  });

  it("keeps closeout on release-input pushes and the existing manual completion route", () => {
    const workflow = readWorkflow(".github/workflows/openclaw-stable-main-closeout.yml");
    expect(workflow.on.workflow_run).toBeUndefined();
    expect(workflow.on.workflow_dispatch.inputs.tag).toBeDefined();
    expect(workflow.jobs.resolve.if).toBeUndefined();
    for (const filename of [
      "package.json",
      "CHANGELOG/2026.9.1.md",
      "appcast-arm64.xml",
      "scripts/linux-updater-manifest.mjs",
    ]) {
      expect(acceptsPaths(workflow.on.push.paths, [filename]), filename).toBe(true);
    }
    expect(acceptsPaths(workflow.on.push.paths, ["src/agents/example.ts"])).toBe(false);
    const resolver = workflow.jobs.resolve.steps.find(
      (step: { id?: string }) => step.id === "inputs",
    );
    expect(resolver.env.EVENT_NAME).toBe("${{ github.event_name }}");
    expect(resolver.run).not.toContain("sleep 45");
  });

  it("keeps hourly docs in CI for both ordinary and RunsOn routing", () => {
    const docs = readWorkflow(".github/workflows/docs.yml");
    expect(docs.on.schedule).toBeUndefined();
    const manifest = readCiWorkflow().jobs.preflight.steps.find(
      (step: { id?: string }) => step.id === "manifest",
    );
    for (const backend of ["", "runson"]) {
      expect(
        runInNewContext(manifest.env.OPENCLAW_CI_DOCS_CHANGED.slice(3, -2), {
          github: { event_name: "schedule" },
          inputs: {},
          steps: {
            runner_profile: { outputs: { node_runner_backend: backend } },
            docs_scope: { outputs: {} },
          },
        }),
      ).toBe("true");
    }
  });
});
