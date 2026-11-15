import { matchesGlob } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  acceptsWorkflowPaths,
  evaluateWorkflow,
  readCiWorkflow,
  readWorkflow,
} from "./ci-workflow.test-support.js";

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

describe("Darwin tooling event scope", () => {
  const workflow = readWorkflow(".github/workflows/pr-tooling-darwin.yml");
  it.each([
    [["scripts/lib/ci-node-test-plan.mts"], false],
    [["scripts/lib/ci-extension-test-shards.mts"], false],
    [["scripts/lib/ci-native-generated-scope.mjs"], false],
    [["test/scripts/pr-ci-sweeper.test.ts"], false],
    [["test/scripts/pr-ci-sweeper.test-support.ts"], false],
    [["test/scripts/pr-prepare-gates.test.ts"], false],
    [["test/scripts/pr-review-artifact-validation.test.ts"], false],
    [["test/scripts/pr-main-refresh.test.ts"], false],
    [["test/scripts/pr-future.test.ts"], false],
    ...["test/helpers", "src/test-utils"].flatMap<[string[], boolean]>((directory) => [
      [[`${directory}/example.test.ts`], false],
      [[`${directory}/future/nested.test.ts`], false],
      [[`${directory}/example.ts`], true],
      [[`${directory}/future/nested.ts`], true],
      [[`${directory}/example.test.ts`, `${directory}/other.ts`], true],
      [[`${directory}/example.test.ts`, "test/scripts/pr-wrappers.test.ts"], true],
      [[`${directory}/example.test.ts`, `${directory}/other.test.ts`], false],
    ]),
    [["test/scripts/pr-dependency-cache.test.ts"], true],
    [["test/scripts/pr-wrappers.test.ts"], true],
    [["test/scripts/pr-materialized-anchor.test.ts"], true],
    [["test/scripts/pr-operation-lock.test.ts"], true],
    [["test/scripts/pr-git-invocation.test.ts"], true],
    [["test/scripts/package-mac-dist.test.ts"], true],
    [["scripts/package-mac-dist.sh"], true],
    [["scripts/notarize-mac-artifact.sh"], true],
    [["src/infra/directory-walk.ts"], true],
    [["test/scripts/package-mac-app.test.ts"], false],
    [["src/infra/directory-walk.test.ts"], false],
    [["test/scripts/pr-wrapper.test-support.ts"], true],
    [["test/scripts/pr-main-refresh.test-support.ts"], true],
    [["test/scripts/pr-darwin-process-identity.test.py"], true],
    [["test/scripts/pr-future-input.json"], true],
    [["test/scripts/pr-future.test.ts", "test/scripts/pr-wrappers.test.ts"], true],
    [["test/scripts/pr-future.test.ts", "scripts/pr-lib/materialized-anchor.mjs"], true],
    [["test/scripts/pr-future.test.ts", "test/scripts/pr-ci-sweeper.test-support.ts"], false],
    [["scripts/lib/ci-test-timings.mts"], true],
    [["scripts/lib/ci-test-timings-schema.mts"], true],
    [["scripts/lib/ci-test-timings-refit.mts"], true],
    [["scripts/lib/ci-node-test-groups-codec.mts"], true],
    [["scripts/lib/ci-static-check-evidence.mjs"], true],
    [["scripts/lib/new-native-input.mts"], true],
    [["scripts/lib/ci-node-test-plan.mts", "scripts/pr"], true],
    [[".github/workflows/pr-tooling-darwin.yml"], true],
  ] as const)("routes %j", (files, expected) => {
    expect(acceptsWorkflowPaths(workflow.on.pull_request.paths, files)).toBe(expected);
  });

  it("executes native tooling once with unconditional macOS distribution coverage", () => {
    const steps = workflow.jobs.darwin.steps.filter((step: { run?: string }) =>
      step.run?.startsWith("node scripts/run-vitest.mjs "),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].run.split(/\s+/u)).toContain("test/scripts/package-mac-dist.test.ts");
    expect(steps[0].if).toBeUndefined();
  });
});

