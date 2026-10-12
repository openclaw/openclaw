import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyChangedLanes,
  detectChangedLanes,
  detectChangedLanesForPaths,
  listChangedPathsFromGit,
  listStagedChangedPaths,
} from "../../scripts/changed-lanes.mts";
import {
  buildChangedCheckCrabboxArgs,
  cleanupCorepackPnpmShimDir,
  createChangedCheckPlan,
  createPnpmManagedCommand,
  createTargetedCoreLintCommands,
  createTargetedExtensionLintCommand,
  shouldDelegateChangedCheckToCrabbox,
  shouldRunNpmLockGuard,
  shouldRunTestTempCreationReport,
  createNpmLockGuardCommand,
  delegationFailedBeforeRunning,
} from "../../scripts/check-changed.mts";
import { resolveOxfmtInvocation } from "../../scripts/format-docs.mts";
import { findTypecheckInertPaths } from "../../scripts/lib/typecheck-inert.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { preparedScriptWrapperEnv } from "./prepared-script-wrapper.test-support.js";
import { copyOxlintConfigFixture } from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = process.cwd();
const testNodeExecPath = resolveTestNodeExecPath();
const githubActivityHelper = ".agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh";
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: createNestedGitEnv(),
  }).trim();

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "."]);
  git(cwd, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "commit",
    "-qm",
    message,
  ]);
}

function expectLanes(
  lanes: ReturnType<typeof createEmptyChangedLanes>,
  expected: Partial<ReturnType<typeof createEmptyChangedLanes>>,
) {
  expect(lanes).toEqual({ ...createEmptyChangedLanes(), ...expected });
}

function parseChangedLaneOutput(output: string): ReturnType<typeof detectChangedLanes> {
  return JSON.parse(output) as ReturnType<typeof detectChangedLanes>;
}

function runChangedLanesCli(cwd: string, args: string[]) {
  return parseChangedLaneOutput(
    execFileSync(testNodeExecPath, [path.join(repoRoot, "scripts", "changed-lanes.mjs"), ...args], {
      cwd,
      encoding: "utf8",
      env: createNestedGitEnv(),
    }),
  );
}

function runRepoScript(script: string, args: string[], env = createNestedGitEnv(), cwd = repoRoot) {
  const nodeArgs = script.endsWith(".mts")
    ? ["--import", "tsx", path.join(repoRoot, script), ...args]
    : [path.join(repoRoot, script), ...args];
  return spawnSync(testNodeExecPath, nodeArgs, {
    cwd,
    encoding: "utf8",
    env,
  });
}

