import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  acquireMaintenanceLock,
  assertNoSystemLaunchDaemonOwnership,
  formatUpdateFailure,
  inspectBuildState,
  isOwnedGatewayEntrypoint,
  maintainMain,
  parseGatewayLogAudit,
  prepareGatewaySuspension,
  replaceLaunchAgentProgramArgument,
  repointManagedGatewayDeployment,
  resolveLaunchAgentExitTimeoutSeconds,
  resolveManagedGatewayEntrypoint,
  runBuiltGatewayCall,
  runBuiltGatewayCli,
  runLiveUpdaterMain,
  verifyGatewayReadiness,
} from "../../.agents/skills/openclaw-live-updater/scripts/update-main.mjs";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../../gateway-shutdown-budget.mjs";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import { writeUpdateCompatibilityChunks } from "../../scripts/lib/update-compat-chunks.mts";
import { listCoreRuntimePostBuildOutputs } from "../../scripts/runtime-postbuild.mts";
import { buildLaunchAgentEnvironmentWrapper } from "../../src/daemon/launchd-env-wrapper.js";
import { buildLaunchAgentPlist } from "../../src/daemon/launchd-plist.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

const maintenanceReadState = vi.hoisted(() => vi.fn());
vi.mock("../../src/daemon/service-state.js", async (original) => ({
  ...(await original<typeof import("../../src/daemon/service-state.js")>()),
  readGatewayServiceState: maintenanceReadState,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, ".agents/skills/openclaw-live-updater/scripts/update-main.mjs");
// update-main.mjs statically imports scripts/run-node.mts, whose profile graph
// requires the TypeScript loader (the documented invocation passes --import tsx).
const updaterLoaderArgs = [
  "--import",
  pathToFileURL(path.join(repoRoot, "scripts", "tsx.mjs")).href,
];
const fixtureOrigins = new Map<string, string>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let fixtureTemplate: ReturnType<typeof initializeFixture> | undefined;
const posixTest = process.platform === "win32" ? test.skip : test;
const linuxTest = process.platform === "linux" ? test : test.skip;
const gatewayChecks = [
  "pnpm openclaw gateway status --deep --require-rpc --json",
  "pnpm openclaw health --verbose --json",
];
const rebuildMac =
  "env OPENCLAW_MAC_REUSE_BUILD=1 SKIP_PNPM_INSTALL=1 bash scripts/restart-mac.sh --sign --wait --target-only";
const uid = process.getuid?.() ?? 501;
const bootout = `/bin/launchctl bootout gui/${uid}/ai.openclaw.gateway`;
const traceOn = "/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE 1";
const traceOff = "/bin/launchctl unsetenv OPENCLAW_GATEWAY_STARTUP_TRACE";

function launchAgentStart(plistPath: string) {
  return [
    `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
    `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
  ];
}

function writeFixtureFile(file: string, contents: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function readJsonLines(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function preparedSuspension(suspensionId = "fixture-suspension") {
  return { status: "ready", suspensionId };
}

function busySuspension(kind: string, message: string) {
  return {
    status: "busy",
    reason: "active-work",
    retryAfterMs: 20_000,
    activeCount: 1,
    blockers: [{ kind, count: 1, message }],
  };
}

function privateCommandFailure(operation: string, status: number) {
  return Object.assign(new Error(`secret ${operation} message`), {
    status,
    stdout: `secret ${operation} stdout`,
    stderr: `secret ${operation} stderr`,
  });
}

function signedMacBundle(mirror: string) {
  const bundle = path.join(mirror, "dist/OpenClaw.app");
  const marker = writeFixtureFile(path.join(bundle, "Contents/signature-marker"), "signed\n");
  return { bundle, marker };
}

const preservedMacBundles = (mirror: string) =>
  readdirSync(path.join(mirror, ".git")).filter((entry) => entry.startsWith(".openclaw-live-mac-"));

function rejectWith(message: string) {
  return () => {
    throw new Error(message);
  };
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function invariantDiagnostic(code: string, details?: Record<string, unknown>) {
  return { kind: "invariant", code, ...(details ? { details } : {}) };
}

function commandDiagnostic(operation: string, status: number) {
  return { kind: "command", operation, status };
}

function failureEnvelope(code: string, diagnostics: object) {
  return { error: { code, diagnostics } };
}

function processCleanupFailure(processGroupId: number, message: string) {
  return Object.assign(new Error(message), {
    code: "EPROCESSGROUP_CLEANUP_FAILED",
    processGroupId,
    processTreeState: "live",
  });
}

function writeManagedPlist(plist: string, state: string, programArguments: string[]) {
  writeFixtureFile(
    plist,
    buildLaunchAgentPlist({
      label: "ai.openclaw.gateway",
      programArguments,
      workingDirectory: state,
      stdoutPath: path.join(state, "gateway.log"),
      stderrPath: path.join(state, "gateway.log"),
    }),
  );
}

function expectRetargeted(deployment: unknown, source: string, snapshot: string) {
  expect(deployment).toMatchObject({
    changed: true,
    entrypoint: source,
    previousEntrypoint: snapshot,
  });
}

function writeSystemLaunchDaemonFixture(contents: string, name = "fixture.plist") {
  const file = path.join(tempDirs.make("updater-plist-"), name);
  writeFileSync(file, contents);
  return path.relative("/Library/LaunchDaemons", file);
}

function runUpdater(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [...updaterLoaderArgs, script, ...args], {
    encoding: "utf8",
    ...options,
  });
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function setTrustedGitConfig(cwd: string, key: string, value: string) {
  git(cwd, "config", key, value);
  // Git replaces config through a lockfile, inheriting the runner umask. Keep
  // this trusted fixture deterministic without weakening the production guard.
  chmodSync(path.join(cwd, ".git/config"), 0o600);
}

function installTrackedGitHook(root: string, checkout: string, key: string, body = "") {
  const marker = path.join(root, `${key}-ran`);
  const hook = writeFixtureFile(
    path.join(root, `${key}.sh`),
    `#!/bin/sh\ntouch ${marker}\n${body}`,
  );
  chmodSync(hook, 0o755);
  setTrustedGitConfig(checkout, key, hook);
  rmSync(marker, { force: true });
  return marker;
}

function fetchFixtureMain(checkout: string, remote: string) {
  const origin = fixtureOrigins.get(checkout);
  if (!origin) {
    throw new Error(`missing fixture origin for ${checkout}`);
  }
  git(checkout, "fetch", origin, `main:refs/remotes/${remote}/main`);
}

function writeFixtureGitBin(root: string, origin: string) {
  const binDir = path.join(root, "bin");
  const gitShim = path.join(binDir, "git");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  mkdirSync(binDir);
  writeFileSync(
    gitShim,
    `#!/bin/sh\nif [ "$3" = "fetch" ]; then\n  exec "${realGit}" -C "$2" fetch "${origin}" "main:refs/remotes/origin/main"\nfi\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(gitShim, 0o755);
  return binDir;
}

type FixtureCommand = {
  args: string[];
  bin: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requireProcessTreeExit: boolean;
  timeoutMs: number;
};

async function runFixtureManagedCommand({ args, bin, cwd, env }: FixtureCommand) {
  // Fixtures need a real fast-forward, but do not need production process-tree timing.
  // Keep that contract in managed-child-process tests so fixture assertions stay isolated.
  execFileSync(bin, args, { cwd, env, stdio: "ignore" });
  return 0;
}

function stoppedGateway() {
  return { runtimeStatus: "stopped", port: 18789, portStatus: "free", proofSource: "fixture" };
}

function emptyAudit() {
  return { entries: 0, errorCount: 0, warningCount: 0, errors: [], warnings: [] };
}

function maintainFixture(
  options: Record<string, unknown>,
  dependencies: Record<string, unknown> = {},
) {
  return maintainMain(options, {
    fetchMain: fetchFixtureMain,
    inspectGatewayDeployment: () => null,
    verifyGatewayRuntime: () => null,
    auditGatewayLogs: emptyAudit,
    armEnvironmentRestore: () => ({ disarm() {} }),
    assertNoSystemLaunchDaemonOwnership: () => {},
    prepareGatewaySuspension: () => preparedSuspension(),
    prepareGatewayEntrypointReplacement: () => ({
      install() {},
      discard() {},
    }),
    probeGatewayMilestones: () => ({ listenerReady: true, healthzReady: true, readyzReady: true }),
    proveGatewayStopped: stoppedGateway,
    readLaunchdEnvironment: () => null,
    runManagedCommand: runFixtureManagedCommand,
    waitForGatewayProcess: () => {},
    ...dependencies,
  });
}

function initializeFixture(root: string) {
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const mirror = path.join(root, "mirror");
  const gitTemplate = path.join(root, "git-template");
  mkdirSync(gitTemplate);
  mkdirSync(seed);
  git(root, "init", "--bare", "-b", "main", `--template=${gitTemplate}`, origin);
  git(seed, "init", "-b", "main", `--template=${gitTemplate}`);
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.com");
  writeFileSync(path.join(seed, "README.md"), "one\n");
  writeFileSync(path.join(seed, ".gitignore"), "dist/\nnode_modules/\n");
  git(seed, "add", "README.md", ".gitignore");
  git(seed, "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", "../origin.git");
  git(seed, "push", "-u", "origin", "main");
  git(root, "clone", `--template=${gitTemplate}`, origin, mirror);
  const canonicalOrigin = "https://github.com/openclaw/openclaw.git";
  git(mirror, "remote", "set-url", "origin", canonicalOrigin);
  return { root, mirror, origin, seed };
}

type FixtureOptions = { includeSeed?: boolean; built?: boolean; dependencies?: boolean };
function makeFixture(options: FixtureOptions = {}) {
  if (!fixtureTemplate) {
    throw new Error("fixture template is not initialized");
  }
  const root = realpathSync(tempDirs.make("openclaw-live-updater-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const mirror = path.join(root, "mirror");
  // Mutable refs and configs must stay isolated; copying one initialized repo
  // set avoids rebuilding identical Git history for every test.
  const copyOptions = { mode: fsConstants.COPYFILE_FICLONE, recursive: true };
  cpSync(fixtureTemplate.origin, origin, copyOptions);
  cpSync(fixtureTemplate.mirror, mirror, copyOptions);
  if (options?.includeSeed) {
    cpSync(fixtureTemplate.seed, seed, copyOptions);
  }
  fixtureOrigins.set(mirror, origin);
  if (options.dependencies) {
    mkdirSync(path.join(mirror, "node_modules"));
  }
  if (options.built) {
    writeBuild(mirror);
  }
  const runOptions = {
    checkout: mirror,
    remote: "origin",
    lockPath: path.join(root, "maintenance.lock"),
  };
  const fixture = {
    root,
    mirror,
    origin,
    seed,
    options: runOptions,
    run: (dependencies: Record<string, unknown> = {}) => maintainFixture(runOptions, dependencies),
  };
  return fixture;
}
type Fixture = ReturnType<typeof makeFixture>;

function writeBuild(mirror: string) {
  const head = git(mirror, "rev-parse", "HEAD");
  const gatewayEntrypoint = path.join(mirror, "dist/index.js");
  writeFixtureFile(gatewayEntrypoint, "// built\n");
  // Snapshot ownership rejects group-writable executables, so fixtures must
  // not inherit a permissive CI umask and accidentally model an unsafe build.
  chmodSync(gatewayEntrypoint, 0o600);
  writeFixtureFile(path.join(mirror, "dist/entry.js"), "// built\n");
  writeFixtureFile(
    path.join(mirror, "dist/control-ui/index.html"),
    '<script type="module" src="./assets/app.js"></script>\n',
  );
  writeFixtureFile(path.join(mirror, "dist/control-ui/assets/app.js"), "// ui\n");
  for (const stamp of [BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE]) {
    writeJson(path.join(mirror, "dist", stamp), { head, inputsClean: true });
  }
  writeUpdateCompatibilityBuildFixture(mirror);
  writeUpdateCompatibilityChunks({
    distDir: path.join(mirror, "dist"),
    sourceDir: mirror,
    inventory: previousReleaseInventory,
  });
  for (const relativePath of listCoreRuntimePostBuildOutputs({ rootDir: mirror })) {
    const outputPath = path.join(mirror, relativePath);
    if (!existsSync(outputPath)) {
      writeFixtureFile(outputPath, "// runtime postbuild\n");
    }
  }
  writeJson(path.join(mirror, "dist/build-info.json"), { commit: head });
}

function fakeCommands(mirror: string) {
  const calls: string[] = [];
  return {
    calls,
    runCommand: (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      if (command === "pnpm" && args[0] === "install") {
        mkdirSync(path.join(mirror, "node_modules"), { recursive: true });
      }
      if (command === "pnpm" && args[0] === "build") {
        writeBuild(mirror);
      }
    },
  };
}

function passGatewayRestartVerification({ timing }: { timing: Record<string, unknown> }) {
  return { audit: emptyAudit(), timing };
}

function managedTimeoutError() {
  return Object.assign(new Error("managed timeout"), { code: "ETIMEDOUT" });
}

function gatewayCliDeployment(root: string, checkout: string) {
  const entrypoint = path.join(checkout, "dist/index.js");
  return {
    configPath: path.join(root, "openclaw.json"),
    entrypoint,
    executable: process.execPath,
    invocationPrefix: [entrypoint],
    port: 18789,
    runtime: process.execPath,
  };
}

function createManagedLaunchAgentFixture(root: string, mirror: string) {
  const plistPath = path.join(root, "ai.openclaw.gateway.plist");
  writeFileSync(plistPath, "plist\n", { mode: 0o600 });
  return {
    lockPath: path.join(root, "maintenance.lock"),
    plistPath,
    deployment: {
      ...gatewayCliDeployment(root, mirror),
      entrypointIndex: 1,
      label: "ai.openclaw.gateway",
      plistPath,
    },
  };
}

function makeManagedFixture(options: Omit<FixtureOptions, "includeSeed"> = {}) {
  const fixture = makeFixture(options);
  return { ...fixture, ...createManagedLaunchAgentFixture(fixture.root, fixture.mirror) };
}

function pushFixtureChange(seed: string, file = "docs/index.md") {
  writeFixtureFile(path.join(seed, file), "// changed\n");
  git(seed, "add", file);
  git(seed, "commit", "--quiet", "-m", "fixture update");
  git(seed, "push");
}

function createSnapshotFixture({ current = true, advance = false } = {}) {
  const fixture = makeFixture({ includeSeed: true, dependencies: true, built: current });
  const { root, mirror, seed } = fixture;
  if (advance) {
    pushFixtureChange(seed);
  }
  const managed = createManagedLaunchAgentFixture(root, mirror);
  const source = managed.deployment.entrypoint;
  const snapshot = path.join(root, "gateway-ancestor/dist/index.js");
  const commands = fakeCommands(mirror);
  let entrypoint = snapshot;
  const inspect = () => ({ ...managed.deployment, entrypoint, invocationPrefix: [entrypoint] });
  const record = (event: string) => commands.calls.push(event);
  const replacement = (observe = false) => ({
    install() {
      if (observe) {
        record("install replacement plist");
      }
      entrypoint = source;
    },
    restore() {
      if (observe) {
        record("restore previous plist");
      }
      entrypoint = snapshot;
    },
    discard() {},
  });
  return {
    ...fixture,
    ...managed,
    source,
    snapshot,
    commands,
    inspect,
    stopped() {
      record("prove gateway stopped");
      return stoppedGateway();
    },
    prepareReplacement() {
      record("prepare replacement plist");
      return replacement(true);
    },
    run: (dependencies: Record<string, unknown>) =>
      fixture.run({
        runCommand: commands.runCommand,
        inspectGatewayDeployment: inspect,
        prepareGatewayEntrypointReplacement: () => replacement(),
        replaceGatewayEntrypoint: (_deployment: unknown, next: string) => {
          entrypoint = next;
        },
        ...dependencies,
      }),
  };
}

function createGatewaySuspensionCliStub(
  root: string,
  requestError: { code: string; message: string; retryable: boolean; type: string },
) {
  const checkout = path.join(root, "checkout");
  const entrypoint = path.join(checkout, "dist/index.js");
  const configPath = path.join(root, "openclaw.json");
  const capturePath = path.join(root, "gateway-call-stub.mjs");
  const callsPath = path.join(root, "gateway-call-params.jsonl");
  writeFixtureFile(entrypoint, "// built\n");
  writeFileSync(configPath, "{}\n");
  writeFileSync(
    capturePath,
    `import fs from "node:fs";
const paramsIndex = process.argv.indexOf("--params");
const params = JSON.parse(process.argv[paramsIndex + 1] ?? "{}");
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(params) + "\\n");
if (Object.hasOwn(params, "terminalPolicy")) {
  process.stdout.write(JSON.stringify({ ok: false, error: ${JSON.stringify(requestError)} }) + "\\n");
  process.exitCode = 1;
} else {
  process.stdout.write(${JSON.stringify(JSON.stringify(busySuspension("terminal-session", "1 open terminal session")) + "\n")});
}
`,
  );
  return {
    callsPath,
    checkout,
    deployment: { ...gatewayCliDeployment(root, checkout), invocationPrefix: [capturePath] },
  };
}

test("admits the installed Gateway shutdown budget while rejecting unbounded stops", () => {
  expect(resolveLaunchAgentExitTimeoutSeconds(LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS)).toBe(
    LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS,
  );
  expect(() => resolveLaunchAgentExitTimeoutSeconds(0)).toThrow("prevents bounded stopped proof");
  expect(() => resolveLaunchAgentExitTimeoutSeconds(LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS + 1)).toThrow(
    "prevents bounded stopped proof",
  );
});

describe("openclaw live updater", () => {
  beforeAll(() => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-live-updater-template-")));
    fixtureTemplate = initializeFixture(root);
  });

  afterEach(() => {
    fixtureOrigins.clear();
  });

  afterAll(() => {
    if (fixtureTemplate) {
      rmSync(fixtureTemplate.root, { recursive: true, force: true });
      fixtureTemplate = undefined;
    }
  });

  test.each([
    { code: "EPERM", loadedAfterRead: false },
    { code: "EIO", loadedAfterRead: false },
    { code: "EPERM", loadedAfterRead: true },
  ])(
    "handles plist errno $code and rechecks ownership (loaded=$loadedAfterRead)",
    ({ code, loadedAfterRead }) => {
      let probes = 0;
      vi.mocked(openSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("read failed"), { code });
      });
      const check = () =>
        assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
          readdirSync: () => ["com.vendor.plist"],
          spawnSync: (command: string) =>
            command === "/bin/launchctl"
              ? {
                  status: ++probes === 2 && loadedAfterRead ? 0 : 113,
                  stderr: "Could not find service",
                }
              : { status: 1, stderr: "Operation not permitted" },
        });
      if (code === "EIO") {
        expect(check).toThrow("could not read system LaunchDaemon plist");
        expect(probes).toBe(1);
      } else if (loadedAfterRead) {
        expect(check).toThrow("system/ai.openclaw.gateway already owns");
        expect(probes).toBe(2);
      } else {
        expect(check).not.toThrow();
        expect(probes).toBe(2);
      }
    },
  );

  test("rejects incomplete ownership queries", () => {
    expect(() =>
      assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
        readdirSync: () => [],
        spawnSync: () => ({
          status: 113,
          stderr: "Could not find service",
          error: Object.assign(new Error("query failed"), { code: "EIO" }),
        }),
      }),
    ).toThrow("could not verify system LaunchDaemon ownership");
  });

  test.each([
    ["extraction", { status: 0, error: new Error("timed out after exit zero") }],
    ["lint", { status: 0, error: new Error("timed out after exit zero") }],
  ] as const)("refuses incomplete native %s", (phase, result) => {
    const entry = writeSystemLaunchDaemonFixture("captured plist bytes");
    expect(() =>
      assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
        readdirSync: () => [entry],
        spawnSync: (command: string, args: string[]) => {
          if (command === "/bin/launchctl") {
            return { status: 113, stderr: "Could not find service" };
          }
          return args[0] === "-lint"
            ? phase === "lint"
              ? result
              : { status: 0 }
            : phase === "extraction"
              ? result
              : { status: 1 };
        },
      }),
    ).toThrow("could not inspect system LaunchDaemon plist");
  });

  test.skipIf(process.platform !== "darwin")(
    "native scan accepts XML/binary metadata and preserves exact Label types",
    () => {
      const file = path.join(tempDirs.make("updater-plist-proof-"), "fixture.plist");
      const check = () =>
        assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
          readdirSync: () => [path.relative("/Library/LaunchDaemons", file)],
          spawnSync: (command: string, args: string[], options: object) => {
            if (command === "/bin/launchctl") {
              return { status: 113, stderr: "Could not find service" };
            }
            return spawnSync(command, args, options);
          },
        });
      for (const [label, ownsGateway] of [
        ["<key>Label</key><string>ai.openclaw.gateway</string>", true],
        ["<key>Label</key><string>ai.openclaw.gateway\n</string>", false],
        ["<key>Label</key><dict><key>ai.openclaw.gateway</key><true/></dict>", false],
      ] as const) {
        for (const format of ["xml1", "binary1"]) {
          writeFileSync(
            file,
            `<plist version="1.0"><dict>${label}<key>Date</key><date>2026-01-01T00:00:00Z</date><key>Data</key><data>YWJj</data></dict></plist>`,
          );
          execFileSync("/usr/bin/plutil", ["-convert", format, "--", file]);
          if (ownsGateway) {
            expect(check).toThrow("already owns the managed Gateway label");
          } else {
            expect(check).not.toThrow();
          }
        }
      }
      writeFileSync(file, "not a plist");
      expect(check).toThrow("could not inspect system LaunchDaemon plist");
      writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
      expect(check).toThrow("could not read system LaunchDaemon plist");
    },
  );

  test("attributes raw and RPC logs through symlinked roots without hiding plugin errors", () => {
    const root = tempDirs.make("openclaw-log-attribution-");
    const managed = path.join(root, "managed");
    const linked = path.join(root, "current");
    const foreign = path.join(root, "foreign");
    for (const checkout of [managed, foreign]) {
      mkdirSync(path.join(checkout, ".git"), { recursive: true });
      mkdirSync(path.join(checkout, "dist"));
      writeFileSync(path.join(checkout, "package.json"), '{"name":"openclaw"}\n');
    }
    symlinkSync(managed, linked);
    const source = path.join(managed, "dist/logger.js");
    const plugin = path.join(foreign, "configured-plugin.ts");
    writeFileSync(source, "export {};\n");
    writeFileSync(plugin, "export default {};\n");
    const time = "2026-07-11T08:00:03.000Z";
    const raw = (message: string, fullFilePath: string, level = "ERROR") => ({
      "0": '{"subsystem":"gateway"}',
      "1": message,
      time,
      _meta: { date: time, logLevelName: level, path: { fullFilePath } },
    });
    const rpc = (message: string, file: string) => ({
      type: "log",
      time,
      level: "error",
      message,
      raw: JSON.stringify(raw(message, file)),
    });
    const output = [
      raw("startup warning", source, "WARN"),
      raw("managed failure", source),
      { type: "log", time, level: "error", message: "unattributed failure" },
      rpc("foreign failure", pathToFileURL(path.join(foreign, "dist/logger.js")).href),
      rpc("installed plugin failure", path.join(root, "extensions/example/dist/logger.js")),
      rpc("configured plugin failure", path.join(foreign, "extensions/configured/logger.js")),
      rpc("standalone plugin failure", `${plugin}:12:3`),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const since = Date.parse("2026-07-11T08:00:02.000Z");
    const sourceRoot = path.join(linked, "dist");

    expect(
      parseGatewayLogAudit(output, since, sourceRoot, [
        path.join(root, "extensions/example"),
        path.join(foreign, "extensions/configured"),
        plugin,
      ]),
    ).toMatchObject({
      entries: 6,
      errorCount: 5,
      warningCount: 1,
      errors: [
        { message: "managed failure" },
        { message: "unattributed failure" },
        { message: "installed plugin failure" },
        { message: "configured plugin failure" },
        { message: "standalone plugin failure" },
      ],
      warnings: [{ time, level: "warn", subsystem: "gateway", message: "startup warning" }],
    });
    expect(parseGatewayLogAudit(output, since, sourceRoot, null)).toMatchObject({
      entries: 7,
      errorCount: 6,
      warningCount: 1,
    });
  });

  test.each([
    ["distinct endpoint payloads", { ready: true }, true],
    ["liveness-shaped readiness", { ok: true, status: "ready" }, false],
  ] as const)(
    "routes managed probes through the injected port with %s",
    async (_name, ready, readyReady) => {
      const { root, mirror } = makeFixture({ built: true });
      const entrypoint = path.join(mirror, "dist/index.js");
      const callsPath = path.join(root, "managed-probe-calls.jsonl");
      writeFileSync(
        entrypoint,
        `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  args,
  port: process.env.OPENCLAW_GATEWAY_PORT,
}) + "\\n");
if (args.includes("--port")) process.exit(2);
console.log(JSON.stringify({ ok: true, channels: {} }));
`,
      );

      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const probe = vi.mocked(spawnSync).mockImplementation((command, args, options) => {
        if (command !== "/usr/sbin/lsof" && command !== "/usr/bin/curl") {
          return actual.spawnSync(command, args, options);
        }
        const stdout =
          command === "/usr/sbin/lsof"
            ? "123\n"
            : JSON.stringify(
                args?.at(-1)?.endsWith("/healthz") ? { ok: true, status: "live" } : ready,
              );
        return { pid: 123, output: [], status: 0, signal: null, stdout, stderr: "" };
      });
      const observedAt = "2026-07-31T18:00:00.000Z";
      try {
        const timing = await verifyGatewayReadiness(
          rejectWith("managed probes must use the exact built Gateway CLI"),
          mirror,
          git(mirror, "rev-parse", "HEAD"),
          () => {},
          gatewayCliDeployment(root, mirror),
          { now: () => Date.parse(observedAt) },
        );
        expect(timing).toMatchObject({
          listenerReadyAt: observedAt,
          healthzReadyAt: observedAt,
          readyzReadyAt: readyReady ? observedAt : null,
          deepRpcReadyAt: observedAt,
        });
      } finally {
        probe.mockReset();
      }

      expect(readJsonLines(callsPath)).toEqual([
        { args: ["gateway", "status", "--deep", "--require-rpc", "--json"], port: "18789" },
        { args: ["health", "--verbose", "--json"], port: "18789" },
      ]);
    },
  );

  test("bounds built Gateway CLI probes and cleans their config overlay", () => {
    const { root, mirror } = makeFixture({ built: true });
    const entrypoint = path.join(mirror, "dist/index.js");
    writeFileSync(entrypoint, "setInterval(() => {}, 1_000);\n");

    expect(() =>
      runBuiltGatewayCli(mirror, ["gateway", "status"], gatewayCliDeployment(root, mirror), {
        timeoutMs: 100,
      }),
    ).toThrow();
    expect(
      readdirSync(root).filter((name) => name.startsWith(".openclaw-live-updater-config-")),
    ).toEqual([]);
  });

  test.each([
    {
      code: "INVALID_REQUEST",
      message: "invalid gateway.suspend.prepare params",
      retryable: false,
    },
    { code: "UNAVAILABLE", message: "gateway scheduler recovery is pending", retryable: true },
  ])("retries only the exact legacy suspension error: $code", (requestError) => {
    const root = realpathSync(tempDirs.make("openclaw-legacy-gateway-suspension-"));
    const stub = createGatewaySuspensionCliStub(root, {
      type: "gateway_request_error",
      ...requestError,
    });
    if (requestError.code === "INVALID_REQUEST") {
      expect(
        prepareGatewaySuspension(stub.checkout, runBuiltGatewayCall, stub.deployment),
      ).toMatchObject({
        status: "busy",
        activeCount: 1,
        blockers: [{ kind: "terminal-session", count: 1 }],
      });
      const calls = readJsonLines(stub.callsPath) as {
        requestId: string;
        terminalPolicy?: string;
      }[];
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({
        requestId: expect.stringMatching(/^openclaw-live-updater-/u),
        terminalPolicy: "terminate",
      });
      expect(calls[1]).toEqual({ requestId: calls[0]?.requestId });
    } else {
      let failure: unknown;

      try {
        prepareGatewaySuspension(stub.checkout, runBuiltGatewayCall, stub.deployment);
      } catch (error) {
        failure = error;
      }

      expect(formatUpdateFailure(failure)).toMatchObject(
        failureEnvelope("gateway_suspend_prepare_failed", {
          kind: "invariant",
          cause: commandDiagnostic("gateway.suspend.prepare", 1),
        }),
      );
      expect(readJsonLines(stub.callsPath)).toHaveLength(1);
    }
  });

  test.each(["direct", "shell", "executable"])(
    "pins managed Gateway calls with a backward-compatible local overlay (%s)",
    (layout) => {
      const root = realpathSync(tempDirs.make("openclaw-gateway-call-"));
      const checkout = path.join(root, "checkout");
      const entrypoint = path.join(checkout, "dist/index.js");
      const capture = path.join(root, "capture.mjs");
      const configPath = path.join(root, "openclaw.json");
      mkdirSync(path.dirname(entrypoint), { recursive: true });
      writeFileSync(configPath, "{}\n");
      writeFileSync(
        capture,
        'import fs from "node:fs"; console.log(JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv, config: JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")), hasToken: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN), url: process.env.OPENCLAW_GATEWAY_URL ?? null }));\n',
      );

      const wrapper = path.join(root, "env-wrapper.sh");
      const envFile = path.join(root, "gateway.env");
      writeFileSync(wrapper, '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o700 });
      writeFileSync(envFile, "");
      const runtimePrefix = [process.execPath, "--max-old-space-size=128", capture];
      const invocationPrefix =
        layout === "direct"
          ? runtimePrefix.slice(1)
          : layout === "shell"
            ? [wrapper, envFile, ...runtimePrefix]
            : [envFile, ...runtimePrefix];
      const result = JSON.parse(
        runBuiltGatewayCall(
          checkout,
          "gateway.suspend.prepare",
          { requestId: "request-1" },
          {
            ...gatewayCliDeployment(root, checkout),
            invocationPrefix,
            executable:
              layout === "direct" ? process.execPath : layout === "shell" ? "/bin/sh" : wrapper,
            ...(layout === "direct"
              ? { envFilePath: null, wrapperPath: null }
              : { envFilePath: envFile, wrapperPath: wrapper }),
            port: 19001,
            serviceEnvironment: {
              OPENCLAW_GATEWAY_TOKEN: ["fixture", "value"].join("-"),
              OPENCLAW_GATEWAY_URL: "https://foreign.invalid",
            },
          },
        ),
      );

      expect(result).toMatchObject({
        execArgv: ["--max-old-space-size=128"],
        config: { gateway: { mode: "local", port: 19001 } },
        hasToken: true,
        url: null,
      });
      expect(result.argv).not.toContain("--port");
      expect(result.argv).not.toContain("--url");
    },
  );

  test.each<[string, string, (fixture: Omit<Fixture, "seed">) => void]>([
    [
      "a rewritten origin",
      "rewritten_origin",
      ({ mirror, origin }) =>
        git(
          mirror,
          "config",
          `url.${origin}.insteadOf`,
          "https://github.com/openclaw/openclaw.git",
        ),
    ],
    [
      "a foreign origin",
      "unexpected_origin",
      ({ mirror }) =>
        git(mirror, "remote", "set-url", "origin", "https://github.com/example/openclaw.git"),
    ],
    [
      "a symlinked Git directory",
      "not_standalone_clone",
      ({ root, mirror }) => {
        const target = path.join(root, "external-git-dir");
        renameSync(path.join(mirror, ".git"), target);
        symlinkSync(target, path.join(mirror, ".git"), "dir");
      },
    ],
    [
      "dirty work",
      "dirty_checkout",
      ({ mirror }) => writeFileSync(path.join(mirror, "local.txt"), "do not destroy\n"),
    ],
  ])("refuses %s before moving HEAD", (_name, code, prepare) => {
    const fixture = makeFixture();
    const before = git(fixture.mirror, "rev-parse", "HEAD");
    prepare(fixture);
    const result = runUpdater(["--checkout", fixture.mirror]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code } });
    expect(git(fixture.mirror, "rev-parse", "HEAD")).toBe(before);
    if (code === "dirty_checkout") {
      expect(git(fixture.mirror, "status", "--porcelain")).toContain("?? local.txt");
    }
  });

  test("accepts only immutable canonical runtime snapshots owned by the checkout", () => {
    const { root, mirror, origin } = makeFixture();
    const head = git(mirror, "rev-parse", "HEAD");
    const home = path.join(root, "home");
    const runtimeRoot = path.join(home, ".openclaw/runtime");
    const snapshot = path.join(runtimeRoot, `gateway-${head.slice(0, 7)}`);
    mkdirSync(runtimeRoot, { recursive: true });
    git(runtimeRoot, "clone", origin, snapshot);
    git(snapshot, "remote", "set-url", "origin", "https://github.com/openclaw/openclaw.git");
    git(snapshot, "checkout", "--detach", head);
    chmodSync(path.join(snapshot, ".git/HEAD"), 0o600);
    chmodSync(path.join(snapshot, ".git/config"), 0o600);
    writeBuild(snapshot);
    const entrypoint = path.join(snapshot, "dist/index.js");

    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(true);
    expect(isOwnedGatewayEntrypoint(mirror, home, path.join(mirror, "dist/index.js"))).toBe(true);

    chmodSync(entrypoint, 0o620);
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(false);
    chmodSync(entrypoint, 0o600);

    const fsmonitorMarker = installTrackedGitHook(root, snapshot, "core.fsmonitor");
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(true);
    expect(existsSync(fsmonitorMarker)).toBe(false);

    git(snapshot, "switch", "-c", "mutable");
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(false);
    git(snapshot, "checkout", "--detach", head);
    chmodSync(path.join(snapshot, ".git/HEAD"), 0o600);

    const filterMarker = installTrackedGitHook(root, snapshot, "filter.untrusted.clean", "cat\n");
    writeFixtureFile(path.join(snapshot, ".git/info/attributes"), "README.md filter=untrusted\n");
    writeFileSync(path.join(snapshot, "README.md"), "dirty\n");
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(true);
    expect(existsSync(filterMarker)).toBe(false);
    git(snapshot, "checkout", "--", "README.md");
    writeJson(path.join(snapshot, "dist", BUILD_STAMP_FILE), { head: "0".repeat(40) });
    const snapshotExecutionMarker = path.join(root, "snapshot-executed");
    writeFileSync(
      entrypoint,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(snapshotExecutionMarker)}, "ran");\n`,
    );
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(true);

    writeBuild(mirror);
    const sourceExecutionMarker = path.join(root, "source-executed");
    const sourceEntrypoint = path.join(mirror, "dist/index.js");
    writeFileSync(
      sourceEntrypoint,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sourceExecutionMarker)}, "ran"); console.log("{}");\n`,
    );
    const configPath = path.join(root, "openclaw.json");
    writeFileSync(configPath, "{}\n");
    expect(
      runBuiltGatewayCall(
        mirror,
        "gateway.suspend.prepare",
        { requestId: "request-1" },
        {
          ...gatewayCliDeployment(root, snapshot),
          port: 19001,
        },
      ),
    ).toContain("{}");
    expect(existsSync(sourceExecutionMarker)).toBe(true);
    expect(existsSync(snapshotExecutionMarker)).toBe(false);
  });

  test.skipIf(process.platform !== "darwin")(
    "inspects the generated wrapper before invoking the managed CLI",
    () => {
      const home = realpathSync(tempDirs.make("updater-generated-wrapper-"));
      const checkout = path.join(home, "checkout");
      const state = path.join(home, ".openclaw");
      const entrypoint = path.join(checkout, "dist/index.js");
      const wrapper = path.join(state, "service-env/ai.openclaw.gateway-env-wrapper.sh");
      const envFile = path.join(state, "service-env/ai.openclaw.gateway.env");
      const plist = path.join(home, "Library/LaunchAgents/ai.openclaw.gateway.plist");
      for (const file of [entrypoint, wrapper, plist]) {
        mkdirSync(path.dirname(file), { recursive: true });
      }
      writeFileSync(
        entrypoint,
        "console.log(JSON.stringify({execArgv: process.execArgv, port: process.env.OPENCLAW_GATEWAY_PORT}));\n",
      );
      writeFileSync(path.join(state, "openclaw.json"), "{}\n");
      writeFileSync(wrapper, buildLaunchAgentEnvironmentWrapper(), { mode: 0o700 });
      writeFileSync(
        envFile,
        "# Generated by OpenClaw. Do not edit while the gateway service is installed.\n",
        { mode: 0o600 },
      );
      writeManagedPlist(plist, state, [
        "/bin/sh",
        wrapper,
        envFile,
        process.execPath,
        "--max-old-space-size=128",
        entrypoint,
        "gateway",
        "--port",
        "18789",
      ]);
      vi.stubEnv("HOME", home);
      try {
        expect(JSON.parse(runBuiltGatewayCli(checkout, ["gateway", "status"], undefined))).toEqual({
          execArgv: ["--max-old-space-size=128"],
          port: "18789",
        });
        writeFileSync(wrapper, `${buildLaunchAgentEnvironmentWrapper()}# custom behavior\n`);
        expect(() => runBuiltGatewayCli(checkout, ["gateway", "status"], undefined)).toThrow(
          "LaunchAgent does not describe this checkout",
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  test.skipIf(process.platform !== "darwin").each([false, true])(
    "bounds updater interruption behind the serving Gateway fence (write custody=%s)",
    async (heldCustody) => {
      const fixture = makeFixture({ dependencies: true, built: true });
      const { root, mirror } = fixture;
      const home = path.join(root, "home");
      const stateDir = path.join(home, ".openclaw");
      const entrypoint = path.join(mirror, "dist/index.js");
      const plistPath = path.join(home, "Library/LaunchAgents/ai.openclaw.gateway.plist");
      const configPath = path.join(stateDir, "openclaw.json");
      const calls = path.join(root, "resident-calls.jsonl");
      const expiresAtMs = Date.now() + 45_000;
      mkdirSync(path.dirname(plistPath), { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(configPath, "{}\n");
      const programArguments = [
        process.execPath,
        "--max-old-space-size=128",
        entrypoint,
        "gateway",
        "--port",
        "18789",
      ];
      writeManagedPlist(plistPath, stateDir, programArguments);
      // Fixed replies from the old 5b29 serving Gateway's suspend protocol. The real
      // maintenance owner must decide whether these facts permit native stop.
      writeFileSync(
        entrypoint,
        `import fs from "node:fs";
const args = process.argv.slice(2);
const method = args[2];
const params = JSON.parse(args[args.indexOf("--params") + 1]);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({method,params}) + "\\n");
let result;
if (method === "status") result = {pid:42};
else if (method === "system.info") result = {pid:42,processInstanceId:"resident-instance"};
else if (method === "gateway.suspend.prepare") result = params.drain ? {
  status:"draining",suspensionId:"resident-lease",expiresAtMs:${expiresAtMs},
  retryAfterMs:30000,activeCount:1,blockers:[{kind:"agent-run",count:1,message:"resident turn"}],
  writeCustody:${JSON.stringify(heldCustody ? [{ phase: "session-write", count: 1 }] : [])}
} : ${JSON.stringify(busySuspension("agent-run", "resident turn"))};
else if (method === "gateway.suspend.handoff") result = {status:"committed",suspensionId:"resident-lease",expiresAtMs:${expiresAtMs}};
else if (method === "gateway.suspend.resume") result = {ok:true};
else throw new Error("Unexpected resident method: " + method);
console.log(JSON.stringify(result));
`,
      );
      // The resident build is stale, making this the actual retry/update path.
      writeJson(path.join(mirror, "dist/build-info.json"), { commit: "0".repeat(40) });
      maintenanceReadState.mockResolvedValue({
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        env: { HOME: home, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        command: { programArguments, sourcePath: plistPath },
        runtime: { status: "running", pid: 42 },
      });
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.mocked(spawnSync).mockImplementation((command, args, options) =>
        command === "/bin/launchctl"
          ? {
              status: 0,
              signal: null,
              pid: 1,
              output: [null, "pid = 42", ""],
              stdout: "pid = 42",
              stderr: "",
            }
          : actual.spawnSync(command, args, options),
      );
      const commands = fakeCommands(mirror);
      await Promise.all([
        import("../../src/cli/update-cli/update-command-service-drain.js"),
        import("../../src/daemon/service-state.js"),
        import("../../src/daemon/service.js"),
      ]);
      vi.stubEnv("HOME", home);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
      try {
        const running = fixture.run({
          inspectGatewayDeployment: undefined,
          prepareGatewaySuspension: undefined,
          runCommand: commands.runCommand,
          verifyAndAuditGateway: passGatewayRestartVerification,
        });
        const outcome = running.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await vi.runAllTimersAsync();
        const result = await outcome;
        const requests = readJsonLines(calls) as Array<{
          method: string;
          params: Record<string, unknown>;
        }>;
        if (heldCustody) {
          expect(result).toHaveProperty("error");
          expect("error" in result && result.error).toMatchObject({
            message: expect.stringContaining("data at risk in owner phase session-write (1)"),
          });
          expect(commands.calls).not.toContain(bootout);
          expect(commands.calls).not.toContain("pnpm build");
          expect(requests.some(({ method }) => method === "gateway.suspend.handoff")).toBe(false);
          expect(requests.at(-1)?.method).toBe("gateway.suspend.resume");
        } else {
          expect(result).toHaveProperty("value.ok", true);
          expect(commands.calls).toContain(bootout);
          expect(commands.calls.indexOf(bootout)).toBeLessThan(
            commands.calls.indexOf("pnpm build"),
          );
          expect(
            requests.find(({ method }) => method === "gateway.suspend.handoff")?.params,
          ).toEqual({
            suspensionId: "resident-lease",
            target: { pid: 42, processInstanceId: "resident-instance" },
            commit: true,
          });
        }
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.mocked(spawnSync).mockImplementation(actual.spawnSync);
        maintenanceReadState.mockReset();
      }
    },
  );

  test("accepts supported LaunchAgent layouts and rejects foreign commands", () => {
    const home = "/Users/test";
    const entrypoint = "/Users/test/.openclaw/runtime/gateway-1234567/dist/index.js";
    const wrapper = `${home}/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh`;
    const foreignWrapper = `${home}/.openclaw/service-env/foreign-wrapper.sh`;
    const envFile = `${home}/.openclaw/service-env/ai.openclaw.gateway.env`;
    const nodeCommand = ["/opt/homebrew/bin/node", entrypoint, "gateway", "--port", "18789"];

    const customState = "/Users/test/state";
    const customWrapper = `${customState}/service-env/ai.openclaw.gateway-env-wrapper.sh`;
    const customEnvFile = `${customState}/service-env/ai.openclaw.gateway.env`;
    const layouts: [string[], string | null][] = [
      [nodeCommand, entrypoint],
      [[nodeCommand[0]!, "--max-old-space-size=131072", ...nodeCommand.slice(1)], entrypoint],
      [
        [
          "/bin/sh",
          wrapper,
          envFile,
          nodeCommand[0]!,
          "--max-old-space-size",
          "131072",
          ...nodeCommand.slice(1),
        ],
        entrypoint,
      ],
      [["/opt/homebrew/bin/bun", entrypoint, "gateway"], entrypoint],
      [["/bin/sh", wrapper, envFile, ...nodeCommand], entrypoint],
      [[wrapper, envFile, ...nodeCommand], entrypoint],
      [["/bin/sh", customWrapper, customEnvFile, ...nodeCommand], entrypoint],
      [["/usr/bin/python3", entrypoint, "gateway"], null],
      [[nodeCommand[0]!, "--eval", "0", entrypoint, "gateway"], null],
      [[nodeCommand[0]!, "--unknown-option", "value", entrypoint, "gateway"], null],
      [["/bin/sh", foreignWrapper, envFile, ...nodeCommand], null],
    ];
    for (const [args, expected] of layouts) {
      expect(resolveManagedGatewayEntrypoint(args, home)).toBe(expected);
    }
  });

  test("replaces a wrapped LaunchAgent entrypoint without inserting another argument", () => {
    const snapshot = "/Users/test/.openclaw/runtime/gateway-1234567/dist/index.js";
    const source = "/Users/test/openclaw/dist/index.js";
    const original = [
      "/bin/sh",
      "/Users/test/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh",
      "/Users/test/.openclaw/service-env/ai.openclaw.gateway.env",
      "/opt/homebrew/bin/node",
      snapshot,
      "gateway",
      "--port",
      "18789",
    ];

    expect(replaceLaunchAgentProgramArgument(original, 4, snapshot, source)).toEqual([
      ...original.slice(0, 4),
      source,
      ...original.slice(5),
    ]);
    expect(original).toHaveLength(8);
    expect(original[4]).toBe(snapshot);
  });

  test("fails closed when Gateway service retargeting does not stick", () => {
    const checkout = "/Users/test/openclaw";
    const deployment = {
      configPath: "/Users/test/.openclaw/openclaw.json",
      entrypoint: "/Users/test/.openclaw/runtime/gateway-1234567/dist/index.js",
      label: "ai.openclaw.gateway",
      port: 18789,
    };
    expect(() =>
      repointManagedGatewayDeployment(
        checkout,
        { ...deployment },
        () => {},
        () => deployment,
      ),
    ).toThrow(/not retargeted/u);
  });

  test("rejects a local main ahead of origin before Gateway maintenance", async () => {
    const { mirror, run } = makeFixture();
    git(mirror, "config", "user.name", "Test");
    git(mirror, "config", "user.email", "test@example.com");
    git(mirror, "commit", "--allow-empty", "-m", "local commit");
    await expect(run()).rejects.toThrow(/does not equal origin\/main/u);
  });

  test("refuses to restart Gateway without exact build provenance", async () => {
    const { run } = makeFixture({ dependencies: true });
    const calls: string[] = [];
    await expect(
      run({
        runCommand: (command: string, args: string[]) => calls.push([command, ...args].join(" ")),
      }),
    ).rejects.toThrow(/build output does not match/u);
    expect(calls).toEqual([
      `${process.execPath} dist/index.js gateway stop`,
      "pnpm install --frozen-lockfile",
      "pnpm build",
    ]);
  });

  test("rejects missing or mismatched canonical build stamps", () => {
    const { mirror } = makeFixture({ built: true });
    const head = git(mirror, "rev-parse", "HEAD");
    const buildStamp = path.join(mirror, "dist", BUILD_STAMP_FILE);
    const runtimeStamp = path.join(mirror, "dist", RUNTIME_POSTBUILD_STAMP_FILE);
    expect(inspectBuildState(mirror, head).current).toBe(true);

    writeJson(buildStamp, { head: "0".repeat(40) });
    expect(inspectBuildState(mirror, head).current).toBe(false);

    writeJson(buildStamp, { head, inputsClean: true });
    rmSync(runtimeStamp);
    expect(inspectBuildState(mirror, head).current).toBe(false);
  });

  test("fast-forwards, builds exact SHA, restarts Gateway, then proves exact Mac target", async () => {
    const { mirror, seed, run } = makeFixture({
      includeSeed: true,
      dependencies: true,
      built: true,
    });
    writeFileSync(path.join(seed, "package.json"), '{"name":"openclaw"}\n');
    git(seed, "add", "package.json");
    // A long catch-up can exceed execFileSync's 1 MiB default with paths alone.
    const catchupPaths = Array.from(
      { length: 6000 },
      (_, index) => `docs/${"catchup-".repeat(27)}${index}.md`,
    );
    const emptyBlob = execFileSync("git", ["-C", seed, "hash-object", "-w", "--stdin"], {
      input: "",
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["-C", seed, "update-index", "--index-info"], {
      input: catchupPaths.map((file) => `100644 ${emptyBlob}\t${file}\n`).join(""),
    });
    const changedPath = "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift";
    pushFixtureChange(seed, changedPath);
    const commands = fakeCommands(mirror);

    const output = await run({
      runCommand: commands.runCommand,
      verifyMacTarget: () => ({
        executable: path.join(mirror, "dist/OpenClaw.app/Contents/MacOS/OpenClaw"),
        pid: 123,
      }),
    });

    expect(output).toMatchObject({
      updated: true,
      afterSha: git(seed, "rev-parse", "HEAD"),
      actions: { macAppRebuild: true, macUiVerification: true },
    });
    expect(output.buildChangedPaths).toEqual([
      changedPath,
      ...catchupPaths.toSorted(),
      "package.json",
    ]);
    expect(commands.calls).toEqual([
      `${process.execPath} dist/index.js gateway stop`,
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm openclaw gateway restart",
      ...gatewayChecks,
      rebuildMac,
      ...gatewayChecks,
    ]);
  });

  test("emits one machine-readable timeout result with phase details", async () => {
    const { mirror } = makeFixture();
    const held = acquireMaintenanceLock(mirror);
    const lockPath = held.lockPath;
    held.release?.();
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runLiveUpdaterMain(["--checkout", mirror], {
        inspectGatewayDeployment: () => null,
        runManagedCommand: async () => {
          throw managedTimeoutError();
        },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      log.mockRestore();
    }

    expect(existsSync(lockPath)).toBe(false);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      ...failureEnvelope(
        "command_timeout",
        invariantDiagnostic("command_timeout", {
          phase: "Git fetch",
          serviceState: "running",
          timeoutMs: 5 * 60_000,
        }),
      ),
    });
  });

  test("recovers the previous service after a post-stop install timeout", async () => {
    const { run, deployment, lockPath, plistPath } = makeManagedFixture({ built: true });
    const events: string[] = [];

    await expect(
      run({
        inspectGatewayDeployment: () => deployment,
        runManagedCommand: async ({ args, requireProcessTreeExit, timeoutMs }: FixtureCommand) => {
          const command = args.join(" ");
          events.push(`${command} timeout=${timeoutMs} strict=${requireProcessTreeExit}`);
          if (command === "install --frozen-lockfile") {
            await Promise.resolve();
            events.push("install process tree drained");
            throw managedTimeoutError();
          }
          return 0;
        },
        proveGatewayStopped: () => {
          events.push("prove stopped");
          return stoppedGateway();
        },
        waitForGatewayProcess: () => {
          events.push("previous process started");
        },
      }),
    ).rejects.toMatchObject({
      code: "command_timeout",
      details: { phase: "dependency install", serviceState: "stopped", timeoutMs: 15 * 60_000 },
    });

    const timeoutIndex = events.indexOf("install process tree drained");
    const recoveryIndex = events.findIndex((event) => event.startsWith("enable gui/"));
    expect(timeoutIndex).toBeGreaterThan(-1);
    expect(recoveryIndex).toBeGreaterThan(timeoutIndex);
    expect(events.filter((event) => event === "prove stopped")).toHaveLength(2);
    expect(events).toContain(
      `bootstrap gui/${process.getuid?.() ?? 501} ${plistPath} timeout=60000 strict=true`,
    );
    expect(events).toContain("previous process started");
    expect(existsSync(lockPath)).toBe(false);
  });

  posixTest(
    "retains the maintenance lock and skips recovery when a timed-out process group stays live",
    async () => {
      const { mirror, run, deployment, lockPath } = makeManagedFixture({ built: true });
      const blocker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        detached: true,
        stdio: "ignore",
      });
      if (!blocker.pid) {
        throw new Error("cleanup blocker did not expose a process group id");
      }
      const processGroupId = blocker.pid;
      const blockerClosed = new Promise<void>((resolve) => {
        blocker.once("close", () => resolve());
      });
      const events: string[] = [];

      try {
        await expect(
          run({
            inspectGatewayDeployment: () => deployment,
            runManagedCommand: async ({ args }: FixtureCommand) => {
              const command = args.join(" ");
              events.push(command);
              if (command === "install --frozen-lockfile") {
                throw processCleanupFailure(processGroupId, "process group remained live");
              }
              return 0;
            },
            waitForGatewayProcess: () => {
              events.push("previous process started");
            },
          }),
        ).rejects.toMatchObject({
          code: "command_cleanup_failed",
          details: {
            lockPath,
            lockRetained: true,
            phase: "dependency install",
            processGroupId,
            processTreeState: "live",
            serviceState: "stopped",
          },
        });

        expect(events.some((event) => event.startsWith("enable gui/"))).toBe(false);
        expect(events).not.toContain("previous process started");
        expect(existsSync(lockPath)).toBe(true);
        await expect(run()).resolves.toMatchObject({ ok: true, skipped: true, reason: "overlap" });
        expect(acquireMaintenanceLock(mirror, lockPath)).toMatchObject({
          acquired: false,
          owner: { processGroupId, reason: "command_cleanup_failed", serviceState: "stopped" },
        });
      } finally {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {}
        await blockerClosed;
      }

      const ownerPath = path.join(lockPath, "owner.json");
      const retainedOwner = JSON.parse(readFileSync(ownerPath, "utf8"));
      writeFileSync(ownerPath, `${JSON.stringify({ ...retainedOwner, pid: processGroupId })}\n`, {
        mode: 0o600,
      });
      const reacquired = acquireMaintenanceLock(mirror, lockPath);
      try {
        expect(reacquired.acquired).toBe(true);
      } finally {
        reacquired.release?.();
      }
    },
  );

  test("resumes a prepared suspension when stopped proof never converges", async () => {
    const { mirror, run } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const resumed: string[] = [];
    let proofAttempts = 0;

    await expect(
      run({
        proveGatewayStopped: () => {
          proofAttempts += 1;
          throw new Error("listener still present");
        },
        sleep() {},
        resumeGatewaySuspension: (_checkout: string, suspensionId: string) => {
          resumed.push(suspensionId);
        },
      }),
    ).rejects.toThrow("native stopped proof did not converge");
    expect(proofAttempts).toBe(141);
    expect(resumed).toEqual(["fixture-suspension"]);
  });

  test("allows launchd teardown to converge after the old ten-second proof window", async () => {
    const { mirror, run } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);
    let elapsedMs = 0;
    let proofAttempts = 0;

    const output = await run({
      runCommand: commands.runCommand,
      proveGatewayStopped: () => {
        proofAttempts += 1;
        if (elapsedMs < 12_000) {
          throw new Error("launchd is still releasing the stopped job");
        }
        return stoppedGateway();
      },
      sleep: (ms: number) => {
        elapsedMs += ms;
      },
      resumeGatewaySuspension: () => {},
    });

    expect(output.ok).toBe(true);
    expect(elapsedMs).toBe(12_000);
    expect(proofAttempts).toBe(49);
  });

  test("refuses Gateway mutations when suspension and stopped proof both fail", async () => {
    const { mirror, run } = makeFixture({ dependencies: true });
    const commands = fakeCommands(mirror);
    const prepareFailure = new Error("Gateway unavailable");
    const proofFailure = new Error("listener still present");
    await expect(
      run({
        runCommand: commands.runCommand,
        prepareGatewaySuspension: () => {
          throw prepareFailure;
        },
        proveGatewayStopped: () => {
          throw proofFailure;
        },
      }),
    ).rejects.toMatchObject({ errors: [prepareFailure, proofFailure], cause: proofFailure });
    expect(commands.calls).toEqual([]);
  });

  test("restores the signed Mac bundle and redacts the build failure", async () => {
    const { mirror, run } = makeFixture({ dependencies: true });
    const { marker } = signedMacBundle(mirror);
    const failure = await run({
      runCommand(command: string, args: string[]) {
        if (command === "pnpm" && args[0] === "build") {
          throw privateCommandFailure("build", 17);
        }
      },
    }).catch((error: unknown) => error);
    expect(readFileSync(marker, "utf8")).toBe("signed\n");
    const formatted = formatUpdateFailure(failure);
    expect(formatted.error.message).toBe("build failed");
    expect(formatted.error.diagnostics).toEqual(commandDiagnostic("build", 17));
    expect(JSON.stringify(formatted)).not.toContain("secret build");
  });

  test("preserves a build failure after a delayed external restore of the exact Mac bundle", async () => {
    const { root, mirror, run } = makeFixture({ dependencies: true });
    const { bundle: appBundle, marker: appMarker } = signedMacBundle(mirror);
    const commands = fakeCommands(mirror);
    const delayedBundle = path.join(root, "delayed-openclaw.app");
    let restored = false;

    await expect(
      run({
        runCommand(command: string, args: string[]) {
          if (command === "pnpm" && args[0] === "build") {
            expect(existsSync(appBundle)).toBe(false);
          }
          commands.runCommand(command, args);
          if (command === "pnpm" && args[0] === "build") {
            const [preserved] = preservedMacBundles(mirror);
            expect(preserved).toBeDefined();
            renameSync(path.join(mirror, ".git", preserved!), delayedBundle);
            throw new Error("build failed after external restore");
          }
        },
        sleep() {
          if (restored) {
            return;
          }
          renameSync(delayedBundle, appBundle);
          restored = true;
        },
      }),
    ).rejects.toThrow("build failed after external restore");

    expect(restored).toBe(true);
    expect(readFileSync(appMarker, "utf8")).toBe("signed\n");
    expect(preservedMacBundles(mirror)).toEqual([]);
  });

  test("repoints an ancestor snapshot across the next source update", async () => {
    const fixture = createSnapshotFixture({ advance: true });
    const { commands, source, snapshot } = fixture;
    const inspectGatewayDeployment = () => ({
      ...fixture.inspect(),
      serviceEnvironment: { PRIVATE_MARKER: "not-serialized" },
    });
    const deferred = await fixture.run({
      inspectGatewayDeployment,
      prepareGatewaySuspension: () => ({
        ...busySuspension("agent-run", "busy"),
        controlledDrainSupported: false,
      }),
    });
    expect(deferred).toMatchObject({ deferred: true, reason: "gateway_active_work" });
    expect(commands.calls).toEqual([]);

    const resumed: string[] = [];
    await expect(
      fixture.run({
        inspectGatewayDeployment,
        prepareGatewaySuspension: () => preparedSuspension("failed-preparation"),
        prepareGatewayEntrypointReplacement: rejectWith("replacement plist lint failed"),
        resumeGatewaySuspension: (_checkout: string, id: string) => {
          resumed.push(id);
        },
      }),
    ).rejects.toThrow("replacement plist lint failed");
    expect(resumed).toEqual(["failed-preparation"]);
    expect(commands.calls).toEqual([]);

    let controlEntrypoint: string | undefined;
    const output = await fixture.run({
      inspectGatewayDeployment,
      prepareGatewaySuspension: (_checkout: string, deployment: { entrypoint: string }) => {
        controlEntrypoint = deployment.entrypoint;
        return preparedSuspension();
      },
      prepareGatewayEntrypointReplacement: () => fixture.prepareReplacement(),
      verifyAndAuditGateway: passGatewayRestartVerification,
      proveGatewayStopped: () => fixture.stopped(),
    });
    expectRetargeted(output.gatewayDeployment, source, snapshot);
    expect(JSON.stringify(output)).not.toContain("not-serialized");
    expect(controlEntrypoint).toBe(source);
  });

  test("reports primary invariant and rollback command diagnostics", async () => {
    const { run, deployment } = makeManagedFixture({ dependencies: true });
    const failure = await run({
      inspectGatewayDeployment: () => deployment,
      runCommand(command: string, args: string[]) {
        if (command === "pnpm" && args[0] === "build") {
          resolveLaunchAgentExitTimeoutSeconds(0);
        }
        if (command === "/bin/launchctl" && args[0] === "bootstrap") {
          throw privateCommandFailure("rollback command", 23);
        }
      },
      waitForGatewayProcess: rejectWith("managed process was not observed"),
    }).catch((error: unknown) => error);

    const formatted = formatUpdateFailure(failure);
    expect(formatted.error.diagnostics).toEqual({
      kind: "aggregate",
      causeMember: 1,
      members: [
        {
          role: "primary",
          error: invariantDiagnostic("gateway_launchagent_failed", { exitTimeoutSeconds: 0 }),
        },
        { role: "rollback", error: commandDiagnostic("launchd.bootstrap", 23) },
      ],
    });
    expect(JSON.stringify(formatted)).not.toContain("secret rollback");
  });

  test("restores an absent managed service past bootout exit 3 and an unlabeled vendor plist", async () => {
    const fixture = createSnapshotFixture({ advance: true });
    const { commands, snapshot, plistPath } = fixture;
    let bootouts = 0;
    let serviceLoaded = true;
    const systemPlist = writeSystemLaunchDaemonFixture("valid plist without a Label");

    await expect(
      fixture.run({
        runCommand(command: string, args: string[]) {
          commands.runCommand(command, args);
          if (command === "/bin/launchctl" && args[0] === "bootout") {
            serviceLoaded = false;
            if (++bootouts === 2) {
              throw new Error("Boot-out failed: 3: No such process");
            }
          }
          if (command === "/bin/launchctl" && args[0] === "bootstrap") {
            serviceLoaded = true;
          }
        },
        assertNoSystemLaunchDaemonOwnership: () => {
          commands.calls.push("assert system ownership");
          assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
            readdirSync: () => [systemPlist],
            spawnSync: (command: string, args: string[]) =>
              command === "/bin/launchctl"
                ? { status: 113, stdout: "", stderr: "Could not find service" }
                : { status: args[0] === "-lint" ? 0 : 1, stdout: "", stderr: "" },
          });
        },
        prepareGatewayEntrypointReplacement: () => fixture.prepareReplacement(),
        proveGatewayStopped: () => fixture.stopped(),
        isGatewayLoaded: () => serviceLoaded,
        verifyAndAuditGateway: () => {
          commands.calls.push("verify replacement readiness");
          throw new Error("replacement readiness failed");
        },
      }),
    ).rejects.toThrow("replacement readiness failed");

    expect(serviceLoaded).toBe(true);
    expect(fixture.inspect().entrypoint).toBe(snapshot);
    expect(commands.calls).toEqual([
      "assert system ownership",
      "prepare replacement plist",
      bootout,
      "prove gateway stopped",
      "pnpm build",
      "assert system ownership",
      "install replacement plist",
      "assert system ownership",
      traceOn,
      ...launchAgentStart(plistPath),
      traceOff,
      "verify replacement readiness",
      bootout,
      "prove gateway stopped",
      "restore previous plist",
      "assert system ownership",
      ...launchAgentStart(plistPath),
    ]);
  });

  test("resumes suspension when system ownership appears before bootout", async () => {
    const fixture = createSnapshotFixture({ advance: true });
    const resumed: string[] = [];
    await expect(
      maintainFixture(fixture.options, {
        assertNoSystemLaunchDaemonOwnership: rejectWith("same-label system owner"),
        inspectGatewayDeployment: fixture.inspect,
        prepareGatewayEntrypointReplacement: rejectWith("replacement preparation must not run"),
        resumeGatewaySuspension: (_checkout: string, id: string) => {
          resumed.push(id);
        },
      }),
    ).rejects.toThrow("same-label system owner");
    expect(resumed).toEqual(["fixture-suspension"]);
  });

  test.each([true, false])(
    "rebuilds the source control client with a running snapshot: %s",
    async (running) => {
      const fixture = createSnapshotFixture({ current: false });
      const { commands, source, snapshot, plistPath } = fixture;
      let controlEntrypoint = "";
      let proofAttempts = 0;
      const output = await fixture.run({
        prepareGatewaySuspension: (_checkout: string, deployment: { entrypoint: string }) => {
          controlEntrypoint = deployment.entrypoint;
          if (!running) {
            throw new Error("must not execute an unavailable control build");
          }
          return preparedSuspension();
        },
        verifyAndAuditGateway: passGatewayRestartVerification,
        proveGatewayStopped: () => {
          if (running) {
            commands.calls.push("prove gateway stopped");
          }
          if (running && ++proofAttempts <= 2) {
            throw new Error("snapshot still owns its listener");
          }
          return stoppedGateway();
        },
        sleep: (ms: number) => {
          commands.calls.push(`sleep ${ms}`);
        },
      });
      expect(controlEntrypoint).toBe(running ? source : "");
      if (running) {
        expect(proofAttempts).toBe(3);
      }
      expectRetargeted(output.gatewayDeployment, source, snapshot);
      expect(commands.calls).toEqual([
        ...(running ? ["prove gateway stopped"] : []),
        "pnpm install --frozen-lockfile",
        "pnpm build",
        ...(running
          ? [bootout, "prove gateway stopped", "sleep 250", "prove gateway stopped"]
          : []),
        traceOn,
        ...launchAgentStart(plistPath),
        traceOff,
      ]);
    },
  );

  test("accepts an observed LaunchAgent process after bootstrap reports failure", async () => {
    const { mirror, run, deployment, plistPath } = makeManagedFixture({
      dependencies: true,
      built: true,
    });
    const source = path.join(mirror, "dist/index.js");
    const calls: string[] = [];
    let processObserved = false;

    await run({
      runCommand(command: string, args: string[]) {
        const call = [command, ...args].join(" ");
        calls.push(call);
        if (command === "/bin/launchctl" && args[0] === "bootstrap") {
          throw Object.assign(new Error("Bootstrap failed: 5: Input/output error"), { status: 5 });
        }
      },
      armEnvironmentRestore: () => {
        calls.push("arm environment restore");
        return {
          disarm() {
            calls.push("disarm environment restore");
          },
        };
      },
      readLaunchdEnvironment: () => "already-enabled",
      inspectGatewayDeployment: () => deployment,
      isGatewayLoaded: () => false,
      verifyGateway: rejectWith("managed job is unloaded"),
      verifyAndAuditGateway: emptyAudit,
      verifyGatewayRuntime: () => ({ entrypoint: source, pid: 123, port: 18789 }),
      waitForGatewayProcess: () => {
        processObserved = true;
      },
    });

    expect(processObserved).toBe(true);
    expect(calls).toEqual([
      "arm environment restore",
      traceOn,
      ...launchAgentStart(plistPath),
      "/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE already-enabled",
      "disarm environment restore",
    ]);
  });

  test("rejects unsafe bootstrap command cleanup before process observation", async () => {
    const { run, deployment } = makeManagedFixture({ dependencies: true, built: true });
    let processObserved = false;

    const failure = await run({
      inspectGatewayDeployment: () => deployment,
      isGatewayLoaded: () => false,
      runManagedCommand: ({ args, bin }: FixtureCommand) => {
        if (bin === "/bin/launchctl" && args[0] === "bootstrap") {
          throw processCleanupFailure(4321, "launchctl cleanup remained live");
        }
        return 0;
      },
      verifyGateway: rejectWith("managed job is unloaded"),
      waitForGatewayProcess: () => {
        processObserved = true;
      },
    }).catch((error: unknown) => error);

    expect(processObserved).toBe(false);
    expect(formatUpdateFailure(failure)).toMatchObject(
      failureEnvelope(
        "command_cleanup_failed",
        invariantDiagnostic("command_cleanup_failed", {
          processTreeState: "live",
          serviceState: "stopped",
        }),
      ),
    );
  });

  test("audits restart-window logs even when deep Gateway verification fails", async () => {
    const { root, mirror } = makeFixture({ dependencies: true, built: true });
    let auditCalls = 0;
    let statusCalls = 0;

    await expect(
      maintainMain(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          fetchMain: fetchFixtureMain,
          runCommand(command: string, args: string[]) {
            if (command === "pnpm" && args.slice(0, 3).join(" ") === "openclaw gateway status") {
              statusCalls += 1;
              throw new Error("RPC unavailable");
            }
          },
          auditGatewayLogs() {
            auditCalls += 1;
            return { entries: 1, errorCount: 0, warningCount: 0, errors: [], warnings: [] };
          },
          inspectGatewayDeployment: () => null,
          sleep() {},
          verifyGatewayRuntime: () => null,
        },
      ),
    ).rejects.toThrow("RPC unavailable");
    expect(statusCalls).toBe(8);
    expect(auditCalls).toBe(1);
  });

  test.each(["Gateway maintenance", "exact-bundle verification"])(
    "retries pending Mac work after failed %s on the next unchanged heartbeat",
    async (failureStage) => {
      const {
        root,
        mirror,
        seed,
        options: fixtureOptions,
      } = makeFixture({ includeSeed: true, dependencies: true });
      pushFixtureChange(seed, "apps/macos/Sources/OpenClaw/App.swift");
      const statePath = path.join(root, "maintenance-state.json");
      const options = { ...fixtureOptions, statePath };
      const commands = fakeCommands(mirror);
      const failure = `${failureStage} failed`;
      const failsBeforeMac = failureStage === "Gateway maintenance";

      await expect(
        maintainFixture(options, {
          sleep() {},
          runCommand(command: string, args: string[]) {
            commands.runCommand(command, args);
            if (
              failsBeforeMac &&
              command === "pnpm" &&
              args.slice(0, 3).join(" ") === "openclaw gateway status"
            ) {
              throw new Error(failure);
            }
          },
          verifyMacTarget: rejectWith(failure),
        }),
      ).rejects.toThrow(failure);
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
        macPending: true,
        attempts: failsBeforeMac ? 0 : 1,
        ...(failsBeforeMac ? {} : { lastFailure: failure }),
      });

      const retryCommands = fakeCommands(mirror);
      const verifyMacTarget = vi.fn(() => ({ executable: "exact", pid: 456 }));
      const retry = await maintainFixture(options, {
        runCommand: retryCommands.runCommand,
        verifyMacTarget,
      });
      expect(retry).toMatchObject({
        updated: false,
        actions: { gatewayBuild: false, macAppRebuild: true },
      });
      expect(retryCommands.calls.slice(0, 3)).toEqual([...gatewayChecks, rebuildMac]);
      expect(verifyMacTarget).toHaveBeenCalledOnce();
      expect(existsSync(statePath)).toBe(false);
    },
  );

  test("refuses a symlinked maintenance state file without touching its target", async () => {
    const { root, options } = makeFixture();
    const statePath = path.join(root, "maintenance-state.json");
    const victimPath = path.join(root, "victim.txt");
    writeFileSync(victimPath, '{"untouched":true}\n');
    symlinkSync(victimPath, statePath);

    await expect(maintainFixture({ ...options, statePath })).rejects.toThrow(
      /maintenance state is unreadable/u,
    );
    expect(readFileSync(victimPath, "utf8")).toBe('{"untouched":true}\n');
  });

  test("rechecks an incomplete owner file before claiming the maintenance lock", () => {
    const { root, mirror } = makeFixture();
    const lockPath = path.join(root, "maintenance.lock");
    const ownerPath = path.join(lockPath, "owner.json");
    mkdirSync(lockPath);
    writeFileSync(ownerPath, "");
    const owner = { pid: process.pid, checkout: mirror, startedAt: "racing" };
    // Publish on the retry boundary instead of racing process startup.
    const wait = vi.spyOn(Atomics, "wait").mockImplementationOnce(() => {
      writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
      return "timed-out";
    });
    try {
      expect(acquireMaintenanceLock(mirror, lockPath)).toMatchObject({ acquired: false, owner });
    } finally {
      wait.mockRestore();
    }
  });

  linuxTest("refuses Linux systemd hosts before moving HEAD", () => {
    const { root, mirror, origin, seed } = makeFixture({ includeSeed: true });
    pushFixtureChange(seed, "linux-preflight.txt");
    const before = git(mirror, "rev-parse", "HEAD");
    const beforeTracking = git(mirror, "rev-parse", "refs/remotes/origin/main");
    const binDir = writeFixtureGitBin(root, origin);

    const result = runUpdater([], {
      cwd: mirror,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
    expect(result.status).toBe(1);
    expect(git(mirror, "rev-parse", "HEAD")).toBe(before);
    expect(git(mirror, "rev-parse", "refs/remotes/origin/main")).toBe(beforeTracking);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: {
        code: "unsupported_gateway_control_platform",
        diagnostics: invariantDiagnostic("unsupported_gateway_control_platform"),
      },
    });
  });
});