describe("native locale refresh event scope", () => {
  it.each([
    [["apps/ios/README.md"], false],
    [["apps/ios/AGENTS.md"], false],
    [["apps/ios/README.md", "apps/ios/AGENTS.md"], false],
    [["apps/ios/README.md", "apps/ios/Sources/App.swift"], true],
    [["apps/ios/Info.plist"], true],
    [["apps/ios/Localizable.xcstrings"], true],
    [["apps/.i18n/native-source.json"], true],
    [["scripts/native-app-i18n.ts"], true],
    [[".github/workflows/native-app-locale-refresh.yml"], true],
  ] as const)("routes %j", (files, expected) => {
    const workflow = readWorkflow(".github/workflows/native-app-locale-refresh.yml");
    expect(acceptsWorkflowPaths(workflow.on.push.paths, files)).toBe(expected);
    expect(workflow.on.workflow_dispatch).toBeDefined();
  });
});

describe("plugin scaffold event scope", () => {
  it.each([
    [["src/plugin-sdk/AGENTS.md"], false],
    [["src/plugin-sdk/index.ts"], true],
    [["src/plugin-sdk/AGENTS.md", "src/plugin-sdk/index.ts"], true],
    [["src/plugin-sdk/runtime-fixture.md"], true],
    [[".github/workflows/plugin-init-scaffold-validation.yml"], true],
  ] as const)("routes %j", (files, expected) => {
    const workflow = readWorkflow(".github/workflows/plugin-init-scaffold-validation.yml");
    expect(workflow.jobs["validate-provider-scaffold"]["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.on.push.paths).toEqual(workflow.on.pull_request.paths);
    for (const event of ["push", "pull_request"]) {
      expect(acceptsWorkflowPaths(workflow.on[event].paths, files)).toBe(expected);
    }
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.on.schedule).toBeDefined();
  });
});

async function scheduledScope(
  options: {
    files?: Array<{ filename: string; previous_filename?: string }>;
    status?: string;
    ageHours?: number;
    skipFirst?: boolean;
    recentJobs?: string[];
    unavailable?: boolean;
    paths?: string;
    missingProof?: boolean;
    identical?: boolean;
    proofJobs?: string;
    completedJobs?: string[];
    codeqlConfig?: string;
    profile?: Record<string, unknown>;
    proofs?: string;
    attributes?: [string, string];
    attributeModes?: [string, string];
    gitFiles?: string[];
    gitFailure?: "fetch" | "diff";
    gitOutput?: string;
    gitHead?: string;
  } = {},
) {
  const proof = {
    id: 90,
    event: "schedule",
    head_sha: options.identical ? head : before,
    run_attempt: 1,
    head_repository: { full_name: "openclaw/openclaw" },
  };
  const jobs = (options.completedJobs ?? ["Proof"]).map((name) => ({
    name,
    head_sha: options.identical ? head : before,
    conclusion: "success",
    completed_at: new Date(Date.now() - (options.ageHours ?? 1) * 3600_000).toISOString(),
  }));
  const list = vi.fn().mockResolvedValue({
    data: {
      workflow_runs:
        options.skipFirst || options.recentJobs
          ? [
              { ...proof, id: 99, ...(options.recentJobs ? { head_sha: "c".repeat(40) } : {}) },
              proof,
            ]
          : [proof],
    },
  });
  if (options.unavailable) {
    list.mockRejectedValue(new Error("unavailable"));
  }
  const paginate = vi
    .fn()
    .mockImplementation((_method, args) =>
      args.run_id === 99
        ? (options.recentJobs?.map((name) => ({ ...jobs[0], name, head_sha: "c".repeat(40) })) ?? [
            { ...jobs[0], conclusion: "skipped" },
          ])
        : options.missingProof
          ? []
          : jobs,
    );
  const output = vi.fn();
  const notice = vi.fn();
  const compare = vi.fn().mockResolvedValue({
    data: { status: options.status ?? "ahead", files: options.files ?? [] },
  });
  if (options.recentJobs) {
    compare.mockImplementation(({ basehead }) =>
      Promise.resolve({
        data: {
          status: "ahead",
          files: basehead.startsWith("c".repeat(40)) ? [] : (options.files ?? []),
        },
      }),
    );
  }
  const execute = vi.fn(async (command: string, args: string[]) => {
    if (command === "yq") {
      return { stdout: JSON.stringify(options.profile ?? readWorkflow(args[2]!)) };
    }
    if (options.gitFailure && args.includes(options.gitFailure)) {
      throw new Error("Git unavailable");
    }
    if (args.includes("ls-tree")) {
      const index = args.includes(before) ? 0 : 1;
      return {
        stdout: `${options.attributeModes?.[index] ?? "100644"} blob ${String(index).repeat(40)}\t.gitattributes\0`,
      };
    }
    if (args[0] === "cat-file") {
      return { stdout: options.attributes?.[args[2] === "0".repeat(40) ? 0 : 1] ?? "" };
    }
    return {
      stdout:
        args[0] === "rev-parse"
          ? `${options.gitHead ?? head}\n`
          : args[0] === "diff"
            ? (options.gitOutput ?? (options.gitFiles ?? []).map((file) => `${file}\0`).join(""))
            : "",
    };
  });
  await runInNewContext(`(async () => { ${script} })()`, {
    require: () => ({ matchesGlob }),
    context,
    process: {
      env: {
        SCHEDULED_PATHS: options.paths ?? "src/contracts/**\n.github/actions/**",
        SCHEDULED_PROOF_JOBS: options.proofJobs ?? "Proof",
        SCHEDULED_PROOFS: options.proofs,
        SCHEDULED_CODEQL_CONFIG: options.codeqlConfig,
        SCHEDULED_GIT_DIFF: options.gitFiles ? "true" : "false",
        SCHEDULED_WORKFLOW_REF: "openclaw/openclaw/.github/workflows/example.yml@refs/heads/main",
      },
    },
    core: { setOutput: output, notice, warning: vi.fn() },
    exec: { getExecOutput: execute },
    github: {
      paginate,
      rest: {
        actions: { listWorkflowRuns: list, listJobsForWorkflowRunAttempt: vi.fn() },
        repos: {
          compareCommitsWithBasehead: compare,
        },
      },
    },
  });
  return { output, notice, paginate, list, compare, execute };
}

describe("bounded scheduled proof reuse", () => {
  it.each([
    { label: "unchanged inputs", files: [{ filename: "docs/intro.md" }], expected: false },
    { label: "changed contract", files: [{ filename: "src/contracts/node.ts" }], expected: true },
    {
      label: "renamed contract",
      files: [{ filename: "retired.ts", previous_filename: "src/contracts/node.ts" }],
      expected: true,
    },
    {
      label: "truncated diff",
      files: Array.from({ length: 300 }, (_, index) => ({ filename: `docs/${index}.md` })),
      expected: true,
    },
    { label: "same SHA", identical: true, expected: false },
    { label: "missing completed jobs", missingProof: true, expected: true },
    { label: "diverged history", status: "diverged", expected: true },
    { label: "daily external drift", ageHours: 25, expected: true },
    { label: "unavailable proof", unavailable: true, expected: true },
    { label: "skip-only success never advances the baseline", skipFirst: true, expected: false },
  ])("$label", async ({ expected, ...options }) => {
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
      const patterns = workflow.jobs.scope.steps
        .filter((step: { with?: { paths?: string } }) => step.with?.paths)
        .flatMap((step: { with: { paths: string } }) => step.with.paths.trim().split("\n"));
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
            needs: { scope: { outputs: { changed, rust_changed: changed } } },
          });
        expect(evaluate("schedule", "false")).toBe(false);
        expect(evaluate("schedule", "true")).toBe(true);
        expect(evaluate("pull_request", "")).toBe(true);
        expect(evaluate("workflow_dispatch", "")).toBe(true);
      }
    },
  );
});