function writeRepoFile(repoDir: string, filePath: string, contents: string): void {
  const absolutePath = path.join(repoDir, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function syntheticCoreTestOwnerEnv(dir: string, env: NodeJS.ProcessEnv, recorderPath?: string) {
  const ownerPath = path.join(dir, "compiler-owner.mjs");
  writeFileSync(
    ownerPath,
    `${recorderPath ? `import recorder from ${JSON.stringify(pathToFileURL(recorderPath).href)};` : "const recorder = null;"}
async function check(args) {
  if (!recorder) return 0;
  const finish = recorder.start("pnpm", args);
  try {
    await Promise.resolve();
    return recorder.result("pnpm", args);
  } finally {
    finish();
  }
}
export function createChangedCoreTestCheck() {
  return {
    checkBoundary: () => check(["lint:tmp:tsgo-core-boundary"]),
    checkTypes: () => check(["tsgo:core:test"]),
  };
}
`,
  );
  return preparedScriptWrapperEnv(
    [
      [
        pathToFileURL(path.join(repoRoot, "scripts/run-tsgo-core-test-shards.mts")),
        pathToFileURL(ownerPath),
      ],
    ],
    env,
  );
}

function createGitRepo(prefix: string) {
  const dir = tempDirs.make(prefix);
  git(dir, ["init", "-q", "--initial-branch=main"]);
  writeRepoFile(dir, "README.md", "initial\n");
  commitAll(dir, "initial");
  return dir;
}

function createRootTestLintFixture() {
  const dir = createGitRepo("openclaw-changed-root-lint-");
  copyOxlintConfigFixture(dir);
  for (const file of [
    "tsconfig.json",
    "test/tsconfig.json",
    "test/tsconfig/tsconfig.test.json",
    "test/tsconfig/tsconfig.test.root.json",
    "test/vitest/vitest.test-shards.d.mts",
    "src/gateway/server-methods-list.ts",
    "src/gateway/events.ts",
    "scripts/protocol-event-coverage.allowlist.json",
  ]) {
    writeRepoFile(dir, file, readFileSync(path.join(repoRoot, file), "utf8"));
  }
  // This fixture supplies its own source/ambient graph. Full-repository E2E
  // augmentations are covered by the root-partition inventory test.
  const lintConfig = "test/tsconfig.json";
  writeRepoFile(
    dir,
    lintConfig,
    JSON.stringify({ ...JSON.parse(readFileSync(path.join(dir, lintConfig), "utf8")), files: [] }),
  );
  for (const [file, source] of Object.entries({
    "src/plugin-sdk/discovery.ts":
      "export function work(): Promise<void> { return Promise.resolve(); }",
    "src/contracts.d.ts": "declare function fromCore(): Promise<void>;",
    "ui/contracts.d.ts": "declare function fromUi(): Promise<void>;",
    "packages/contracts.d.ts": "declare function fromPackage(): Promise<void>;",
  })) {
    writeRepoFile(dir, file, source);
  }
  mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true });
  for (const name of ["@types/node", "vitest", "tsx"]) {
    const destination = path.join(dir, "node_modules", name);
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(path.join(repoRoot, "node_modules", name), destination, "junction");
  }
  // Lint still uses the real tools, but its install cannot own the native compiler.
  // Direct package entries preserve relative imports and the tsgolint peer context.
  for (const [bin, entry] of [
    ["oxlint", "oxlint/bin/oxlint"],
    ["tsgolint", "oxlint-tsgolint/bin/tsgolint.js"],
  ] as const) {
    symlinkSync(
      path.join(repoRoot, "node_modules", entry),
      path.join(dir, "node_modules/.bin", bin),
      "file",
    );
    if (process.platform === "win32") {
      writeRepoFile(dir, `node_modules/.bin/${bin}.cmd`, `@node "%~dp0${bin}" %*\r\n`);
    }
  }
  // All-lane plans run the real coverage guard against unchanged mobile inputs.
  symlinkSync(path.join(repoRoot, "apps"), path.join(dir, "apps"), "junction");
  for (const script of [
    "run-oxlint.mjs",
    "report-test-temp-creations.mjs",
    "check-protocol-event-coverage.mjs",
  ]) {
    symlinkSync(path.join(repoRoot, "scripts", script), path.join(dir, "scripts", script));
  }
  // Stub unrelated package gates at the executable boundary: real pnpm could
  // reconcile this partial install. The CLI and source-only lint wrapper stay real.
  // The export audit is selected normally, but this fixture has only the lint graph.
  writeRepoFile(dir, "scripts/check-deadcode-exports.mts", "export {};\n");
  const binDir = path.join(dir, "bin");
  for (const bin of ["pnpm", "corepack"]) {
    writeRepoFile(dir, `bin/${bin}`, "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(binDir, bin), 0o755);
    writeRepoFile(dir, `bin/${bin}.cmd`, "@echo off\r\nexit /b 0\r\n");
  }
  const env = syntheticCoreTestOwnerEnv(dir, {
    ...createNestedGitEnv(),
    OXC_LOG: "debug",
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  delete env.OPENCLAW_TESTBOX;
  delete env.OPENCLAW_OXLINT_SKIP_PREPARE;
  return {
    dir,
    run: (script: string, args: string[]) =>
      spawnSync(testNodeExecPath, [path.join(repoRoot, script), ...args], {
        cwd: dir,
        encoding: "utf8",
        env,
      }),
  };
}

// Executes the exact "format changed files" plan command with the repo-pinned oxfmt,
// reconstructing `pnpm format:check <plan args>`. Guards the runtime verdict, not just
// plan construction: a misformatted added file must fail, deleted paths must not.
function runChangedFormatLaneWithRepoOxfmt(cwd: string, changedPaths: string[]) {
  const plan = createChangedCheckPlan(detectChangedLanes(changedPaths));
  const command = expectDefined(
    plan.commands.find(({ name }) => name === "format changed files"),
    "format command",
  );
  expect(command.args[0]).toBe("format:check");
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = expectDefined(packageJson.scripts["format:check"], "format:check package script");
  const [bin, ...args] = script.split(" ");
  expect(bin).toBe("oxfmt");
  const invocation = resolveOxfmtInvocation([...args, ...command.args.slice(1)], { repoRoot });
  return spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

// Keep the real gate and managed children; check owners share one synthetic recorder.
function runChangedCheckWithRecordedCommands(
  failingCommand: string | null,
  paths = ["src/gateway/server-runtime-state.ts"],
  cwd = repoRoot,
) {
  const dir = tempDirs.make("openclaw-changed-check-order-");
  const binDir = path.join(dir, "bin");
  const eventsPath = path.join(dir, "events.jsonl");
  const childPath = path.join(dir, "command.cjs");
  mkdirSync(binDir);
  writeFileSync(eventsPath, "");
  writeFileSync(
    childPath,
    `
const fs = require("node:fs");
const events = ${JSON.stringify(eventsPath)};
const active = ${JSON.stringify(path.join(dir, "active"))};
exports.start = (bin, args) => {
  const record = (event) => fs.appendFileSync(events, JSON.stringify({event, bin, args}) + "\\n");
  fs.mkdirSync(active);
  record("start");
  return () => { record("finish"); fs.rmdirSync(active); };
};
exports.result = (bin, args) => {
  if (bin === "pnpm" && args[0] === ${JSON.stringify(failingCommand)}) {
    console.error("Synthetic check failure: " + args[0]);
    return 23;
  }
  return 0;
};
if (require.main === module) {
  const bin = process.argv[2], args = process.argv.slice(3);
  process.on("exit", exports.start(bin, args));
  process.exitCode = exports.result(bin, args);
}
`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const bin of ["pnpm", "node"]) {
    const launcher = path.join(binDir, bin);
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${quote(testNodeExecPath)} ${quote(childPath)} ${bin} "$@"\n`,
    );
    chmodSync(launcher, 0o755);
    writeFileSync(
      `${launcher}.cmd`,
      `@echo off\r\n"${testNodeExecPath}" "${childPath}" ${bin} %*\r\n`,
    );
  }
  const result = runRepoScript(
    "scripts/check-changed.mjs",
    ["--", ...paths],
    syntheticCoreTestOwnerEnv(
      dir,
      {
        ...createNestedGitEnv(),
        CI: "",
        GITHUB_ACTIONS: "",
        OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "1",
        OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE: "",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      childPath,
    ),
    cwd,
  );
  const events: { event: string; bin: string; args: string[] }[] = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { events, paths, result };
}

function createSyntheticMergeRepo(prefix: string): { dir: string; staleBase: string } {
  const dir = createGitRepo(prefix);
  const staleBase = git(dir, ["rev-parse", "HEAD"]);

  git(dir, ["switch", "-q", "-c", "feature"]);
  writeRepoFile(dir, "src/pr.ts", "export const pr = true;\n");
  commitAll(dir, "feature");

  git(dir, ["switch", "-q", "main"]);
  writeRepoFile(dir, "src/main-only.ts", "export const mainOnly = true;\n");
  commitAll(dir, "main only");
  git(dir, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "merge",
    "--no-ff",
    "feature",
    "-m",
    "synthetic merge",
  ]);

  return { dir, staleBase };
}

function classifyPackageJsonChange(
  prefix: string,
  before: Record<string, unknown> | string,
  after: Record<string, unknown> | string,
) {
  const dir = createGitRepo(prefix);
  writeRepoFile(dir, "package.json", typeof before === "string" ? before : prettyJson(before));
  commitAll(dir, "package baseline");
  writeRepoFile(dir, "package.json", typeof after === "string" ? after : prettyJson(after));
  return runChangedLanesCli(dir, ["--json", "--base", "HEAD"]);
}

afterEach(cleanupCorepackPnpmShimDir);

describe("scripts/changed-lanes", () => {
  it.each(["changed-lanes", "check-changed"])("prints %s help before running checks", (script) => {
    const result = runRepoScript(`scripts/${script}.mjs`, ["--help"], {
      ...createNestedGitEnv(),
      OPENCLAW_TESTBOX: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Usage: node scripts/${script}.mjs`);
    expect(result.stdout).not.toContain("--help: unknown surface");
    expect(result.stdout).not.toContain("[check:changed]");
  });

  it("exits cleanly for no changes without local dependencies", () => {
    const result = runRepoScript("scripts/check-changed.mjs", ["--no-changes"], {
      ...createNestedGitEnv(),
      PATH: "/nonexistent",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("[check:changed] no changed paths; nothing to run");
  });

  it.each([false, true])("delegates unresolved refs (explicit metadata: %s)", (metadata) => {
    const dir = createGitRepo("openclaw-check-missing-base-");
    if (metadata) {
      writeRepoFile(dir, "node_modules/.modules.yaml", "layoutVersion: 5\n");
      writeRepoFile(dir, "node_modules/.bin/oxfmt", "#!/bin/sh\n");
      writeRepoFile(dir, "node_modules/typescript/package.json", '{"name":"typescript"}\n');
    }
    writeRepoFile(dir, "bin/node", "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(dir, "bin/node"), 0o755);
    const result = runRepoScript(
      "scripts/check-changed.mjs",
      metadata ? ["--", "CHANGELOG.md"] : [],
      {
        ...createNestedGitEnv(),
        CI: "",
        GITHUB_ACTIONS: "",
        OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "",
        OPENCLAW_TESTBOX: metadata ? "" : "1",
        PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      dir,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("delegating through Crabbox workload routing");
    expect(result.stderr).not.toContain("ambiguous argument");
  });

  it.each([
    ["changed-lanes", "--jsno", "Unknown option: --jsno"],
    ["check-changed", "--dr-run", "Unknown option: --dr-run\n[check:changed] FAILED (exit 1)"],
  ])("rejects unknown %s options", (script, option, error) => {
    const result = runRepoScript(`scripts/${script}.mjs`, [option], {
      ...createNestedGitEnv(),
      OPENCLAW_TESTBOX: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(error);
    expect(result.stderr).not.toContain("\n    at ");
  });

  it.each([["--staged", "--", "--no-changes"]])(
    "preserves explicit delegated arguments %j",
    (...argv) => {
      const args = buildChangedCheckCrabboxArgs(argv, { cwd: repoRoot });
      expect(args.slice(args.indexOf("check:changed") + 1)).toEqual(argv);
    },
  );

  it.each([{ failingCommand: "tsgo:core:test" }, { failingCommand: null }])(
    "retains serial gate execution and stops on $failingCommand before broad audits",
    ({ failingCommand }) => {
      const { events, paths, result } = runChangedCheckWithRecordedCommands(failingCommand);
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(failingCommand === null ? 0 : 23);
      const commands = events.filter((event) => event.event === "start");
      const planned = createChangedCheckPlan(
        detectChangedLanesForPaths({ paths, base: "HEAD", staged: true }),
      ).commands.map((command) => ({
        bin: command.bin ?? "pnpm",
        args: command.args,
      }));
      const end =
        failingCommand === null
          ? planned.length
          : planned.findIndex((command) => command.args[0] === failingCommand) + 1;
      expect(commands.map(({ bin, args }) => ({ bin, args }))).toEqual(planned.slice(0, end));
      expect(events).toEqual(
        commands.flatMap(({ bin, args }) => [
          { event: "start", bin, args },
          { event: "finish", bin, args },
        ]),
      );
      const broadAudits = commands.filter(({ args }) =>
        args.some((arg) =>
          [
            "check:coercion-helpers",
            "check:deprecated-api-usage",
            "scripts/check-deadcode-exports.mts",
          ].includes(arg),
        ),
      );
      if (failingCommand !== null) {
        expect(result.stderr).toContain(`Synthetic check failure: ${failingCommand}`);
        expect(broadAudits).toEqual([]);
      } else {
        expect(broadAudits).toHaveLength(3);
        const lastTypecheck = commands.findLastIndex(({ args }) => args[0]?.startsWith("tsgo:"));
        for (const audit of broadAudits) {
          expect(commands.indexOf(audit)).toBeGreaterThan(lastTypecheck);
        }
      }
    },
  );

  it.each([
    {
      paths: [
        "./packages/schema-values/src/message-default.ts",
        "packages\\schema-values\\src\\message-default.ts",
      ],
      selected: true,
      deleted: false,
    },
    { paths: ["extensions/courier/src/delivery-limit.ts"], selected: true, deleted: true },
  ])("executes config-doc dependency selection for $paths", ({ paths, selected, deleted }) => {
    const cwd = tempDirs.make("openclaw-config-doc-dependencies-");
    git(cwd, ["init", "-q", "--initial-branch=main"]);
    for (const [file, source] of Object.entries({
      "extensions/courier/src/config-schema.ts":
        'import { value } from "./metadata.js"; import { limit } from "./delivery-limit.js"; export const schema = { value, limit };',
      "extensions/courier/src/metadata.ts":
        'export { value } from "../../../packages/schema-values/src/message-default.js";',
      "packages/schema-values/src/message-default.ts": 'export const value = "message";',
      "extensions/courier/src/delivery-limit.ts": "export const limit = 12;",
      "extensions/courier/src/transport.ts": "export const runtime = true;",
      "src/plugin-sdk/channel-config-ui-hints.ts": 'export { label } from "./schema-hints.js";',
      "src/plugin-sdk/schema-hints.ts": 'export { label } from "../shared/schema-hint-default.js";',
      "src/shared/schema-hint-default.ts": 'export const label = "Message limit";',
      "src/plugin-sdk/channel-core.ts":
        'export { label } from "./channel-config-ui-hints.js"; export { runtime } from "./channel-runtime.js";',
      "src/plugin-sdk/channel-runtime.ts": "export const runtime = true;",
    })) {
      writeRepoFile(cwd, file, source);
    }
    commitAll(cwd, "schema dependency fixture");
    if (deleted) {
      unlinkSync(path.join(cwd, paths[0]!));
      git(cwd, ["add", "-u"]);
    }
    const { events, result } = runChangedCheckWithRecordedCommands("config:docs:check", paths, cwd);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(selected ? 23 : 0);
    expect(
      events.filter(({ event, args }) => event === "start" && args[0] === "config:docs:check"),
    ).toHaveLength(selected ? 1 : 0);
  });

  it.each([[githubActivityHelper, false]] as const)(
    "keeps hidden-helper routing fail-safe for %s (all lanes: %s)",
    (changedPath, broad) => {
      const result = detectChangedLanes([githubActivityHelper, changedPath]);
      const commands = createChangedCheckPlan(result).commands.map((command) => command.args[0]);
      expectLanes(result.lanes, { all: broad, tooling: true });
      expect(result.extensionImpactFromCore).toBe(broad);
      expect(commands.includes("tsgo:all")).toBe(broad);
      expect(commands.includes("lint")).toBe(broad);
      expect(commands).not.toContain("test");
    },
  );

  it("keeps raw Git lookalikes broad without retargeting owner checks", () => {
    const paths = [" scripts/changed-lanes.mts", "scripts/changed\nlanes.mts"];
    const result = detectChangedLanes(paths);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, { all: true, tooling: true });
    expect(plan.commands.find((command) => command.name === "format changed files")).toEqual({
      name: "format changed files",
      args: ["format:check", "--no-error-on-unmatched-pattern", "--", ...paths],
    });
    expect(plan.commands.map((command) => command.args[0])).not.toContain(
      "plugin-sdk:check-exports",
    );
  });

  it("prefers raw sync worktree paths over an implausibly broad no-merge-base diff", () => {
    const dir = tempDirs.make("openclaw-changed-lanes-raw-sync-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    for (let index = 0; index < 250; index += 1) {
      writeFileSync(path.join(dir, `baseline-${index}.txt`), "baseline\n", "utf8");
    }
    commitAll(dir, "initial");
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir, ["switch", "-q", "--orphan", "feature"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "raw sync base",
    ]);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "feature.ts"), "export const value = 1;\n", "utf8");

    const previousRawSync = process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC;
    delete process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC;
    try {
      const normalPaths = listChangedPathsFromGit({ base: "origin/main", cwd: dir });
      expect(normalPaths.length).toBeGreaterThan(200);
      expect(normalPaths).toContain("baseline-0.txt");
      expect(normalPaths).toContain("src/feature.ts");

      process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC = "1";
      expect(listChangedPathsFromGit({ base: "origin/main", cwd: dir })).toEqual([
        "src/feature.ts",
      ]);
    } finally {
      if (previousRawSync === undefined) {
        delete process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC;
      } else {
        process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC = previousRawSync;
      }
    }
  });

  it("compares a pending merge index with the explicit staged base through the CLI", () => {
    const dir = createGitRepo("openclaw-changed-staged-base-");
    const fork = git(dir, ["rev-parse", "HEAD"]);
    writeRepoFile(dir, "docs/incoming.md", "incoming main\n");
    commitAll(dir, "incoming main");
    const base = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["switch", "-q", "-c", "feature", fork]);
    writeRepoFile(dir, "src/feature.test.ts", "export const feature = 1;\n");
    commitAll(dir, "feature");
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "merge",
      "--no-commit",
      "--no-ff",
      "main",
    ]);
    writeRepoFile(dir, "src/unstaged.ts", "export const unstaged = 1;\n");

    expect(runChangedLanesCli(dir, ["--json", "--staged"]).paths).toEqual(["docs/incoming.md"]);
    expect(runChangedLanesCli(dir, ["--json", "--staged", "--base", base]).paths).toEqual([
      "src/feature.test.ts",
    ]);
    const checked = runRepoScript(
      "scripts/check-changed.mjs",
      ["--dry-run", "--staged", `--base=${base}`],
      createNestedGitEnv(),
      dir,
    );
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stderr).toContain("-- src/feature.test.ts");
    expect(checked.stderr).not.toContain("docs/incoming.md");
    expect(checked.stderr).not.toContain("src/unstaged.ts");
    for (const command of [
      "check:line-cap-ratchet",
      "check:max-lines-ratchet",
      "check:assertion-safety",
      "check:test-timeout-race-ratchet",
      "check:test-mock-exports",
    ]) {
      expect(checked.stderr).toContain(`${command} --staged --base ${base}`);
    }
    expect(checked.stderr).toContain(
      `scripts/report-test-temp-creations.mjs --staged --base ${base}`,
    );
    const delegated = buildChangedCheckCrabboxArgs(["--staged", "--base", base], { cwd: dir });
    expect(delegated.slice(delegated.indexOf("check:changed") + 1)).toEqual([
      "--paths-from-git",
      "--base",
      base,
      "--head",
      "HEAD",
      "--",
      "src/feature.test.ts",
    ]);
  });

  it("classifies staged package scripts against the explicit base instead of HEAD", () => {
    const dir = tempDirs.make("openclaw-changed-staged-package-base-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeRepoFile(
      dir,
      "package.json",
      prettyJson({ dependencies: { fixture: "1" }, scripts: { check: "old" } }),
    );
    commitAll(dir, "initial");
    const fork = git(dir, ["rev-parse", "HEAD"]);
    writeRepoFile(
      dir,
      "package.json",
      prettyJson({ dependencies: { fixture: "2" }, scripts: { check: "old" } }),
    );
    commitAll(dir, "incoming dependency");
    const base = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["switch", "-q", "-c", "feature", fork]);
    writeRepoFile(
      dir,
      "package.json",
      prettyJson({ dependencies: { fixture: "2" }, scripts: { check: "new" } }),
    );
    git(dir, ["add", "package.json"]);
    // A worktree-only dependency change must not broaden index classification.
    writeRepoFile(
      dir,
      "package.json",
      prettyJson({ dependencies: { fixture: "3" }, scripts: { check: "new" } }),
    );
    const explicit = runChangedLanesCli(dir, ["--json", "--staged", `--base=${base}`]);
    expect(explicit.paths).toEqual(["package.json"]);
    expect(explicit.lanes.tooling).toBe(true);
    expect(explicit.lanes.all).toBe(false);
    expect(runChangedLanesCli(dir, ["--json", "--staged"]).lanes.releaseMetadata).toBe(true);
  });

  it("preserves both rename owners through worktree, staged, and committed changes", () => {
    const dir = tempDirs.make("openclaw-changed-lanes-rename-");
    const before = "src/old name.ts";
    const after = "ui/new name.ts";
    git(dir, ["init", "-q", "--initial-branch=main"]);
    git(dir, ["config", "diff.renames", "true"]);
    writeRepoFile(dir, before, "export const value = 1;\n");
    commitAll(dir, "before rename");
    mkdirSync(path.join(dir, "ui"));
    renameSync(path.join(dir, before), path.join(dir, after));
    git(dir, ["add", "--intent-to-add", "--", after]);

    for (const mode of ["worktree", "staged", "committed"] as const) {
      if (mode === "staged") {
        git(dir, ["add", "--all"]);
      } else if (mode === "committed") {
        commitAll(dir, "rename across owners");
      }
      const paths =
        mode === "staged"
          ? listStagedChangedPaths(dir)
          : listChangedPathsFromGit({
              base: mode === "committed" ? "HEAD^" : "HEAD",
              cwd: dir,
              includeWorktree: mode === "worktree",
            });
      expect(paths, mode).toEqual([before, after]);
      expectLanes(detectChangedLanes(paths).lanes, { core: true, coreTests: true, ui: true });
      if (mode === "staged") {
        expect(listChangedPathsFromGit({ base: "HEAD", cwd: dir })).toEqual(paths);
      }
    }
  });

  it("fails the changed format check on a misformatted added file and passes once formatted", () => {
    const dir = tempDirs.make("openclaw-changed-format-added-");
    writeRepoFile(dir, "src/added.test.ts", "export const added={value:1};\n");

    const dirty = runChangedFormatLaneWithRepoOxfmt(dir, ["src/added.test.ts"]);
    expect(dirty.status).not.toBe(0);
    expect(`${dirty.stdout}${dirty.stderr}`).toContain("added.test.ts");

    writeRepoFile(dir, "src/added.test.ts", "export const added = { value: 1 };\n");
    const formatted = runChangedFormatLaneWithRepoOxfmt(dir, [
      "src/added.test.ts",
      "src/deleted.ts",
    ]);
    expect(formatted.status).toBe(0);
  });

  it.each([
    {
      name: "an all-lane mixed diff",
      count: 1,
      extension: "tsx",
      otherPaths: ["vitest.config.ts"],
    },
    { name: "the ninth root test", count: 9, extension: "ts", otherPaths: [] },
  ])(
    "fails real changed-check lint for $name and passes after repair",
    ({ count, extension, otherPaths }) => {
      const { dir, run } = createRootTestLintFixture();
      const targets = Array.from(
        { length: count },
        (_, index) => `test/root-lint-${index}.test.${extension}`,
      );
      const broken = targets[count - 1]!;
      const violation = [
        'import { work } from "openclaw/plugin-sdk/discovery";',
        "export function run(ready: boolean) {",
        "  if (ready) return;",
        "  work(); fromCore(); fromUi(); fromPackage();",
        "}",
        "run(false);",
        "",
      ].join("\n");
      for (const target of targets) {
        writeRepoFile(dir, target, "export const ready = true;\n");
      }
      writeRepoFile(dir, broken, violation);
      // Neither excluded fixtures nor unchanged tests may be swept into targeted lint.
      writeRepoFile(dir, "test/fixtures/invalid.ts", violation);
      writeRepoFile(dir, "test/unchanged.test.ts", violation);
      const paths = [...targets, "test/fixtures/invalid.ts", "test/deleted.test.ts", ...otherPaths];
      const failed = run("scripts/check-changed.mjs", ["--base", "HEAD", "--", ...paths]);
      const diagnostics = failed.stdout + failed.stderr;
      expect(failed.error, diagnostics).toBeUndefined();
      expect(failed.status, diagnostics).toBe(1);
      expect(diagnostics).toContain("eslint(curly)");
      expect(
        diagnostics.match(/typescript\(no-floating-promises\)/gu) ?? [],
        diagnostics,
      ).toHaveLength(4);
      expect(diagnostics).toContain(broken);
      expect(failed.stderr.trim().split("\n").at(-1)).toBe("[check:changed] FAILED (exit 1)");

      writeRepoFile(
        dir,
        broken,
        violation
          .replace("if (ready) return;", "if (ready) { return; }")
          .replace(
            "work(); fromCore(); fromUi(); fromPackage();",
            "void work(); void fromCore(); void fromUi(); void fromPackage();",
          ),
      );
      const passed = run("scripts/check-changed.mjs", ["--base", "HEAD", "--", ...paths]);
      expect(passed.error, passed.stdout + passed.stderr).toBeUndefined();
      expect(passed.status, passed.stdout + passed.stderr).toBe(0);
      const planned = run("scripts/check-changed.mjs", [
        "--dry-run",
        "--base",
        "HEAD",
        "--",
        ...paths,
      ]);
      expect(planned.status, planned.stderr).toBe(0);
      const lintPrefix =
        "node scripts/run-oxlint.mjs --tsconfig test/tsconfig/tsconfig.test.root.json ";
      const batches = planned.stderr
        .split("\n")
        .filter((line) => line.includes(lintPrefix))
        .map((line) => line.slice(line.indexOf(lintPrefix) + lintPrefix.length).split(" "));
      expect(batches.map((batch) => batch.length)).toEqual(count === 9 ? [8, 1] : [1]);
      expect(batches.flat()).toEqual(targets);
    },
  );

  it("uses the merge commit first parent instead of a stale PR payload base", () => {
    const { dir, staleBase } = createSyntheticMergeRepo("openclaw-changed-lanes-merge-");

    expect(listChangedPathsFromGit({ base: staleBase, cwd: dir, includeWorktree: false })).toEqual([
      "src/main-only.ts",
      "src/pr.ts",
    ]);
    expect(
      listChangedPathsFromGit({
        base: staleBase,
        cwd: dir,
        includeWorktree: false,
        mergeHeadFirstParent: true,
      }),
    ).toEqual(["src/pr.ts"]);
  });

  it("preserves an exact -- filename after the explicit path separator", () => {
    const result = runRepoScript("scripts/changed-lanes.mjs", ["--json", "--", "--"]);

    expect(result.status).toBe(0);
    expect(parseChangedLaneOutput(result.stdout).paths).toEqual(["--"]);
    expect(parseChangedLaneOutput(result.stdout).lanes.all).toBe(true);
  });

  it.each([
    ["config/assertion-safety-baseline.txt", "check:assertion-safety"],
    ["config/max-lines-baseline.txt", "check:max-lines-ratchet"],
  ])("targets mixed-owner lint while retaining the guard for %s", (baseline, guard) => {
    const result = detectChangedLanes([
      baseline,
      ".github/workflows/ci.yml",
      "src/gateway/node-registry.ts",
      "extensions/lmstudio/src/models.fetch.ts",
      "scripts/check-changed.mjs",
      "test/helpers/temp-dir.ts",
    ]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });

    for (const [owner, tsconfig, target] of [
      ["core", "config/tsconfig/oxlint.core.json", "src/gateway/node-registry.ts"],
      ["extension", "extensions/tsconfig.json", "extensions/lmstudio/src/models.fetch.ts"],
      ["script", "config/tsconfig/oxlint.scripts.json", "scripts/check-changed.mjs"],
      ["test root", "test/tsconfig/tsconfig.test.root.json", "test/helpers/temp-dir.ts"],
    ]) {
      expect(plan.commands).toContainEqual(
        expect.objectContaining({
          name: `lint ${owner} changed file`,
          args: ["scripts/run-oxlint.mjs", "--tsconfig", tsconfig, target],
        }),
      );
    }
    const commandNames = plan.commands.map((command) => command.args[0]);
    expect(commandNames).toContain(guard);
    for (const fullLane of ["lint:core", "lint:extensions", "lint:scripts"]) {
      expect(commandNames).not.toContain(fullLane);
    }
  });

  it.each([
    {
      name: "mixed UI TypeScript and CSS",
      paths: ["ui/src/app-routes.ts", "ui/src/styles/base.css"],
      oxlintTargets: ["ui/src/app-routes.ts"],
      stylelintTargets: ["ui/src/app-routes.ts", "ui/src/styles/base.css"],
    },
    {
      name: "UI CSS only",
      paths: ["ui/src/styles/base.css"],
      oxlintTargets: [],
      stylelintTargets: ["ui/src/styles/base.css"],
    },
  ])("targets style lint for $name without broad core lint", (testCase) => {
    const plan = createChangedCheckPlan(detectChangedLanes(testCase.paths), {
      env: { PATH: "/usr/bin" },
    });

    expect(plan.commands.map((command) => command.args[0])).not.toContain("lint:core");
    const oxlint = plan.commands.find((command) => command.name.startsWith("lint core changed"));
    if (testCase.oxlintTargets.length === 0) {
      expect(oxlint).toBeUndefined();
    } else {
      expect(oxlint?.args.slice(3)).toEqual(testCase.oxlintTargets);
    }
    expect(
      plan.commands.find((command) => command.name.startsWith("lint UI changed style")),
    ).toMatchObject({
      bin: "node",
      args: ["--import", "tsx", "scripts/run-stylelint.mts", ...testCase.stylelintTargets],
    });
  });

  it.each(["win32"] as const)(
    "preserves core/UI lint coverage and platform batching for 83 targets on %s",
    (platform) => {
      const targets = Array.from(
        { length: 83 },
        (_, index) => `${index % 2 ? "ui/src" : "src/shared"}/file-${index}.ts`,
      ).toReversed();
      const commands = expectDefined(
        createTargetedCoreLintCommands(
          targets,
          { PATH: "/usr/bin" },
          { fileExists: () => true, platform },
        ),
        "core lint commands",
      );

      expect(commands.map((command) => command.args.slice(3).length)).toEqual(
        platform === "win32" ? [...Array<number>(10).fill(8), 3] : [83],
      );
      expect(commands.flatMap((command) => command.args.slice(3))).toEqual(
        targets.toSorted((left, right) => left.localeCompare(right)),
      );
      for (const command of commands) {
        expect(command.args.slice(0, 3)).toEqual([
          "scripts/run-oxlint.mjs",
          "--tsconfig",
          "config/tsconfig/oxlint.core.json",
        ]);
      }
    },
  );

  it("bounds encoded core lint commands without dropping long Unicode paths on POSIX", () => {
    const targets = Array.from(
      { length: 160 },
      (_, index) => `src/shared/${"nested folder/".repeat(20)}界😀^-${index}.ts`,
    );
    const env = { PATH: "/usr/bin", OPENCLAW_LOCAL_CHECK: "0" };
    const commands = expectDefined(
      createTargetedCoreLintCommands(targets, env, { fileExists: () => true, platform: "linux" }),
      "core lint commands",
    );
    expect(commands.length).toBeGreaterThan(1);
    expect(commands[0]?.args.slice(3).length).toBeGreaterThan(8);
    expect(commands.flatMap((command) => command.args.slice(3))).toEqual(
      targets.toSorted((left, right) => left.localeCompare(right)),
    );
    for (const command of commands) {
      expect(command.env).toMatchObject({ OPENCLAW_LOCAL_CHECK: "1" });
      expect(
        [command.bin, ...command.args].reduce(
          (size, arg) => size + Buffer.byteLength(arg, "utf8") + 1,
          0,
        ),
      ).toBeLessThanOrEqual(24 * 1024);
    }
  });

  it("rejects an oversized core target instead of omitting it on POSIX", () => {
    expect(() =>
      createTargetedCoreLintCommands(
        [`src/shared/${"long/".repeat(6000)}file.ts`],
        { PATH: "/usr/bin" },
        { fileExists: () => true, platform: "linux" },
      ),
    ).toThrow("Core lint target exceeds the command-line budget");
  });

  it("falls back to full extension lint for broad extension diffs", () => {
    const targets = Array.from(
      { length: 9 },
      (_, index) => `extensions/discord/src/file-${index}.ts`,
    );
    const command = createTargetedExtensionLintCommand(targets, { PATH: "/usr/bin" });

    expect(command).toBeNull();
  });

  it("reuses, cleans, and recreates CI Corepack pnpm shims", () => {
    const spec = { name: "conflict markers", args: ["check:no-conflict-markers"] };
    const env = { CI: "1", PATH: "/usr/bin" };
    for (let cycle = 0; cycle < 2; cycle++) {
      const command = createPnpmManagedCommand(spec, env);
      const shimDir = expectDefined(command.env?.PATH?.split(path.delimiter)[0], "pnpm shim");
      expect(command.bin).toBe("corepack");
      expect(command.args).toEqual(["pnpm", "check:no-conflict-markers"]);
      expect(path.basename(shimDir)).toMatch(/^openclaw-corepack-pnpm-/u);
      expect(existsSync(path.join(shimDir, "pnpm"))).toBe(true);
      expect(createPnpmManagedCommand(spec, env).env?.PATH).toBe(command.env?.PATH);
      cleanupCorepackPnpmShimDir();
      expect(existsSync(shimDir)).toBe(false);
    }
  });

  it("uses pnpm directly outside CI", () => {
    expect(
      createPnpmManagedCommand({ name: "check", args: ["check"] }, { PATH: "/usr/bin" }),
    ).toMatchObject({ bin: "pnpm", args: ["check"] });
  });

  it("keeps classified changed gates local", () => {
    const docsResult = detectChangedLanes(["docs/reference/test.md"]);
    const noChangesResult = detectChangedLanes([]);
    const metadataResult = detectChangedLanes(["CHANGELOG.md"]);
    const mixedResult = detectChangedLanes(["CHANGELOG.md", "src/config/config.ts"]);

    for (const result of [docsResult, noChangesResult, metadataResult, mixedResult]) {
      expect(shouldDelegateChangedCheckToCrabbox([], {}, { result })).toBe(false);
    }
    for (const result of [docsResult, metadataResult, mixedResult]) {
      expect(shouldDelegateChangedCheckToCrabbox([], { OPENCLAW_TESTBOX: "1" }, { result })).toBe(
        true,
      );
    }
  });

  it("delegates staged changed gates as explicit remote paths", () => {
    const dir = createGitRepo("openclaw-check-changed-staged-delegate-");
    const stagedPath = process.platform === "win32" ? "src/staged file.ts" : " src/staged\nfile.ts";
    writeRepoFile(dir, stagedPath, "export const staged = 1;\n");
    git(dir, ["add", "--", stagedPath]);

    const args = buildChangedCheckCrabboxArgs(["--staged", "--timed"], { cwd: dir });
    expect(args.slice(args.indexOf("check:changed") + 1)).toEqual([
      "--timed",
      "--paths-from-git",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--",
      stagedPath,
    ]);
  });

  it("delegates empty staged changed gates without rediscovering unstaged paths", () => {
    const dir = createGitRepo("openclaw-check-changed-empty-staged-delegate-");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "unstaged.ts"), "export const unstaged = 1;\n", "utf8");

    const args = buildChangedCheckCrabboxArgs(["--staged", "--timed"], { cwd: dir });

    expect(args.slice(args.indexOf("check:changed") + 1)).toEqual(["--timed", "--no-changes"]);
  });

  it("does not delegate dry-run, CI, or remote-child changed gates", () => {
    expect(shouldDelegateChangedCheckToCrabbox(["--dry-run"], {})).toBe(false);
    expect(shouldDelegateChangedCheckToCrabbox([], { GITHUB_ACTIONS: "true" })).toBe(false);
    expect(shouldDelegateChangedCheckToCrabbox([], { CI: "1" })).toBe(false);
    expect(
      shouldDelegateChangedCheckToCrabbox([], { OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "1" }),
    ).toBe(false);
  });

  it.each([true])(
    "selects consuming test graphs with UI CSS and docs companions (deleted UI test: %s)",
    (deleted) => {
      const dir = tempDirs.make("openclaw-ui-companion-checks-");
      const testPath = "ui/src/e2e/fixture.e2e.test.ts";
      const styles = ["ui/src/styles/chat/fixture-a.css", "ui/src/styles/chat/fixture-b.css"];
      const docsPath = "docs/web/control-ui/fixture.md";
      writeRepoFile(dir, testPath, "export {};\n");
      for (const style of styles) {
        writeRepoFile(dir, style, ".fixture { display: block; }\n");
      }
      writeRepoFile(dir, docsPath, "# Fixture\n");
      if (deleted) {
        unlinkSync(path.join(dir, testPath));
      }

      const changedPaths = [testPath, ...styles, docsPath];
      const script = `
        import { detectChangedLanes } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/changed-lanes.mts")).href)};
        import { createChangedCheckPlan } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/check-changed.mts")).href)};
        const result = detectChangedLanes(${JSON.stringify(changedPaths)});
        const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });
        console.log(JSON.stringify({
          lanes: result.lanes,
          extensionImpactFromCore: result.extensionImpactFromCore,
          commands: plan.commands.map(({ name, args, coreTestCheck }) => ({ name, args, coreTestCheck })),
        }));
      `;
      const output = execFileSync(
        testNodeExecPath,
        ["--import", tsxImport, "--input-type=module", "--eval", script],
        { cwd: dir, encoding: "utf8", env: createNestedGitEnv() },
      );
      const plan = JSON.parse(output) as {
        lanes: ReturnType<typeof createEmptyChangedLanes>;
        extensionImpactFromCore: boolean;
        commands: ReturnType<typeof createChangedCheckPlan>["commands"];
      };
      expectLanes(plan.lanes, { ui: true, coreTests: true, docs: true });
      expect(plan.extensionImpactFromCore).toBe(false);
      expect(plan.commands.flatMap((command) => command.coreTestCheck ?? [])).toEqual([
        "checkBoundary",
        "checkTypes",
      ]);
      const commands = plan.commands.map((command) => command.args[0]);
      expect(commands).toContain("tsgo:ui");
      expect(commands).toContain("tsgo:core:test");
      expect(commands).not.toContain("tsgo:core");
      expect(
        plan.commands
          .filter((command) => command.name.startsWith("lint UI changed style"))
          .map((command) => command.args),
      ).toEqual([
        ["--import", "tsx", "scripts/run-stylelint.mts", ...(deleted ? [] : [testPath]), ...styles],
      ]);
    },
  );

  it("routes live Docker ACP tooling changes through a focused gate", () => {
    const result = detectChangedLanes([
      "scripts/lib/live-docker-auth.sh",
      "scripts/test-docker-all.mjs",
      "scripts/test-live-acp-bind-docker.sh",
      "src/gateway/gateway-acp-bind.live.test.ts",
      "docs/help/testing-live.md",
    ]);
    const plan = createChangedCheckPlan(result);
    expectLanes(result.lanes, { docs: true, liveDockerTooling: true });
    expect(plan.commands.find((command) => command.name === "live Docker shell syntax")).toEqual({
      name: "live Docker shell syntax",
      bin: "bash",
      args: [
        "-n",
        "scripts/lib/live-docker-auth.sh",
        "scripts/test-live-acp-bind-docker.sh",
        "scripts/test-live-cli-backend-docker.sh",
        "scripts/test-live-codex-harness-docker.sh",
        "scripts/test-live-gateway-models-docker.sh",
        "scripts/test-live-models-docker.sh",
        "scripts/test-live-subagent-announce-docker.sh",
      ],
    });
    expect(
      plan.commands.find((command) => command.name === "live Docker scheduler dry run"),
    ).toMatchObject({
      bin: "node",
      args: ["scripts/test-docker-all.mjs"],
      env: { OPENCLAW_DOCKER_ALL_DRY_RUN: "1", OPENCLAW_DOCKER_ALL_LIVE_MODE: "only" },
    });
  });

  it.each([
    {
      before: { scripts: {}, dependencies: { fixture: "1" } },
      after: {
        scripts: { "test:docker:live-models": "bash live.sh" },
        dependencies: { fixture: "2" },
      },
      expected: { releaseMetadata: true },
    },
  ])("classifies package $before -> $after through Git", ({ before, after, expected }) => {
    const result = classifyPackageJsonChange("openclaw-package-scripts-", before, after);
    const plan = createChangedCheckPlan(result);

    expect(result.paths).toEqual(["package.json"]);
    expectLanes(result.lanes, expected);
    expect(plan.commands.some((command) => command.name === "live Docker scheduler dry run")).toBe(
      result.lanes.liveDockerTooling,
    );
    if (result.lanes.tooling) {
      expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
      expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
    }
    if (result.lanes.releaseMetadata) {
      expect(plan.commands.map((command) => command.name)).toContain("release metadata guard");
    }
  });

  it("keeps release metadata commits off the full changed gate", () => {
    const result = detectChangedLanes([
      "CHANGELOG/records/2026.9.4.md",
      "apps/android/version.json",
      "docs/.generated/config-baseline.sha256",
      "package.json",
    ]);
    const plan = createChangedCheckPlan(result, { staged: true });
    expectLanes(result.lanes, { docs: true, releaseMetadata: true });
    const commands = plan.commands.map((command) => command.args[0]);
    expect(commands).not.toContain("tsgo:all");
    expect(commands).not.toContain("ios:version:check");
    expect(commands).toContain("android:version:check");
    expect(
      plan.commands.find((command) => command.args[0] === "release-metadata:check")?.args,
    ).toEqual(["release-metadata:check", "--staged"]);
  });

  it("passes release metadata base and head refs as options", () => {
    const result = detectChangedLanes(["CHANGELOG.md"]);
    const plan = createChangedCheckPlan(result, { base: "main", head: "feature" });

    expect(
      plan.commands.find((command) => command.args[0] === "release-metadata:check")?.args,
    ).toEqual(["release-metadata:check", "--base", "main", "--head", "feature"]);
    const staged = createChangedCheckPlan(result, { staged: true, base: "main" });
    expect(
      staged.commands.find((command) => command.name === "release metadata guard")?.args,
    ).toEqual(["release-metadata:check", "--staged", "--base", "main"]);
    expect(plan.commands.find((command) => command.args[0] === "changelog:check")?.args).toEqual([
      "changelog:check",
    ]);
  });

  it("runs the npm package-lock guard for dependency package surfaces", () => {
    expect(
      shouldRunNpmLockGuard([
        "extensions/slack/package.json",
        "extensions/slack/deps/local-runtime/package.json",
        "scripts/generate-npm-package-lock.mts",
      ]),
    ).toBe(true);

    const result = detectChangedLanes(["extensions/slack/package.json"]);
    const plan = createChangedCheckPlan(result);
    const npmLockGuard = createNpmLockGuardCommand(["extensions/slack/package.json"]);

    expect(npmLockGuard?.args.slice(0, 3)).toEqual([
      "--import",
      "tsx",
      "scripts/generate-npm-package-lock.mts",
    ]);
    expect(
      npmLockGuard?.args.some((arg) => arg.replaceAll("\\", "/").endsWith("extensions/slack")),
    ).toBe(true);
    expect(plan.commands.map((command) => command.name)).toContain("npm package-lock guard");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("deps:npm-lock:check");
  });

  it.each([true])("retains non-typecheck gates with inert core edits (mixed=%s)", (mixed) => {
    const inert = "src/gateway/control-plane-rate-limit.ts";
    const remaining = mixed ? ["src/gateway/server.ts"] : ["docs/gateway/authentication.md"];
    const result = detectChangedLanes([inert, ...remaining]);
    const plan = createChangedCheckPlan(result, {
      typecheckResult: detectChangedLanesForPaths({ paths: remaining, base: "HEAD" }),
      env: {},
    });
    const names = plan.commands.map((command) => command.name);
    expect(names.includes("core tsgo graph boundary")).toBe(mixed);
    expect(names.some((name) => name.startsWith("typecheck"))).toBe(mixed);
    expect(plan.commands.some((command) => command.args[0]?.startsWith("tsgo:"))).toBe(mixed);
    expect(names.some((name) => name.startsWith("lint core"))).toBe(true);
    expect(names).toEqual(
      expect.arrayContaining([
        "format changed files",
        "line-cap growth ratchet",
        "max-lines suppression ratchet",
        "assertion SAFETY comment ratchet",
        "dead export scan (skip with OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE=1)",
      ]),
    );
  });

  it.each([["package.json", true]])(
    "keeps unguarded release metadata typechecks for %s: %s",
    (companion, expected) => {
      const result = detectChangedLanes(["src/gateway/control-plane-rate-limit.ts", companion]);
      const plan = createChangedCheckPlan(result, {
        typecheckResult: detectChangedLanes([companion]),
        env: {},
      });
      expect(plan.commands.some((command) => command.name.startsWith("typecheck"))).toBe(expected);
    },
  );

  it("compares regular working files with the merge base, excluding path lifecycle changes", () => {
    const dir = tempDirs.make("openclaw-inert-paths-");
    git(dir, ["init", "-q"]);
    for (const file of ["kept.ts", "renamed.ts", "deleted.ts", "linked.ts"]) {
      writeRepoFile(dir, file, "// old\nexport const x = 1;\n");
    }
    symlinkSync("kept.ts", path.join(dir, "was-link.ts"));
    const invalidUtf8 = (byte: number) =>
      Buffer.concat([
        Buffer.from("// "),
        Buffer.from([byte]),
        Buffer.from("\nexport const x = 1;\n"),
      ]);
    writeFileSync(path.join(dir, "bytes.ts"), invalidUtf8(0xff));
    commitAll(dir, "base");
    const base = git(dir, ["rev-parse", "HEAD"]);
    writeRepoFile(dir, "kept.ts", "// branch\nexport const x = 1;\n");
    commitAll(dir, "branch comment");
    writeRepoFile(dir, "kept.ts", "// working tree\nexport const x = 1;\n");
    renameSync(path.join(dir, "renamed.ts"), path.join(dir, "moved.ts"));
    unlinkSync(path.join(dir, "deleted.ts"));
    unlinkSync(path.join(dir, "linked.ts"));
    symlinkSync("kept.ts", path.join(dir, "linked.ts"));
    unlinkSync(path.join(dir, "was-link.ts"));
    writeRepoFile(dir, "was-link.ts", "// old\nexport const x = 1;\n");
    writeFileSync(path.join(dir, "bytes.ts"), invalidUtf8(0xfe));
    writeRepoFile(dir, "added.ts", "// old\nexport const x = 1;\n");
    const paths = listChangedPathsFromGit({ base, cwd: dir });
    expect(findTypecheckInertPaths({ paths, base, cwd: dir })).toEqual(["kept.ts"]);
    expect(findTypecheckInertPaths({ paths, base: "missing-ref", cwd: dir })).toEqual([]);
  });

  it.each([true])("preserves mixed native lint with SwiftLint=%s", (swiftlintAvailable) => {
    for (const { paths, androidLint, macosCi } of [
      { paths: ["apps/ios/Sources/RootTabs.swift"], androidLint: false, macosCi: false },
      {
        paths: [
          "apps/android/app/src/main/AndroidManifest.xml",
          "apps/ios/Sources/RootTabs.swift",
          "apps/shared/OpenClawKit/Sources/OpenClawKit/Client.swift",
        ],
        androidLint: true,
        macosCi: true,
      },
    ]) {
      const plan = createChangedCheckPlan(detectChangedLanes(paths), {
        env: { CI: "1", PATH: "/usr/bin" },
        platform: "linux",
        swiftlintAvailable,
      });
      const commands = new Set(plan.commands.map((command) => command.args[0]));

      expect(commands.has("android:lint")).toBe(androidLint);
      expect(commands.has("lint:apps")).toBe(swiftlintAvailable);
      expect(commands.has("test:macos:ci")).toBe(macosCi);
      expect(
        plan.commands.some(
          (command) => command.name === "lint apps (swiftlint unavailable on this host)",
        ),
      ).toBe(!swiftlintAvailable);
    }
  });

  it.each<[string, Partial<ReturnType<typeof createEmptyChangedLanes>>, string[]]>([
    ["ui/src/e2e/chat-flow.test-support.ts", { coreTests: true }, ["tsgo:core:test"]],
    [
      "extensions/discord/src/index.test-helpers.ts",
      { extensionTests: true },
      ["tsgo:extensions:test"],
    ],
    [
      "src/plugin-sdk/core.ts",
      { core: true, coreTests: true, extensions: true, extensionTests: true },
      [
        "plugin-sdk:check-exports",
        "plugin-sdk:surface:check",
        "tsgo:core",
        "tsgo:core:test",
        "tsgo:extensions",
        "tsgo:extensions:test",
      ],
    ],
    [
      "packages/mermaid-renderer/src/renderer.ts",
      { ui: true, coreTests: true },
      ["tsgo:core:test", "tsgo:ui"],
    ],
    [
      "packages/normalization-core/src/record-coerce.ts",
      { core: true, coreTests: true, ui: true },
      ["tsgo:core", "tsgo:core:test", "tsgo:ui"],
    ],
    ["assets/avatar-placeholder.svg", { tooling: true }, []],
  ])("selects consuming typecheck lanes for %s", (file, lanes, typechecks) => {
    const result = detectChangedLanes([file]);
    expectLanes(result.lanes, lanes);
    const commands = createChangedCheckPlan(result).commands;
    expect(
      commands
        .map(({ args }) => args[0])
        .filter((arg) => arg?.startsWith("tsgo:") || arg?.startsWith("plugin-sdk:")),
    ).toEqual(typechecks);
  });

  it.each<[string[], string[][]]>([
    [["pnpm-lock.yaml"], [["tsgo:all"], ["lint"]]],
    [
      ["scripts/generate-prompt-snapshots.ts"],
      [["prompt:snapshots:check"], ["test:serial", "test/scripts/prompt-snapshots.test.ts"]],
    ],
    [
      ["scripts/lib/bundled-runtime-sidecar-paths.json"],
      [["runtime-sidecars:check"], ["test:serial", "src/plugins/bundled-plugin-metadata.test.ts"]],
    ],
    [["src/state/openclaw-agent-schema.sql"], [["sqlite:sessions-schema:check"]]],
    [
      ["scripts/swift-build-cache-metadata.py"],
      [["test:serial", "test/scripts/swift-build-cache-metadata.test.ts"], ["test:macos:ci"]],
    ],
    [
      ["appcast-arm64.xml"],
      [["test:serial", "test/appcast.test.ts", "test/scripts/make-appcast.test.ts"]],
    ],
  ])("selects owner checks for %j", (paths, expected) => {
    const commands = createChangedCheckPlan(detectChangedLanes(paths)).commands.map(
      ({ args }) => args,
    );
    for (const args of expected) {
      expect(commands).toContainEqual(args);
    }
  });

  it("excludes generated mobile build inputs from protocol coverage", () => {
    const plan = createChangedCheckPlan(
      detectChangedLanes(["apps/shared/OpenClawKit/Sources/.build/Generated.swift"]),
    );
    expect(plan.commands.map(({ args }) => args[0])).not.toContain(
      "scripts/check-protocol-event-coverage.mjs",
    );
  });

  it("adds the warning-only temp creation report for changed test paths", () => {
    const result = detectChangedLanes(["test/helpers/temp-fixture.ts"]);
    const plan = createChangedCheckPlan(result, { base: "main", head: "feature" });
    const command = plan.commands.find(
      (candidate) => candidate.name === "test temp creation report (warning-only)",
    );

    expect(shouldRunTestTempCreationReport(result.paths)).toBe(true);
    expect(command).toMatchObject({
      bin: "node",
      args: ["scripts/report-test-temp-creations.mjs", "--base", "main", "--head", "feature"],
    });
  });

  it("forwards staged and worktree bases to source ratchets", () => {
    const result = detectChangedLanes(["src/runtime.ts"]);
    for (const staged of [false, true]) {
      const commands = createChangedCheckPlan(result, { staged, base: "main" }).commands;
      for (const owner of [
        "check:line-cap-ratchet",
        "check:max-lines-ratchet",
        "check:assertion-safety",
        "check:test-timeout-race-ratchet",
        "check:test-mock-exports",
      ]) {
        expect(commands.find(({ args }) => args[0] === owner)?.args).toEqual([
          owner,
          ...(staged ? ["--staged"] : []),
          "--base",
          "main",
        ]);
      }
    }
  });

  it("keeps docs-only changes cheap, including changelog companions", () => {
    const result = detectChangedLanes(["docs/ci.md", "README.md", "CHANGELOG.md"]);
    const commands = createChangedCheckPlan(result).commands.map((command) => command.args[0]);
    expect(result.docsOnly).toBe(true);
    expectLanes(result.lanes, { docs: true });
    expect(commands).toEqual([
      "check:no-conflict-markers",
      "check:changelog-attributions",
      "check:doctor-deprecation-registry",
      "lint:extensions:no-guarded-wildcard-reexports",
      "lint:extensions:no-plugin-sdk-wildcard-reexports",
      "dup:check:coverage",
      "check:coercion-helpers",
      "deps:pins:check",
      "format:check",
      "deps:patches:check",
    ]);
  });
});

