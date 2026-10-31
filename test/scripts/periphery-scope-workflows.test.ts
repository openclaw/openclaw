import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { compileFunction } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const WORKFLOW_CASES = (
  [
    ["ios", "apps/ios/Sources/Test.swift"],
    ["macos", "apps/macos/Sources/OpenClaw/Test.swift"],
    ["shared-openclawkit", "apps/shared/OpenClawKit/Sources/OpenClawKit/Test.swift"],
  ] as const
).map(([name, scopedPath]) =>
  Object.assign(
    { name, scopedPath },
    compileScopeWorkflow(
      ".github/workflows/macos-periphery.yml",
      name === "ios" ? "ios-scan" : name === "shared-openclawkit" ? "shared-scan" : "should-scan",
    ),
  ),
);
const sharedWorkflow = WORKFLOW_CASES[2]!;

type WorkflowStep = {
  id?: string;
  name?: string;
  run?: string;
  if?: string;
  with?: {
    "fetch-depth"?: number;
    script?: string;
  };
};

type ScopeWorkflow = {
  on: { pull_request: { paths?: string[]; types: string[] } };
  jobs: { scope: { steps: WorkflowStep[] } } & Record<
    string,
    {
      name?: string;
      needs?: string[] | string;
      if?: string;
      "runs-on"?: string;
      outputs?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
};
type ScopeFunction = (
  ...args: [unknown, unknown, unknown, NodeJS.Require, unknown]
) => Promise<void>;

type ScopeOptions = {
  diffExitCode?: number;
  repoRoot?: string;
  draft?: boolean;
  eventName?: string;
  sharedOnly?: boolean;
  iosOnly?: boolean;
  files?: Array<string | { filename: string; previous_filename?: string }>;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);

function compileScopeWorkflow(workflowPath: string, outputName = "should-scan") {
  const workflow = parse(readFileSync(workflowPath, "utf8")) as ScopeWorkflow;
  const step = workflow.jobs?.scope?.steps?.find((candidate) => candidate.id === "scope");
  const script = step?.with?.script;
  if (!script) {
    throw new Error(`missing Periphery scope script in ${workflowPath}`);
  }
  const parameters = ["context", "core", "exec", "require", "process"];
  const execute = compileFunction(
    `return (async () => {\n${script}\n})();`,
    parameters,
  ) as ScopeFunction;
  return { workflow, script, execute, outputName };
}

async function runScope(
  fixture: ReturnType<typeof compileScopeWorkflow>,
  options: ScopeOptions,
): Promise<string | undefined> {
  const outputs = new Map<string, string>();
  const context = {
    eventName: options.eventName ?? "pull_request",
    payload: { pull_request: { draft: options.draft ?? false, number: 123 } },
  };
  const exec = {
    async getExecOutput(command: string, args: string[]) {
      if (command !== "git" || args.slice(0, 5).join(" ") !== "diff --quiet HEAD^1 HEAD --") {
        throw new Error(`unexpected scope command: ${command} ${args.join(" ")}`);
      }
      if (options.diffExitCode !== undefined) {
        return { exitCode: options.diffExitCode };
      }
      if (options.repoRoot) {
        const result = spawnSync(command, args, { cwd: options.repoRoot });
        return { exitCode: result.status ?? 128 };
      }
      const pathspecs = args.slice(5);
      const filenames = (options.files ?? []).flatMap((file) =>
        typeof file === "string"
          ? [file]
          : [file.filename, file.previous_filename].filter((name): name is string => Boolean(name)),
      );
      const changed = filenames.some((filename) => {
        const matches = (spec: string) =>
          spec.endsWith("/") ? filename.startsWith(spec) : filename === spec;
        return (
          pathspecs.some((spec) => !spec.startsWith(":(exclude)") && matches(spec)) &&
          !pathspecs.some((spec) => spec.startsWith(":(exclude)") && matches(spec.slice(10)))
        );
      });
      return { exitCode: changed ? 1 : 0 };
    },
  };
  await fixture.execute(
    context,
    { setOutput: (name: string, value: string) => outputs.set(name, value) },
    exec,
    require,
    {
      env: {
        PERIPHERY_SHARED_ONLY: String(options.sharedOnly ?? false),
        PERIPHERY_IOS_ONLY: String(options.iosOnly ?? false),
      },
    },
  );
  return outputs.get(fixture.outputName);
}

function makeRepo() {
  const root = tempDirs.make("openclaw-periphery-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (relativePath: string, contents: string) => {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  };
  const commit = (message = "fixture") => {
    git("add", ".");
    git("commit", "-m", message);
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "OpenClaw Test");
  git("config", "user.email", "openclaw-test@example.com");
  return { root, git, write, commit };
}

it.each(WORKFLOW_CASES)(
  "admits draft transitions and merge-parent history for $name",
  ({ workflow }) => {
    expect(workflow.on?.pull_request?.types).toContain("converted_to_draft");
    expect(workflow.on?.pull_request?.paths).toBeUndefined();
    expect(
      workflow.jobs.scope.steps.find((step) => step.name === "Checkout")?.with?.["fetch-depth"],
    ).toBe(2);
  },
);

it.each(WORKFLOW_CASES)("selects only $name scope changes", async (fixture) => {
  const { scopedPath } = fixture;
  const check = (options: ScopeOptions, expected: string) =>
    expect(runScope(fixture, options)).resolves.toBe(expected);
  await check({ files: [scopedPath] }, "true");
  await check({ files: ["scripts/install-periphery.sh"] }, "true");
  await check({ files: ["docs/index.md"] }, "false");
  await check({ draft: true, files: [scopedPath] }, "false");
  await check(
    {
      eventName: "workflow_dispatch",
      sharedOnly: fixture === sharedWorkflow,
      iosOnly: fixture.name === "ios",
    },
    "true",
  );
  await check({ files: [{ filename: "docs/Moved.swift", previous_filename: scopedPath }] }, "true");
  await expect(runScope(fixture, { diffExitCode: 128 })).rejects.toThrow(
    "git diff failed with exit code 128",
  );
});

it.each(WORKFLOW_CASES)(
  "excludes prose but keeps source, mixed changes, resources and renames for $name",
  async (fixture) => {
    const { scopedPath } = fixture;
    const repo = makeRepo();
    const repoRoot = repo.root;
    repo.write("seed", "base\n");
    repo.commit();
    const firstProsePath = fixture.name === "macos" ? "apps/macos/README.md" : "apps/ios/README.md";
    repo.write(firstProsePath, "documentation\n");
    repo.commit();
    await expect(runScope(fixture, { repoRoot })).resolves.toBe("false");

    repo.write(firstProsePath, "updated documentation\n");
    repo.write(scopedPath, "struct Example {}\n");
    repo.commit();
    await expect(runScope(fixture, { repoRoot })).resolves.toBe("true");

    repo.write(path.join(path.dirname(scopedPath), "Resources/README.md"), "runtime resource\n");
    repo.commit();
    await expect(runScope(fixture, { repoRoot })).resolves.toBe("true");

    renameSync(path.join(repoRoot, scopedPath), path.join(repoRoot, firstProsePath));
    repo.commit();
    await expect(runScope(fixture, { repoRoot })).resolves.toBe("true");
  },
);

it("selects shared scans from native protocol generator inputs", async () => {
  for (const file of [
    "packages/gateway-protocol/src/schema/protocol-schemas.ts",
    "scripts/protocol-gen-swift.ts",
    "scripts/native-protocol-inputs.json",
  ]) {
    await expect(runScope(sharedWorkflow, { files: [file] })).resolves.toBe("true");
  }
});

it("keeps app, shared-only and iOS-only admission independent in the canonical graph", async () => {
  const appWorkflow = WORKFLOW_CASES[1]!;
  for (const fixture of [WORKFLOW_CASES[0]!, appWorkflow, sharedWorkflow]) {
    const shared = fixture === sharedWorkflow;
    const ios = fixture.name === "ios";
    await expect(
      runScope(fixture, { files: ["apps/shared/OpenClawKit/Sources/Shared.swift"] }),
    ).resolves.toBe(String(shared || ios));
    await expect(
      runScope(fixture, { eventName: "workflow_dispatch", sharedOnly: true }),
    ).resolves.toBe(String(shared));
    await expect(
      runScope(fixture, { eventName: "workflow_dispatch", iosOnly: true }),
    ).resolves.toBe(String(ios));
    await expect(runScope(fixture, { eventName: "workflow_dispatch" })).resolves.toBe(
      String(!shared && !ios),
    );
  }
});

it("ignores scoped files added only by base-branch drift", async () => {
  const repo = makeRepo();
  const repoRoot = repo.root;
  repo.write("docs/base.md", "base\n");
  repo.commit("base");
  const eventBase = repo.git("rev-parse", "HEAD");

  repo.git("switch", "-c", "pr");
  repo.write("docs/pr.md", "pull request\n");
  repo.commit("pull request");

  repo.git("switch", "main");
  repo.write("apps/shared/OpenClawKit/Sources/OpenClawKit/Main.swift", "struct Main {}\n");
  repo.commit("advance main");
  repo.git("merge", "--no-ff", "pr", "-m", "synthetic merge");

  const oldDiff = spawnSync(
    "git",
    ["diff", "--quiet", eventBase, "HEAD", "--", "apps/shared/OpenClawKit/"],
    { cwd: repoRoot },
  );
  expect(oldDiff.status).toBe(1);

  await expect(runScope(sharedWorkflow, { repoRoot })).resolves.toBe("false");
  expect(repo.git("diff", "--name-only", "HEAD^1", "HEAD")).toBe("docs/pr.md");
});

it("builds one iOS index for overlapping app and shared scope and retains two scan policies", async () => {
  const change = { files: ["apps/ios/Sources/Example.swift"] };
  const automatic = ["ios", "macos"]
    .map(
      (name) =>
        parse(readFileSync(`.github/workflows/${name}-periphery.yml`, "utf8")) as ScopeWorkflow,
    )
    .filter((workflow) => workflow.on.pull_request);
  const builds = automatic
    .flatMap((workflow) => Object.values(workflow.jobs))
    .flatMap((job) => job.steps ?? [])
    .filter(
      ({ run = "" }) =>
        /xcodebuild[\s\S]*build-for-testing/u.test(run) ||
        (/periphery scan/u.test(run) && !run.includes("--skip-build")),
    );
  expect(builds).toHaveLength(1);
  await expect(runScope(WORKFLOW_CASES[0]!, change)).resolves.toBe("true");
  await expect(runScope(sharedWorkflow, change)).resolves.toBe("true");
  const jobs = WORKFLOW_CASES[0]!.workflow.jobs;
  const producer = jobs["ios-index"]!;
  expect(producer["runs-on"]).toBe("xcode-27");
  const scans = producer.steps!.filter(({ run = "" }) => run.includes("periphery scan"));
  expect(scans).toHaveLength(2);
  for (const step of scans) {
    expect(step.run).toContain("--skip-build");
    expect(step.run).toContain(
      '--index-store-path "$RUNNER_TEMP/shared-periphery-ios-derived/Index.noindex/DataStore"',
    );
    expect(step.if).toContain("!cancelled()");
  }
  expect(scans[0]!.run).toContain("--strict");
  expect(scans[0]!.run).not.toContain("--report-include");
  expect(scans[1]!.run).not.toContain("--strict");
  expect(scans[1]!.run).toContain("--report-include '../shared/OpenClawKit/Sources/**'");
  expect(scans[1]!.run).toContain(
    "--retain-files '**/GenerateGatewayProtocol/GatewayModels.swift'",
  );
  for (const [name, variable, value, status] of [
    ["scan-ios", "APP_FAILURE", "1", 1],
    ["scan-ios-shared", "SCAN_STATUS", "0", 0],
  ] as const) {
    const result = spawnSync("/bin/bash", ["-c", jobs[name]!.steps![0]!.run!], {
      env: { ...process.env, REPORT_COMPLETE: "true", [variable]: value },
    });
    expect(result.status).toBe(status);
  }
  expect(jobs.intersect!.needs).toContain("scan-ios-shared");
  expect(jobs.intersect!.needs).not.toContain("scan-ios");
});

it.each(["ios", "macos"])(
  "keeps %s app and shared report failures independent in their producer",
  (platform) => {
    const jobs = WORKFLOW_CASES[0]!.workflow.jobs;
    const producer = jobs[`${platform}-index`]!;
    const appJob = jobs[platform === "ios" ? "scan-ios" : "scan"]!;
    const sharedJob = jobs[platform === "ios" ? "scan-ios-shared" : "scan-macos"]!;
    const steps = Object.fromEntries(
      ["build", "app-scan", "app-report", "app-upload", "shared-scan", "shared-upload"].map(
        (id) => [id, { outcome: "success", outputs: {} as Record<string, string> }],
      ),
    );
    const complete = (branch: "app" | "shared") => {
      const expression = producer
        .outputs![`${branch}-complete`]!.replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
        .replace(/steps\.([\w-]+)/gu, 'steps["$1"]');
      return String(compileFunction(`return (${expression});`, ["steps"])(steps));
    };
    const enforce = (job: typeof appJob, branch: "app" | "shared", status = "0") =>
      spawnSync("/bin/bash", ["-c", job.steps![0]!.run!], {
        env: {
          ...process.env,
          PRODUCER_RESULT: "failure",
          REPORT_COMPLETE: complete(branch),
          APP_FAILURE: status,
          SCAN_STATUS: status,
        },
      }).status;
    for (const failed of ["app-scan", "app-report", "app-upload", "shared-scan", "shared-upload"]) {
      steps[failed]!.outcome = "failure";
      expect(enforce(appJob, "app"), failed).toBe(failed.startsWith("app-") ? 1 : 0);
      expect(enforce(sharedJob, "shared"), failed).toBe(failed.startsWith("shared-") ? 1 : 0);
      steps[failed]!.outcome = "success";
    }
    expect(enforce(appJob, "app", "1")).toBe(1);
    expect(enforce(sharedJob, "shared")).toBe(0);
    expect(enforce(appJob, "app")).toBe(0);
    expect(enforce(sharedJob, "shared", "1")).toBe(1);
    for (const missingBuild of ["failure", "skipped"]) {
      steps.build!.outcome = missingBuild;
      expect(enforce(appJob, "app")).toBe(1);
      expect(enforce(sharedJob, "shared")).toBe(1);
    }
  },
);