describe("scheduled CodeQL input reuse", () => {
  const workflow = readWorkflow(".github/workflows/codeql.yml");
  const scopes = workflow.jobs.scope.steps.filter(
    (step: { uses?: string }) => step.uses === "./.github/actions/detect-scheduled-changes",
  );
  const categories = [
    "core-auth-secrets",
    "channel-runtime-boundary",
    "network-ssrf-boundary",
    "mcp-process-tool-boundary",
    "process-exec-boundary",
    "plugin-trust-boundary",
    "actions",
  ];
  const completedJobs = categories.map((category) => `Security High (${category})`);

  async function selected(files: string[], options: Parameters<typeof scheduledScope>[0] = {}) {
    expect(scopes).toHaveLength(1);
    const { output } = await scheduledScope({
      completedJobs,
      files: files.map((filename) => ({ filename })),
      ...options,
      paths: scopes[0].with.paths,
      proofs: scopes[0].with.proofs,
    });
    const results = JSON.parse(output.mock.calls[0]![1]);
    return categories.filter((category) => results[category] !== false);
  }

  it.each([
    ["docs/intro.md", []],
    [".github/workflows/docs.yml", ["actions"]],
    ["src/process/exec.ts", ["mcp-process-tool-boundary", "process-exec-boundary"]],
    ["src/agents/bash-tools.exec-runtime.test.ts", []],
    ["src/process/exec.test.ts", []],
    ["src/infra/net/request.ts", ["network-ssrf-boundary"]],
    ["src/channels/.runtime.ts", ["channel-runtime-boundary"]],
    ["src/agents/nested/deep/auth-provider.ts", ["core-auth-secrets"]],
    ["src/plugins/runtime/package.json", ["plugin-trust-boundary"]],
    ["src/plugins/runtime/tsconfig.json", ["plugin-trust-boundary"]],
    ["ui/src/views/channels.ts", []],
    ["package.json", []],
    [".github/codeql/codeql-actions-critical-security.yml", categories],
    [".github/actions/detect-scheduled-changes/action.yml", categories],
    [".github/workflows/codeql.yml", categories],
    ["src/.hidden/.gitattributes", categories],
  ])("selects extraction profiles after %s changes", async (filename, expected) => {
    expect(await selected([filename as string])).toEqual(expected);
  });

  it("reuses each category's last actual proof, ignoring newer skipped jobs", async () => {
    expect(
      await selected(["docs/intro.md"], {
        completedJobs: completedJobs.filter(
          (name) => name !== "Security High (network-ssrf-boundary)",
        ),
        skipFirst: true,
      }),
    ).toEqual(["network-ssrf-boundary"]);
  });

  it("requires a complete diff before skipping a category beyond the API cap", async () => {
    const docs = Array.from({ length: 300 }, (_, index) => `docs/${index}.md`);
    expect(await selected(docs)).toEqual(categories);
    expect(await selected(docs, { gitFiles: [...docs, "src/infra/net/request.ts"] })).toEqual([
      "network-ssrf-boundary",
    ]);
    for (const failure of [
      { gitFailure: "fetch" as const },
      { gitFailure: "diff" as const },
      { gitHead: before },
      { gitOutput: "docs/incomplete" },
    ]) {
      expect(await selected(docs, { gitFiles: docs, ...failure })).toEqual(categories);
    }
  });

  it("shares raw lookups while retaining each category's completed proof", async () => {
    const docs = Array.from({ length: 300 }, (_, index) => ({ filename: `docs/${index}.md` }));
    const result = await scheduledScope({
      proofs: scopes[0].with.proofs,
      paths: scopes[0].with.paths,
      completedJobs: completedJobs.filter((job) => job !== "Security High (network-ssrf-boundary)"),
      skipFirst: true,
      files: docs,
      gitFiles: docs.map((file) => file.filename),
    });
    expect(result.output).toHaveBeenCalledExactlyOnceWith(
      "proofs",
      JSON.stringify(
        Object.fromEntries(
          categories.map((category) => [category, category === "network-ssrf-boundary"]),
        ),
      ),
    );
    expect(result.list).toHaveBeenCalledOnce();
    expect(result.paginate.mock.calls.map(([, args]) => args.run_id)).toEqual([99, 90]);
    expect(result.compare).toHaveBeenCalledOnce();
    expect(result.execute.mock.calls.filter(([, args]) => args.includes("fetch"))).toHaveLength(1);
    expect(result.execute.mock.calls.filter(([, args]) => args[0] === "diff")).toHaveLength(1);
  });

  it("compares each category against its own successful revision", async () => {
    const result = await scheduledScope({
      proofs: scopes[0].with.proofs,
      paths: scopes[0].with.paths,
      completedJobs,
      recentJobs: ["Security High (mcp-process-tool-boundary)"],
      files: [{ filename: "src/process/exec.ts" }],
    });
    const decisions = JSON.parse(result.output.mock.calls[0]![1]);
    expect(decisions["mcp-process-tool-boundary"]).toBe(false);
    expect(decisions["process-exec-boundary"]).toBe(true);
    expect(result.compare.mock.calls.map(([args]) => args.basehead)).toEqual([
      `${before}...${head}`,
      `${"c".repeat(40)}...${head}`,
    ]);
    expect(result.paginate.mock.calls.map(([, args]) => args.run_id)).toEqual([99, 90]);
  });

  it.each([
    ["src/*.test.ts", "src/deep/example.test.ts", true],
    ["src/*.test.ts", "src/example.test.ts", false],
    ["**/*.test.ts", "src/deep/example.test.ts", false],
    ["**/*.test.ts", "src/example.test.ts\n", true],
    ["**/*.test.ts\n", "docs/intro.md", true],
    ["**/*.test.ts", "example.test.ts", false],
    ["src/**/fixtures", "src/fixtures/data.ts", false],
    ["src/**/fixtures", "src/deep/fixtures/data.ts", false],
    ["src/**/fixtures", "src/deep/fixtures-other/data.ts", true],
    ["src/**foo", "docs/intro.md", true],
    ["src/", "docs/intro.md", true],
    ["src/[a-z]", "docs/intro.md", true],
  ])("matches exclusion %s against %s conservatively", async (pattern, filename, expected) => {
    const { output } = await scheduledScope({
      codeqlConfig: "profile.yml",
      profile: {
        paths: ["src", "*.test.ts"],
        "paths-ignore": [pattern],
        queries: [{ uses: "security-extended" }],
      },
      files: [{ filename }],
    });
    expect(output).toHaveBeenCalledExactlyOnceWith("changed", expected);
  });

  it("never excludes a shared query or tooling input", async () => {
    expect(
      await selected([".github/workflows/codeql.yml"], {
        profile: {
          paths: ["src"],
          "paths-ignore": ["**"],
          queries: [{ uses: "security-extended" }],
        },
      }),
    ).toEqual(categories);
  });

  it.each([
    [
      "*.ts text\n",
      "*.ts text\n# Preserve immutable upstream bytes.\napps/ios/** -whitespace\napps/shared/** -whitespace\n",
      false,
    ],
    ["*.ts text\napps/ios/** -whitespace\n", "*.ts text\n", false],
    ["*.ts text\n", "*.ts -text\n", true],
    ["*.ts text\n\uFFFD", "*.ts text\n\uFFFD", true],
    ["*.ts text\n", "*.ts text -whitespace\n", true],
    ["*.ts text\n", "[attr]whitespace -text\n*.ts text\n", true],
    ["*.ts text\n", '"apps/ios/**" -whitespace\n*.ts text\n', true],
  ])(
    "only ignores standalone whitespace diagnostic rules",
    async (oldContent, newContent, changed) => {
      expect(
        await selected([".gitattributes"], {
          gitFiles: [],
          attributes: [oldContent, newContent],
        }),
      ).toEqual(changed ? categories : []);
    },
  );

  it("retains scans for attribute mode changes or unavailable exact blobs", async () => {
    for (const failure of [
      { attributeModes: ["100644", "120000"] as [string, string] },
      { attributeModes: ["100644", "100755"] as [string, string] },
      { gitFailure: "fetch" as const },
      { gitHead: before },
    ]) {
      expect(await selected([".gitattributes"], { gitFiles: [], ...failure })).toEqual(categories);
    }
  });

  it("includes a rename's old extraction path", async () => {
    expect(
      await selected([], {
        files: [{ filename: "retired.ts", previous_filename: "src/infra/net/request.ts" }],
      }),
    ).toEqual(["network-ssrf-boundary"]);
  });

  it("runs every profile when its input contract is unsupported", async () => {
    for (const profile of [
      { paths: [], queries: [{ uses: "security-extended" }] },
      ...["src/[a-z]", "src/", "./src", "."].map((path) => ({
        paths: [path],
        queries: [{ uses: "security-extended" }],
      })),
      { paths: ["src"], queries: [{ uses: "./custom-query.ql" }] },
    ]) {
      expect(await selected(["docs/intro.md"], { profile })).toEqual(categories);
    }
  });
});

