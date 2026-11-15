import { execFileSync, spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll } from "vitest";
import { parse } from "yaml";
import { createTempDirTracker } from "../helpers/temp-dir.js";

type PerformanceWorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
  with?: Record<string, string>;
  "continue-on-error"?: boolean | string;
};
type PerformanceWorkflow = {
  env?: Record<string, string>;
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      if?: string;
      needs?: string | string[];
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      "runs-on"?: string;
      steps: PerformanceWorkflowStep[];
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
    }
  >;
};
const PERFORMANCE_WORKFLOW = ".github/workflows/openclaw-performance.yml";
export function readPerformanceWorkflow(source = readFileSync(PERFORMANCE_WORKFLOW, "utf8")) {
  return parse(source) as PerformanceWorkflow;
}
export function runPerformanceShell(run: string | undefined, env: NodeJS.ProcessEnv, cwd?: string) {
  return spawnSync("bash", ["-c", run ?? ""], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

type PerformanceTemplate = {
  root: string;
  git: string;
  target: string;
  reportCommit: string;
};

const templateDirs = createTempDirTracker();
const performanceTemplates = new Map<"base" | "publish", PerformanceTemplate>();
afterAll(() => {
  templateDirs.cleanup();
  performanceTemplates.clear();
});

export type PerformanceFixtureOptions = {
  mode: "target" | "record" | "tested" | "kova" | "baseline" | "prepare" | "publish";
  successfulGitTrees?: boolean;
  baseline?: "absent" | "invalid" | "trailing-newline";
  duplicate?: boolean;
  race?: boolean;
  remoteDuplicateAttempt?: number;
};

export function preparePerformanceFixture(root: string, options: PerformanceFixtureOptions) {
  const workspace = join(root, "workspace");
  const temp = join(workspace, "performance-temp");
  const remote = join(workspace, "reports.git");
  const seed = join(workspace, "seed");
  const reports = join(temp, "reports");
  const input = join(temp, "input");
  const publish = options.mode === "publish";
  const reuseDefault = !options.baseline && !options.duplicate;
  const templateKind = publish ? "publish" : "base";
  const template = reuseDefault ? performanceTemplates.get(templateKind) : undefined;
  const git = template?.git ?? execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const gitEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "Performance fixture",
    GIT_AUTHOR_EMAIL: "performance@example.invalid",
    GIT_COMMITTER_NAME: "Performance fixture",
    GIT_COMMITTER_EMAIL: "performance@example.invalid",
  };
  const run = (cwd: string, ...args: string[]) =>
    execFileSync(git, ["-C", cwd, ...args], {
      env: gitEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (file: string, value: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  const dest = "openclaw-performance/main/123-1/mock-provider";
  const previous = "openclaw-performance/main/100-1/mock-provider";
  const pointer = "openclaw-performance/main/latest-mock-provider.json";
  const commitReport = (cwd: string, report: string) => {
    write(join(cwd, report, "report.json"), JSON.stringify({ path: report }));
    write(join(cwd, report, "source/index.md"), "source fixture\n");
    write(join(cwd, pointer), JSON.stringify({ path: report }));
    run(cwd, "add", ".");
    run(cwd, "commit", "-m", "fixture report");
  };
  const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
  if (template) {
    cpSync(template.root, workspace, copyOptions);
  } else {
    mkdirSync(temp, { recursive: true });
    mkdirSync(seed);
    run(workspace, "init", "--bare", "--initial-branch=main", remote);
    run(seed, "init", "--initial-branch=main");
    write(join(seed, "README.md"), "fixture\n");
    if (options.baseline !== "absent") {
      commitReport(seed, options.duplicate ? dest : previous);
      if (options.baseline === "invalid") {
        write(join(seed, pointer), "{invalid");
      }
      if (options.baseline === "trailing-newline") {
        write(join(seed, pointer), JSON.stringify({ path: previous + "\n" }));
      }
    }
    run(seed, "add", ".");
    run(seed, "commit", "--allow-empty", "-m", "fixture seed");
    run(seed, "push", remote, "HEAD:main");
    run(workspace, "init", "--initial-branch=main");
    write(join(workspace, "src/config/zod-schema.agent-defaults.ts"), "    mediaModels: z\n");
    run(workspace, "add", "src");
    run(workspace, "commit", "-m", "fixture target");
    mkdirSync(reports);
    if (publish) {
      run(reports, "init", "--initial-branch=main");
      run(reports, "remote", "add", "origin", "https://github.com/openclaw/clawgrit-reports.git");
      // Keep FETCH_HEAD's source description valid when the snapshot is copied.
      run(reports, "fetch", "--depth=1", relative(reports, remote), "main");
      run(reports, "checkout", "-B", "main", "FETCH_HEAD");
      run(reports, "config", "core.hooksPath", "/dev/null");
      commitReport(reports, dest);
      write(join(reports, ".git/preexisting.lock"), "not invocation-owned\n");
    }
  }
  const target = template?.target ?? run(workspace, "rev-parse", "HEAD");
  const reportCommit =
    template?.reportCommit ?? (publish ? run(reports, "rev-parse", "HEAD") : "a".repeat(40));
  if (!template && reuseDefault) {
    // Snapshot complete repositories and their identities before scenario mutation.
    // Copies own their refs, index and objects; no live process or remote is shared.
    const templateRoot = templateDirs.make(`openclaw-performance-${templateKind}-template-`);
    cpSync(workspace, templateRoot, copyOptions);
    performanceTemplates.set(templateKind, { root: templateRoot, git, target, reportCommit });
  }
  if (publish && options.race) {
    commitReport(seed, "openclaw-performance/main/200-1/mock-provider");
    run(seed, "push", remote, "HEAD:main");
  }
  for (const [file, value] of Object.entries({
    "kova/reports/mock-provider/report.json": "{}\n",
    "kova/reports/mock-provider/report.md": "report\n",
    "kova/summaries/mock-provider.md": "summary\n",
    "kova/bundles/mock-provider/bundle.json": "{}\n",
    "kova/bundles/mock-provider/bundle.tar.gz.sha256": "fixture\n",
    "kova/bundles/mock-provider/bundle.tar.gz": "private archive fixture\n",
    "openclaw-performance-source-123-1/mock-provider/index.md": "source fixture\n",
  })) {
    write(join(input, file), value);
  }
  const env = {
    ...Object.fromEntries(Object.entries(gitEnv).filter(([key]) => key.startsWith("GIT_"))),
    RUNNER_TEMP: temp,
    TARGET_CHECKOUT_DIR: workspace,
    TARGET_REF_INPUT: "main",
    PERFORMANCE_MODE: "kova",
    KOVA_REF_INPUT: "fixture",
    KOVA_CONFIG_CONTRACT_INPUT: "canonical",
    KOVA_TRUSTED_LIVE_REF: "fixture",
    KOVA_REPOSITORY: "fixture/kova",
    KOVA_REF: "main",
    KOVA_HOME: join(temp, "kova-home"),
    OCM_VERSION: "fixture",
    OCM_LINUX_X64_SHA256: "fixture",
    TARGET_REF: "main",
    EXPECTED_TESTED_SHA: target,
    TESTED_REF: "main",
    TESTED_SHA: target,
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: target,
    GITHUB_WORKFLOW: "OpenClaw Performance",
    GITHUB_REPOSITORY: "fixture/performance",
    GH_TOKEN: "fixture-performance-read-token",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    ARTIFACT_ID: "42",
    PRODUCER_ATTEMPT: "1",
    SOURCE_PRODUCER_ATTEMPT: "1",
    LANE_ID: "mock-provider",
    INPUT_ROOT: input,
    REPORTS_ROOT: reports,
    REPORT_COMMIT: reportCommit,
    DEST_REL: dest,
    REPORT_URL: `https://github.com/openclaw/clawgrit-reports/tree/main/${dest}`,
    REPORT_PUBLISH_REQUIRED: "true",
    PERFORMANCE_REPORT_SELECTOR: resolve("scripts/lib/kova-report-selector.mjs"),
    PERFORMANCE_PUBLISHER_HELPER: resolve("scripts/lib/kova-report-publish-files.mjs"),
    PUBLISHED_REPORT_MAX_FILE_BYTES: "50000000",
    ...(publish ? { CLAWGRIT_REPORTS_APP_TOKEN: "fixture-performance-token" } : {}),
  };
  const remoteGit = (...args: string[]) => run(workspace, "--git-dir", remote, ...args);
  const configPath = join(reports, ".git/config");
  return {
    env,
    proxy: { git, remote, ...options },
    inspect() {
      return {
        remoteFiles: remoteGit("ls-tree", "-r", "--name-only", "main").split("\n"),
        pointer: options.baseline === "absent" ? "" : remoteGit("show", `main:${pointer}`),
        config: existsSync(configPath) ? readFileSync(configPath, "utf8") : "",
      };
    },
  };
}
