import { execFileSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCrabboxGateCommand,
  crabboxGatePlanDigest,
  formatCrabboxGateCheckSummary,
  parseCrabboxGateCheckSummary,
} from "../../scripts/pr-lib/crabbox-gate-contract.mjs";
import { createCrabboxGatePlan } from "../../scripts/pr-lib/crabbox-gate-plan.mts";
import {
  buildVitestRunPlans,
  UI_E2E_VITEST_CONFIG,
} from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const bootstrapSha256 = "c".repeat(64);
const workflowSha = "d".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createTrackedFixture(files: Record<string, string>) {
  const cwd = tempDirs.make("pr-crabbox-ui-plan-");
  for (const [file, contents] of Object.entries(files)) {
    const absolute = path.join(cwd, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  const options = { cwd, env: createNestedGitEnv(), stdio: "ignore" as const };
  execFileSync("git", ["init", "-q"], options);
  execFileSync("git", ["add", "--force", "--", "."], options);
  return cwd;
}

function planFixture(cwd: string, paths: string[]) {
  return createCrabboxGatePlan({
    baseSha,
    cwd,
    changedPaths: paths.map((changedPath) => ({ path: changedPath, status: "M" })),
    headSha,
  });
}

const ordinaryUiTests = [
  "extensions/example/browser/view.test.ts",
  "ui/src/app/bootstrap.test.ts",
  "ui/src/components/markdown.progress.node.test.ts",
  "ui/src/presenter.test.ts",
  "ui/src/unrelated.browser.test.ts",
];

function createUiFixture() {
  return createTrackedFixture({
    "ui/src/presenter.ts": "export const value = 1;\n",
    "ui/src/theme.css": ".example { color: red; }\n",
    "ui/src/catalog.json": '{"label":"Example"}\n',
    "extensions/example/browser/view.ts": "export const view = 1;\n",
    ...Object.fromEntries(ordinaryUiTests.map((file) => [file, "export {};\n"])),
    "ui/src/e2e/example.e2e.test.ts": "export {};\n",
    "ui/src/ignored.live.test.ts": "export {};\n",
    "ui/src/vendor/ignored.test.ts": "export {};\n",
    "ui/src/node_modules/ignored.test.ts": "export {};\n",
    "ui/src/._ignored.test.ts": "export {};\n",
    "src/ui-consumer.test.ts": 'import "../ui/src/presenter.js";\n',
    "test/scripts/ui-catalog-reader.test.ts":
      'import { readFileSync } from "node:fs"; readFileSync("ui/src/catalog.json", "utf8");\n',
    "src/unrelated.test.ts": "export {};\n",
  });
}

describe("Crabbox PR-derived gate plan", () => {
  it("resolves Vitest inventory helpers to their concrete consumers without executing them", () => {
    const agents = "test/vitest/vitest.agents-paths.mjs";
    const cli = "test/vitest/vitest.cli-process-paths.mjs";
    const unowned = "test/vitest/vitest.unowned-paths.mjs";
    const cwd = createTrackedFixture({
      [agents]:
        'import { cliProcessTestFiles } from "./vitest.cli-process-paths.mjs";\n' +
        "export const agentFiles = cliProcessTestFiles;\n" +
        'throw new Error("Candidate inventory must not execute while planning");\n',
      [cli]:
        "export const cliProcessTestFiles = [];\n" +
        'throw new Error("Candidate inventory must not execute while planning");\n',
      [unowned]: "export {};\n",
      "test/vitest/vitest.unit-fast-paths.mjs":
        'export { agentFiles } from "./vitest.agents-paths.mjs";\n',
      "scripts/test-projects.test-support.mts":
        'import "../test/vitest/vitest.agents-paths.mjs";\n' +
        'import "../test/vitest/vitest.cli-process-paths.mjs";\n',
      "test/scripts/test-projects.test.ts":
        'import "../../scripts/test-projects.test-support.mts";\n',
      "test/scripts/ci-node-test-plan.test.ts":
        'import "../vitest/vitest.agents-paths.mjs";\n' +
        'import "../vitest/vitest.cli-process-paths.mjs";\n',
      "test/vitest-scoped-config.test.ts":
        'import "./vitest/vitest.agents-paths.mjs";\n' +
        'import "./vitest/vitest.cli-process-paths.mjs";\n',
      "test/vitest-projects-config.test.ts": 'import "./vitest/vitest.agents-paths.mjs";\n',
      "test/vitest-unit-fast-config.test.ts": 'import "./vitest/vitest.unit-fast-paths.mjs";\n',
      "test/vitest/unrelated.test.ts": "export {};\n",
      "src/unrelated.test.ts": "export {};\n",
    });
    const consumers = [
      "test/scripts/ci-node-test-plan.test.ts",
      "test/scripts/test-projects.test.ts",
      "test/vitest-projects-config.test.ts",
      "test/vitest-scoped-config.test.ts",
      "test/vitest-unit-fast-config.test.ts",
    ];

    for (const changed of [[agents], [cli], [agents, cli]]) {
      const plan = planFixture(cwd, changed);
      expect(plan.targets).toEqual(consumers);
      expect(buildVitestRunPlans(plan.targets, cwd)).toEqual([
        {
          config: "test/vitest/vitest.tooling.config.ts",
          forwardedArgs: [],
          includePatterns: consumers,
          watchMode: false,
        },
      ]);
    }
    expect(() => planFixture(cwd, [agents, unowned])).toThrow(
      /broad or unmatched target test\/vitest\/vitest\.unowned-paths\.mjs/u,
    );
  });

  it.each([
    ...["ui/src/presenter.ts", "ui/src/theme.css", "extensions/example/browser/view.ts"].map(
      (file) => ({
        paths: [file],
        readers: ["src/ui-consumer.test.ts"],
        explicit: false,
      }),
    ),
    {
      paths: ["ui/src/catalog.json"],
      readers: ["src/ui-consumer.test.ts", "test/scripts/ui-catalog-reader.test.ts"],
      explicit: false,
    },
    ...["ui/src/presenter.test.ts", "ui/src/e2e/example.e2e.test.ts"].map((file) => ({
      paths: [file],
      readers: [],
      explicit: true,
    })),
    {
      paths: [
        "ui/src/presenter.ts",
        "ui/src/theme.css",
        "ui/src/presenter.test.ts",
        "ui/src/e2e/example.e2e.test.ts",
      ],
      readers: ["src/ui-consumer.test.ts", "ui/src/e2e/example.e2e.test.ts"],
      explicit: false,
    },
  ])("materializes precise UI coverage for $paths", ({ paths, readers, explicit }) => {
    expect(planFixture(createUiFixture(), paths).targets).toEqual(
      explicit ? paths : [...ordinaryUiTests, ...readers].toSorted(),
    );
  });

  it("uses the E2E helper's whole family, including native QA fixtures", () => {
    const helper = "ui/src/test-helpers/control-ui-e2e.ts";
    const tests = [
      "extensions/example/browser/view.e2e.test.ts",
      "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
      "ui/src/e2e/example.e2e.test.ts",
    ];
    const cwd = createTrackedFixture({
      [helper]: "export {};\n",
      ...Object.fromEntries(tests.map((file) => [file, "export {};\n"])),
      "ui/src/presenter.test.ts": "export {};\n",
      "ui/src/vendor/ignored.e2e.test.ts": "export {};\n",
    });
    const plan = planFixture(cwd, [helper]);
    expect(plan.targets).toEqual(tests);
    expect(buildVitestRunPlans(plan.targets, cwd)).toEqual([
      {
        config: UI_E2E_VITEST_CONFIG,
        forwardedArgs: [],
        includePatterns: tests,
        watchMode: false,
      },
    ]);
  });

  it("routes an explicit native QA fixture to its browser owner", () => {
    const target = "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts";
    const cwd = createTrackedFixture({ [target]: "export {};\n" });
    const plan = planFixture(cwd, [target]);
    expect(plan.targets).toEqual([target]);
    expect(buildVitestRunPlans(plan.targets, cwd)).toEqual([
      {
        config: UI_E2E_VITEST_CONFIG,
        forwardedArgs: [],
        includePatterns: [target],
        watchMode: false,
      },
    ]);
  });

  it.each([
    ["missing family", "ui/src/presenter.ts", /no complete Control UI test inventory/u],
    [
      "missing family",
      "ui/src/test-helpers/control-ui-e2e.ts",
      /no complete Control UI test inventory/u,
    ],
    [
      "missing tracked test",
      "ui/src/presenter.test.ts",
      /broad or unmatched target ui\/src\/presenter\.test\.ts/u,
    ],
    [
      "missing source",
      "ui/src/missing.ts",
      /deleted or missing executable path ui\/src\/missing\.ts/u,
    ],
    ["uncovered source", "src/uncovered.ts", undefined],
  ] as const)("refuses %s: %s", (kind, file, error) => {
    const cwd =
      kind === "missing family"
        ? createTrackedFixture({
            [file]: "export {};\n",
            "src/ui-consumer.test.ts": `import ${JSON.stringify(`../${file.replace(/\.ts$/u, ".js")}`)};\n`,
          })
        : createUiFixture();
    if (kind === "missing tracked test") {
      unlinkSync(path.join(cwd, file));
    }
    if (kind === "uncovered source") {
      writeFileSync(path.join(cwd, file), "export {};\n");
    }
    const paths =
      kind === "missing family"
        ? [file]
        : kind === "missing tracked test"
          ? ["ui/src/presenter.ts"]
          : ["ui/src/presenter.ts", file];
    expect(() => planFixture(cwd, paths)).toThrow(error);
  });

  it("keeps the tracked inventory local to each plan's checkout", () => {
    const first = createUiFixture();
    writeFileSync(path.join(first, "ui/src/untracked.test.ts"), "export {};\n");
    expect(planFixture(first, ["ui/src/presenter.ts"]).targets).not.toContain(
      "ui/src/untracked.test.ts",
    );
    const second = createTrackedFixture({
      "ui/src/another.ts": "export {};\n",
      "ui/src/another.test.ts": "export {};\n",
    });
    expect(planFixture(second, ["ui/src/another.ts"]).targets).toEqual(["ui/src/another.test.ts"]);
  });

  it.each([
    {
      mode: "targets",
      targets: [],
      error: /no complete targeted test plan for scripts\/pr-lib\/gates\.sh/u,
    },
    { mode: "broad", targets: [], error: undefined },
    {
      mode: "targets",
      skippedBroadFallbackPaths: ["scripts/pr"],
      targets: ["test/scripts/pr-merge.test.ts"],
      error: undefined,
    },
    { mode: "targets", targets: ["test/vitest/vitest.tooling.config.ts"], error: undefined },
  ])("rejects incomplete or broad authorization plan %#", ({ error, ...pathPlan }) => {
    expect(() =>
      createCrabboxGatePlan({
        baseSha,
        headSha,
        changedPaths: error
          ? [
              { path: "scripts/pr", status: "M" },
              { path: "scripts/pr-lib/gates.sh", status: "M" },
            ]
          : [{ path: "scripts/pr", status: "M" }],
        resolvePathPlan: (file) =>
          error && file === "scripts/pr"
            ? { mode: "targets", targets: ["test/scripts/pr-merge.test.ts"] }
            : pathPlan,
      }),
    ).toThrow(error);
  });

  it("allows zero test targets only for explicit docs and instruction surfaces", () => {
    expect(
      createCrabboxGatePlan({
        baseSha,
        changedPaths: [
          { path: "docs/ci.md", status: "M" },
          { path: "scripts/AGENTS.md", status: "M" },
        ],
        headSha,
        resolvePathPlan: () => {
          throw new Error("docs must not consult executable test routing");
        },
      }),
    ).toMatchObject({ targets: [] });
  });

  it("does not authorize an arbitrary broad PR with gate-only tests", () => {
    expect(() =>
      createCrabboxGatePlan({
        baseSha,
        changedPaths: [{ path: "package.json", status: "M" }],
        headSha,
      }),
    ).toThrow(/no complete targeted test plan for package\.json/u);
  });

  it("binds immutable proof into the command and publisher workflow into the summary", () => {
    const plan = createCrabboxGatePlan({
      baseSha,
      changedPaths: [{ path: "scripts/pr", status: "M" }],
      headSha,
      resolvePathPlan: () => ({
        mode: "targets",
        targets: ["test/scripts/pr-merge.test.ts"],
      }),
    });
    const digest = crabboxGatePlanDigest(plan);
    const command = buildCrabboxGateCommand(plan, bootstrapSha256);
    expect(command).toContain(`OPENCLAW_CRABBOX_GATE_BASE=${baseSha}`);
    expect(command).toContain(`OPENCLAW_CRABBOX_GATE_HEAD=${headSha}`);
    expect(command).not.toContain("OPENCLAW_CRABBOX_GATE_WORKFLOW=");
    expect(command).toContain(`OPENCLAW_CRABBOX_GATE_PLAN_SHA256=${digest}`);
    expect(command).toContain("test/scripts/pr-merge.test.ts");

    const summary = formatCrabboxGateCheckSummary({
      baseSha,
      headSha,
      leaseId: "cbx_def456",
      planDigest: digest,
      runId: "run_abc123",
      targetCount: 1,
      workflowSha,
    });
    expect(parseCrabboxGateCheckSummary(summary)).toEqual({
      baseSha,
      headSha,
      leaseId: "cbx_def456",
      planDigest: digest,
      runId: "run_abc123",
      targetCount: 1,
      workflowSha,
    });
  });

  it.skipIf(process.platform === "win32").each([undefined, "3"])(
    "preserves native worker sizing (%s) and forwards compact reporting for every target",
    (workers) => {
      const plan = createCrabboxGatePlan({
        baseSha,
        changedPaths: [{ path: "scripts/pr", status: "M" }],
        headSha,
        resolvePathPlan: () => ({
          mode: "targets",
          targets: ["test/scripts/pr-merge.test.ts"],
        }),
      });
      const command = buildCrabboxGateCommand(plan, bootstrapSha256);
      const output = execFileSync(
        "/bin/bash",
        [
          "-c",
          `pnpm() { :; }; node() { printf 'worker:%s\\n' "\${OPENCLAW_VITEST_MAX_WORKERS-auto}"; printf 'arg:%s\\n' "$@"; }; ${command}`,
        ],
        { encoding: "utf8", env: { ...process.env, OPENCLAW_VITEST_MAX_WORKERS: workers } },
      );
      expect(output).toContain(`worker:${workers ?? "auto"}\n`);
      const args = output
        .split("\n")
        .filter((line) => line.startsWith("arg:"))
        .map((line) => line.slice(4));
      expect(args.slice(0, 3)).toEqual([
        "--import",
        "./scripts/tsx.mjs",
        "scripts/test-projects.mts",
      ]);
      expect(buildVitestRunPlans(args.slice(3))).toMatchObject([
        {
          includePatterns: plan.targets,
          forwardedArgs: ["--reporter=dot", "--coverage.enabled=false"],
        },
      ]);
      expect(command).not.toContain("OPENCLAW_TEST_PROJECTS_PARALLEL");
      expect(command).not.toContain("--silent");
    },
  );
});