describe("independent scheduled node runtime proofs", () => {
  const workflow = readWorkflow(".github/workflows/node-runtime-conformance.yml");
  const detectors = workflow.jobs.scope.steps.filter(
    (step: { uses?: string }) => step.uses === "./.github/actions/detect-scheduled-changes",
  );

  async function admitted(options: Parameters<typeof scheduledScope>[0]) {
    const steps = Object.fromEntries(
      await Promise.all(
        detectors.map(
          async (step: { id: string; with: { paths: string; "proof-jobs": string } }) => {
            const { output } = await scheduledScope({
              completedJobs: ["TypeScript contracts", "Rust workspace"],
              ...options,
              paths: step.with.paths,
              proofJobs: step.with["proof-jobs"],
            });
            return [step.id, { outputs: { changed: String(output.mock.calls[0]![1]) } }];
          },
        ),
      ),
    );
    const outputs = Object.fromEntries(
      Object.entries(workflow.jobs.scope.outputs).map(([key, value]) => [
        key,
        runInNewContext((value as string).slice(3, -2), {
          steps: { ...steps, pr_scope: { outputs: {} } },
        }),
      ]),
    );
    return Object.fromEntries(
      ["typescript", "rust"].map((id) => [
        id,
        runInNewContext(workflow.jobs[id].if.slice(3, -2), {
          github: { event_name: "schedule", repository: "openclaw/openclaw" },
          cancelled: () => false,
          needs: { scope: { outputs } },
        }),
      ]),
    );
  }

  it.each([
    ["src/agents/run.ts", true, false],
    ["scripts/run-vitest.mjs", true, false],
    ["test/scripts/example.test.ts", true, false],
    ["package.json", true, false],
    ["pnpm-lock.yaml", true, false],
    ["crates/openclaw-node-host/src/main.rs", true, true],
    ["packages/gateway-protocol/src/version.ts", true, true],
    ["test/fixtures/node-invoke-lifecycle-contract.json", true, true],
    [".github/workflows/node-runtime-conformance.yml", true, true],
    [".github/actions/detect-scheduled-changes/action.yml", true, true],
    [".cargo/config", false, true],
    [".cargo/config.toml", false, true],
    ["rust-toolchain.toml", false, true],
    ["rustfmt.toml", false, true],
    [".rustfmt.toml", false, true],
    ["clippy.toml", false, true],
    [".clippy.toml", false, true],
    [".gitattributes", false, true],
    ["docs/intro.md", false, false],
  ] as const)("admits %s only to its consuming proofs", async (filename, typescript, rust) => {
    expect(await admitted({ files: [{ filename }] })).toEqual({ typescript, rust });
  });

  it.each([
    { completedJobs: ["TypeScript contracts"], typescript: false, rust: true },
    { completedJobs: ["Rust workspace"], typescript: true, rust: false },
    { completedJobs: [], typescript: true, rust: true },
  ])(
    "requires each proof's own completed job: $completedJobs",
    async ({ completedJobs, ...expected }) => {
      expect(await admitted({ completedJobs })).toEqual(expected);
    },
  );
});

