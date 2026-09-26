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
  it.each(["ui/src/presenter.ts", "ui/src/theme.css", "extensions/example/browser/view.ts"])(
    "materializes the whole UI owner and host consumers for %s",
    (changedPath) => {
      expect(planFixture(createUiFixture(), [changedPath]).targets).toEqual([
        ordinaryUiTests[0],
        "src/ui-consumer.test.ts",
        ...ordinaryUiTests.slice(1),
      ]);
    },
  );

  it("retains changed-source readers for UI data files", () => {
    expect(planFixture(createUiFixture(), ["ui/src/catalog.json"]).targets).toEqual([
      ordinaryUiTests[0],
      "src/ui-consumer.test.ts",
      "test/scripts/ui-catalog-reader.test.ts",
      ...ordinaryUiTests.slice(1),
    ]);
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

  it.each([
    "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
    "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
    "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
    "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
  ])("routes the explicit native QA fixture to its browser owner: %s", (target) => {
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

  it.each(["ui/src/presenter.test.ts", "ui/src/e2e/example.e2e.test.ts"])(
    "keeps an explicit test target precise: %s",
    (changedPath) => {
      expect(planFixture(createUiFixture(), [changedPath]).targets).toEqual([changedPath]);
    },
  );

  it("unions explicit E2E targets with deduplicated whole-UI coverage", () => {
    expect(
      planFixture(createUiFixture(), [
        "ui/src/presenter.ts",
        "ui/src/theme.css",
        "ui/src/presenter.test.ts",
        "ui/src/e2e/example.e2e.test.ts",
      ]).targets,
    ).toEqual([
      ordinaryUiTests[0],
      "src/ui-consumer.test.ts",
      "ui/src/app/bootstrap.test.ts",
      "ui/src/components/markdown.progress.node.test.ts",
      "ui/src/e2e/example.e2e.test.ts",
      "ui/src/presenter.test.ts",
      "ui/src/unrelated.browser.test.ts",
    ]);
  });

  it.each(["ui/src/presenter.ts", "ui/src/test-helpers/control-ui-e2e.ts"])(
    "refuses missing family coverage even with a host consumer: %s",
    (changedPath) => {
      const cwd = createTrackedFixture({
        [changedPath]: "export {};\n",
        "src/ui-consumer.test.ts": `import ${JSON.stringify(`../${changedPath.replace(/\.ts$/u, ".js")}`)};\n`,
      });
      expect(() => planFixture(cwd, [changedPath])).toThrow(
        /no complete Control UI test inventory/u,
      );
    },
  );

  it("refuses tracked tests that disappeared from the selected checkout", () => {
    const cwd = createUiFixture();
    unlinkSync(path.join(cwd, "ui/src/presenter.test.ts"));
    expect(() => planFixture(cwd, ["ui/src/presenter.ts"])).toThrow(
      /broad or unmatched target ui\/src\/presenter\.test\.ts/u,
    );
  });

  it("does not let valid UI coverage authorize missing or uncovered executable paths", () => {
    const cwd = createUiFixture();
    expect(() => planFixture(cwd, ["ui/src/presenter.ts", "ui/src/missing.ts"])).toThrow(
      /deleted or missing executable path ui\/src\/missing\.ts/u,
    );
    writeFileSync(path.join(cwd, "src/uncovered.ts"), "export {};\n");
    expect(() => planFixture(cwd, ["ui/src/presenter.ts", "src/uncovered.ts"])).toThrow();
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

  it("requires every executable changed path to contribute precise test targets", () => {
    expect(() =>
      createCrabboxGatePlan({
        baseSha,
        changedPaths: [
          { path: "scripts/pr", status: "M" },
          { path: "scripts/pr-lib/gates.sh", status: "M" },
        ],
        headSha,
        resolvePathPlan: (changedPath) =>
          changedPath === "scripts/pr"
            ? { mode: "targets", targets: ["test/scripts/pr-merge.test.ts"] }
            : { mode: "targets", targets: [] },
      }),
    ).toThrow(/no complete targeted test plan for scripts\/pr-lib\/gates\.sh/u);
  });

  it.each([
    { mode: "broad", targets: [] },
    {
      mode: "targets",
      skippedBroadFallbackPaths: ["scripts/pr"],
      targets: ["test/scripts/pr-merge.test.ts"],
    },
    { mode: "targets", targets: ["test/vitest/vitest.tooling.config.ts"] },
  ])("rejects incomplete or broad authorization plan %#", (pathPlan) => {
    expect(() =>
      createCrabboxGatePlan({
        baseSha,
        changedPaths: [{ path: "scripts/pr", status: "M" }],
        headSha,
        resolvePathPlan: () => pathPlan,
      }),
    ).toThrow();
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
        { includePatterns: plan.targets, forwardedArgs: ["--reporter=dot"] },
      ]);
      expect(command).not.toContain("OPENCLAW_TEST_PROJECTS_PARALLEL");
      expect(command).not.toContain("--silent");
    },
  );
});