describe("delegationFailedBeforeRunning", () => {
  it("treats a lease or network failure as never having run", () => {
    const output = [
      'request failed: Get "https://backend.blacksmith.sh/api/testbox/list?all=true": context deadline exceeded',
      "blacksmith testbox run exited 1",
    ].join("\n");

    expect(delegationFailedBeforeRunning(output)).toBe(true);
  });

  it("treats a full workload-routing provider outage as never having run", () => {
    const output = [
      "[crabbox] no ready provider for workload=ci-fast",
      "[crabbox] provider readiness blacksmith-testbox:doctor exited 1,daytona:doctor exited 124,azure:doctor exited 124,aws:doctor exited 124",
    ].join("\n");

    expect(delegationFailedBeforeRunning(output)).toBe(true);
  });

  // A crash after dispatch produces no summary either, so absence of one cannot
  // be read as "never ran" — that is how an unknown Linux result would go green.
  it("fails closed when the wrapper dies without saying why", () => {
    expect(delegationFailedBeforeRunning("node: killed\n")).toBe(false);
    expect(delegationFailedBeforeRunning("")).toBe(false);
  });

  it("keeps a command verdict authoritative even alongside network noise", () => {
    const output = [
      'request failed: Get "https://backend.blacksmith.sh/api/testbox/list": context deadline exceeded',
      '{"provider":"blacksmith-testbox","runStatus":"failed","errorKind":"command-exit","exitCode":1}',
    ].join("\n");

    expect(delegationFailedBeforeRunning(output)).toBe(false);
  });
});