describe("pull request node contract owners", () => {
  const workflow = readWorkflow(".github/workflows/node-runtime-conformance.yml");
  const step = workflow.jobs.scope.steps.find((entry: { id?: string }) => entry.id === "pr_scope");

  it.each([
    {
      files: [{ filename: "scripts/lib/ci-node-test-plan.mts", status: "modified" }],
      expected: [true, false],
    },
    {
      files: [
        { filename: "test/vitest/vitest.ui-paths.mjs", status: "modified" },
        { filename: "ui/src/pages/model-providers/view.tsx", status: "modified" },
        { filename: "config/test-lines-allocations/ui-coverage.txt", status: "added" },
      ],
      expected: [true, false],
    },
    {
      files: [
        { filename: "ui/src/retired.ts", status: "removed" },
        { filename: "scripts/new.mjs", status: "modified" },
      ],
      expected: [true, true],
    },
    {
      files: [
        { filename: ".cargo/config.toml", status: "modified" },
        { filename: "ui/config/control-ui-solid.ts", status: "modified" },
      ],
      expected: [true, true],
    },
    { files: [{ filename: ".cargo/config.toml", status: "modified" }], expected: [false, true] },
    {
      files: [{ filename: "crates/openclaw-node-host/src/main.rs", status: "modified" }],
      expected: [true, true],
    },
    {
      files: [{ filename: "packages/gateway-protocol/src/version.ts", status: "modified" }],
      expected: [true, true],
    },
    {
      files: [{ filename: "test/fixtures/node-sidecar-handshake-v1.json", status: "modified" }],
      expected: [true, true],
    },
    {
      files: [
        { filename: "package.json", status: "modified" },
        { filename: ".cargo/config.toml", status: "modified" },
      ],
      expected: [true, true],
    },
    {
      files: [
        { filename: "scripts/new.mjs", previous_filename: ".cargo/config.toml", status: "renamed" },
      ],
      expected: [true, true],
    },
    { files: [{ filename: "scripts/old.mjs", status: "removed" }], expected: [true, true] },
    { files: [{ filename: "docs/intro.md", status: "modified" }], expected: [true, true] },
    { files: [{ status: "modified" }], expected: [true, true] },
    { files: [{ filename: "scripts/new.mjs", status: "renamed" }], expected: [true, true] },
    { files: [], expected: [true, true] },
    { files: undefined, expected: [true, true] },
    {
      files: Array.from({ length: 300 }, () => ({ filename: "package.json", status: "modified" })),
      expected: [true, true],
    },
    { unavailable: true, expected: [true, true] },
    { missingHead: true, expected: [true, true] },
  ])(
    "selects from exact complete inputs: %#",
    async ({ files, unavailable, missingHead, expected }) => {
      const output = vi.fn();
      const compare = unavailable
        ? vi.fn().mockRejectedValue(new Error("unavailable"))
        : vi.fn().mockResolvedValue({ data: { files } });
      await runInNewContext(`(async () => { ${step.with.script} })()`, {
        require: () => ({ matchesGlob }),
        process: { env: step.env },
        context: {
          ...context,
          payload: {
            pull_request: { base: { sha: before }, head: { sha: missingHead ? "" : head } },
          },
        },
        core: { setOutput: output, warning: vi.fn() },
        github: { rest: { repos: { compareCommitsWithBasehead: compare } } },
      });
      expect(output.mock.calls).toEqual([
        ["changed", expected[0]],
        ["rust_changed", expected[1]],
      ]);
      if (!missingHead) {
        expect(compare).toHaveBeenCalledExactlyOnceWith({
          ...context.repo,
          basehead: `${before}...${head}`,
        });
      }
      const steps = {
        pr_scope: {
          outputs: Object.fromEntries(
            output.mock.calls.map(([key, value]) => [key, String(value)]),
          ),
        },
        scope: { outputs: {} },
        rust_scope: { outputs: {} },
      };
      const outputs = Object.fromEntries(
        Object.entries(workflow.jobs.scope.outputs).map(([key, expression]) => [
          key,
          runInNewContext((expression as string).slice(3, -2), { steps }),
        ]),
      );
      for (const [index, id] of ["typescript", "rust"].entries()) {
        expect(
          evaluateWorkflow(workflow.jobs[id].if, {
            eventName: "pull_request",
            additionalNeeds: { scope: { outputs } },
          }),
        ).toBe(expected[index]);
      }
    },
  );

  it("keeps manual, missing evidence and draft admission policies", () => {
    for (const id of ["typescript", "rust"]) {
      for (const eventName of ["pull_request", "workflow_dispatch"] as const) {
        expect(
          evaluateWorkflow(workflow.jobs[id].if, {
            eventName,
            additionalNeeds: { scope: { outputs: {} } },
          }),
        ).toBe(true);
      }
      expect(
        evaluateWorkflow(workflow.jobs[id].if, {
          eventName: "pull_request",
          draft: true,
          additionalNeeds: { scope: { outputs: {} } },
        }),
      ).toBe(false);
    }
    expect(
      evaluateWorkflow(`\${{ ${workflow.jobs.scope.if} }}`, { eventName: "pull_request" }),
    ).toBe(true);
    expect(
      evaluateWorkflow(`\${{ ${workflow.jobs.scope.if} }}`, {
        eventName: "pull_request",
        draft: true,
      }),
    ).toBe(false);
    expect(
      evaluateWorkflow(`\${{ ${workflow.jobs.scope.if} }}`, { eventName: "workflow_dispatch" }),
    ).toBe(false);
  });
});

describe("node runtime event scope", () => {
  it.each([
    [["patches/README.md"], false],
    [["patches/vitest@5.0.1.patch"], true],
    [["patches/README.md", "patches/vitest@5.0.1.patch"], true],
    [["patches/runtime-fixture.md"], true],
    [["crates/openclaw-node-host/SIDECAR_PROTOCOL.md"], false],
    [
      ["crates/openclaw-node-host/SIDECAR_PROTOCOL.md", "crates/openclaw-node-host/src/main.rs"],
      true,
    ],
    [["crates/openclaw-node-host/Cargo.toml"], true],
    [[".cargo/config.toml"], true],
    [["ui/config/control-ui-solid.ts"], true],
    [["rust-toolchain.toml"], true],
    [["test/fixtures/node-sidecar-handshake-v1.json"], true],
    [["crates/openclaw-node-host/tests/fixtures/README.md"], true],
    [[".github/workflows/node-runtime-conformance.yml"], true],
  ] as const)("routes %j", (files, expected) => {
    const workflow = readWorkflow(".github/workflows/node-runtime-conformance.yml");
    for (const event of ["push", "pull_request"]) {
      expect(acceptsWorkflowPaths(workflow.on[event].paths, files)).toBe(expected);
    }
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.on.schedule).toBeDefined();
  });
});

describe("workflow cost admission", () => {
  it.each(["ci-check-testbox", "ci-check-arm-testbox", "ci-build-artifacts-testbox"])(
    "keeps %s scoped to its hydration inputs",
    (name) => {
      const workflow = readWorkflow(`.github/workflows/${name}.yml`);
      const accepts = (file: string) =>
        acceptsWorkflowPaths(workflow.on.pull_request.paths, [file]);
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
      expect(["patches/README.md", "patches/vitest@5.0.1.patch"].some(accepts)).toBe(true);
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
          rest: {
            pulls: { listFiles: vi.fn() },
            repos: { compareCommitsWithBasehead: lookup },
          },
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
      expect(workflow.on.push.paths.some((pattern: string) => matchesGlob(filename, pattern))).toBe(
        true,
      );
    }
    expect(
      workflow.on.push.paths.some((pattern: string) =>
        matchesGlob("src/agents/example.ts", pattern),
      ),
    ).toBe(false);
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
