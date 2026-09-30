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
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import { writeUpdateCompatibilityChunks } from "../../scripts/lib/update-compat-chunks.mts";
import { listCoreRuntimePostBuildOutputs } from "../../scripts/runtime-postbuild.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

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
let lastFixtureRoot = "";
let fixtureTemplate: ReturnType<typeof initializeFixture> | undefined;
const posixTest = process.platform === "win32" ? test.skip : test;
const linuxTest = process.platform === "linux" ? test : test.skip;

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

async function runFixtureManagedCommand({
  args,
  bin,
  cwd,
  env,
}: {
  args: string[];
  bin: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}) {
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
    prepareGatewaySuspension: () => ({
      status: "ready",
      suspensionId: "fixture-suspension",
    }),
    prepareGatewayEntrypointReplacement: () => ({
      install() {},
      discard() {},
    }),
    probeGatewayMilestones: () => ({
      listenerReady: true,
      healthzReady: true,
      readyzReady: true,
    }),
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

type Fixture = ReturnType<typeof initializeFixture> & {
  run: (dependencies?: Record<string, unknown>) => ReturnType<typeof maintainFixture>;
};

function makeFixture(): Omit<Fixture, "seed">;
function makeFixture(options: { includeSeed: true }): Fixture;
function makeFixture(options?: { includeSeed?: boolean }) {
  if (!fixtureTemplate) {
    throw new Error("fixture template is not initialized");
  }
  const root = realpathSync(tempDirs.make("openclaw-live-updater-"));
  lastFixtureRoot = root;
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
  fixtureOrigins.set(realpathSync(mirror), origin);
  const fixture = {
    root,
    mirror,
    origin,
    run(dependencies: Record<string, unknown> = {}) {
      return maintainFixture(
        {
          checkout: mirror,
          remote: "origin",
          lockPath: path.join(root, "maintenance.lock"),
        },
        dependencies,
      );
    },
  };
  return options?.includeSeed ? { ...fixture, seed } : fixture;
}

function writeBuild(mirror: string) {
  mkdirSync(path.join(mirror, "dist/control-ui"), { recursive: true });
  const head = git(mirror, "rev-parse", "HEAD");
  const gatewayEntrypoint = path.join(mirror, "dist/index.js");
  writeFileSync(gatewayEntrypoint, "// built\n");
  // Snapshot ownership rejects group-writable executables, so fixtures must
  // not inherit a permissive CI umask and accidentally model an unsafe build.
  chmodSync(gatewayEntrypoint, 0o600);
  writeFileSync(path.join(mirror, "dist/entry.js"), "// built\n");
  mkdirSync(path.join(mirror, "dist/control-ui/assets"), { recursive: true });
  writeFileSync(
    path.join(mirror, "dist/control-ui/index.html"),
    '<script type="module" src="./assets/app.js"></script>\n',
  );
  writeFileSync(path.join(mirror, "dist/control-ui/assets/app.js"), "// ui\n");
  for (const stamp of [BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE]) {
    writeFileSync(
      path.join(mirror, "dist", stamp),
      `${JSON.stringify({ head, inputsClean: true })}\n`,
    );
  }
  writeUpdateCompatibilityBuildFixture(mirror);
  writeUpdateCompatibilityChunks({
    distDir: path.join(mirror, "dist"),
    sourceDir: mirror,
    inventory: previousReleaseInventory,
  });
  for (const relativePath of listCoreRuntimePostBuildOutputs({ rootDir: mirror })) {
    const outputPath = path.join(mirror, relativePath);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    if (!existsSync(outputPath)) {
      writeFileSync(outputPath, "// runtime postbuild\n");
    }
  }
  writeFileSync(path.join(mirror, "dist/build-info.json"), `${JSON.stringify({ commit: head })}\n`);
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
  return {
    audit: emptyAudit(),
    timing,
  };
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

function pushFixtureChange(seed: string, file = "docs/index.md") {
  mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
  writeFileSync(path.join(seed, file), "// changed\n");
  git(seed, "add", file);
  git(seed, "commit", "-m", "fixture update");
  git(seed, "push");
}

function createSnapshotFixture({ current = true, advance = false } = {}) {
  const fixture = makeFixture({ includeSeed: true });
  const { root, mirror, seed } = fixture;
  mkdirSync(path.join(mirror, "node_modules"));
  if (current) {
    writeBuild(mirror);
  }
  if (advance) {
    pushFixtureChange(seed);
  }
  const managed = createManagedLaunchAgentFixture(root, mirror);
  const source = managed.deployment.entrypoint;
  const snapshot = path.join(root, "gateway-ancestor/dist/index.js");
  const commands = fakeCommands(mirror);
  let entrypoint = snapshot;
  const inspect = () => ({ ...managed.deployment, entrypoint, invocationPrefix: [entrypoint] });
  const replacement = {
    install() {
      entrypoint = source;
    },
    restore() {
      entrypoint = snapshot;
    },
    discard() {},
  };
  const options = { checkout: mirror, remote: "origin", lockPath: managed.lockPath };
  return {
    ...fixture,
    ...managed,
    source,
    snapshot,
    commands,
    inspect,
    replacement,
    options,
    run: (dependencies: Record<string, unknown>) =>
      maintainFixture(options, {
        runCommand: commands.runCommand,
        inspectGatewayDeployment: inspect,
        prepareGatewayEntrypointReplacement: () => replacement,
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
  mkdirSync(path.dirname(entrypoint), { recursive: true });
  writeFileSync(entrypoint, "// built\n");
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
  process.stdout.write(JSON.stringify({
    status: "busy",
    reason: "active-work",
    retryAfterMs: 20_000,
    activeCount: 1,
    blockers: [{ kind: "terminal-session", count: 1, message: "1 open terminal session" }],
  }) + "\\n");
}
`,
  );
  return {
    callsPath,
    checkout,
    deployment: { ...gatewayCliDeployment(root, checkout), invocationPrefix: [capturePath] },
  };
}

describe("openclaw live updater", () => {
  beforeAll(() => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-live-updater-template-")));
    fixtureTemplate = initializeFixture(root);
  });

  afterEach(() => {
    fixtureOrigins.clear();
  });

  afterAll(() => {
    expect(existsSync(lastFixtureRoot)).toBe(false);
    if (fixtureTemplate) {
      rmSync(fixtureTemplate.root, { recursive: true, force: true });
      fixtureTemplate = undefined;
    }
  });

  test.each(["EPERM", "EIO"])(
    "uses actual plist read errno %s, then rechecks ownership",
    (code) => {
      let probes = 0;
      vi.mocked(openSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("read failed"), { code });
      });
      const check = () =>
        assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
          readdirSync: () => ["com.vendor.plist"],
          spawnSync: (command: string) =>
            command === "/bin/launchctl"
              ? (++probes, { status: 113, stderr: "Could not find service" })
              : { status: 1, stderr: "Operation not permitted" },
        });
      if (code === "EIO") {
        expect(check).toThrow("could not read system LaunchDaemon plist");
        expect(probes).toBe(1);
      } else {
        expect(check).not.toThrow();
        expect(probes).toBe(2);
      }
    },
  );

  test("rejects a loaded owner appearing after an unreadable plist was skipped", () => {
    let probes = 0;
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect(() =>
      assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
        readdirSync: () => ["com.vendor.plist"],
        spawnSync: (command: string) =>
          command === "/bin/launchctl"
            ? { status: ++probes === 1 ? 113 : 0, stderr: "Could not find service" }
            : { status: 1 },
      }),
    ).toThrow("system/ai.openclaw.gateway already owns");
    expect(probes).toBe(2);
  });

  test.each([{ status: 113, error: Object.assign(new Error("query failed"), { code: "EIO" }) }])(
    "rejects incomplete ownership queries: %j",
    (result) => {
      expect(() =>
        assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
          readdirSync: () => [],
          spawnSync: () => ({ ...result, stderr: "Could not find service" }),
        }),
      ).toThrow("could not verify system LaunchDaemon ownership");
    },
  );

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

  test("routes managed Gateway health through the injected port", async () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
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

    await verifyGatewayReadiness(
      () => {
        throw new Error("managed probes must use the exact built Gateway CLI");
      },
      mirror,
      git(mirror, "rev-parse", "HEAD"),
      () => {},
      gatewayCliDeployment(root, mirror),
    );

    expect(
      readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        args: ["gateway", "status", "--deep", "--require-rpc", "--json"],
        port: "18789",
      },
      { args: ["health", "--verbose", "--json"], port: "18789" },
    ]);
  });

  test("bounds built Gateway CLI probes and cleans their config overlay", () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
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

  test("retries exact legacy suspension params with preserve semantics", () => {
    const root = realpathSync(tempDirs.make("openclaw-legacy-gateway-suspension-"));
    const stub = createGatewaySuspensionCliStub(root, {
      type: "gateway_request_error",
      code: "INVALID_REQUEST",
      message: "invalid gateway.suspend.prepare params",
      retryable: false,
    });

    expect(
      prepareGatewaySuspension(stub.checkout, runBuiltGatewayCall, stub.deployment),
    ).toMatchObject({
      status: "busy",
      activeCount: 1,
      blockers: [{ kind: "terminal-session", count: 1 }],
    });
    const calls = readFileSync(stub.callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { requestId: string; terminalPolicy?: string });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      requestId: expect.stringMatching(/^openclaw-live-updater-/u),
      terminalPolicy: "terminate",
    });
    expect(calls[1]).toEqual({ requestId: calls[0]?.requestId });
  });

  test("does not downgrade unrelated Gateway suspension failures", () => {
    const root = realpathSync(tempDirs.make("openclaw-gateway-suspension-failure-"));
    const stub = createGatewaySuspensionCliStub(root, {
      type: "gateway_request_error",
      code: "UNAVAILABLE",
      message: "gateway scheduler recovery is pending",
      retryable: true,
    });
    let failure: unknown;

    try {
      prepareGatewaySuspension(stub.checkout, runBuiltGatewayCall, stub.deployment);
    } catch (error) {
      failure = error;
    }

    expect(formatUpdateFailure(failure)).toMatchObject({
      error: {
        code: "gateway_suspend_prepare_failed",
        diagnostics: {
          kind: "invariant",
          cause: {
            kind: "command",
            operation: "gateway.suspend.prepare",
            status: 1,
          },
        },
      },
    });
    expect(readFileSync(stub.callsPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("pins managed Gateway calls with a backward-compatible local overlay", () => {
    const root = realpathSync(tempDirs.make("openclaw-gateway-call-"));
    const checkout = path.join(root, "checkout");
    const entrypoint = path.join(checkout, "dist/index.js");
    const capture = path.join(root, "capture.mjs");
    const configPath = path.join(root, "openclaw.json");
    mkdirSync(path.dirname(entrypoint), { recursive: true });
    writeFileSync(configPath, "{}\n");
    writeFileSync(
      capture,
      'import fs from "node:fs"; console.log(JSON.stringify({ argv: process.argv.slice(2), config: JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")), hasToken: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN), url: process.env.OPENCLAW_GATEWAY_URL ?? null }));\n',
    );

    const result = JSON.parse(
      runBuiltGatewayCall(
        checkout,
        "gateway.suspend.prepare",
        { requestId: "request-1" },
        {
          ...gatewayCliDeployment(root, checkout),
          invocationPrefix: [capture],
          port: 19001,
          serviceEnvironment: {
            OPENCLAW_GATEWAY_TOKEN: ["fixture", "value"].join("-"),
            OPENCLAW_GATEWAY_URL: "https://foreign.invalid",
          },
          wrapperPath: null,
        },
      ),
    );

    expect(result.config).toMatchObject({ gateway: { mode: "local", port: 19001 } });
    expect(result.argv).not.toContain("--port");
    expect(result.argv).not.toContain("--url");
    expect(result.hasToken).toBe(true);
    expect(result.url).toBeNull();
  });

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

    const fsmonitorMarker = path.join(root, "fsmonitor-ran");
    const fsmonitorHook = path.join(root, "fsmonitor.sh");
    writeFileSync(fsmonitorHook, `#!/bin/sh\ntouch ${fsmonitorMarker}\n`);
    chmodSync(fsmonitorHook, 0o755);
    setTrustedGitConfig(snapshot, "core.fsmonitor", fsmonitorHook);
    rmSync(fsmonitorMarker, { force: true });
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(true);
    expect(existsSync(fsmonitorMarker)).toBe(false);

    git(snapshot, "switch", "-c", "mutable");
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(false);
    git(snapshot, "checkout", "--detach", head);
    chmodSync(path.join(snapshot, ".git/HEAD"), 0o600);

    const filterMarker = path.join(root, "filter-ran");
    const filterHook = path.join(root, "filter.sh");
    writeFileSync(filterHook, `#!/bin/sh\ntouch ${filterMarker}\ncat\n`);
    chmodSync(filterHook, 0o755);
    setTrustedGitConfig(snapshot, "filter.untrusted.clean", filterHook);
    mkdirSync(path.join(snapshot, ".git/info"), { recursive: true });
    writeFileSync(path.join(snapshot, ".git/info/attributes"), "README.md filter=untrusted\n");
    writeFileSync(path.join(snapshot, "README.md"), "dirty\n");
    rmSync(filterMarker, { force: true });
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(true);
    expect(existsSync(filterMarker)).toBe(false);
    git(snapshot, "checkout", "--", "README.md");
    writeFileSync(
      path.join(snapshot, "dist", BUILD_STAMP_FILE),
      `${JSON.stringify({ head: "0".repeat(40) })}\n`,
    );
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

  test("accepts supported LaunchAgent layouts and rejects foreign commands", () => {
    const home = "/Users/test";
    const entrypoint = "/Users/test/.openclaw/runtime/gateway-1234567/dist/index.js";
    const wrapper = `${home}/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh`;
    const foreignWrapper = `${home}/.openclaw/service-env/foreign-wrapper.sh`;
    const envFile = `${home}/.openclaw/service-env/ai.openclaw.gateway.env`;
    const nodeCommand = ["/opt/homebrew/bin/node", entrypoint, "gateway", "--port", "18789"];

    expect(resolveManagedGatewayEntrypoint(nodeCommand, home)).toBe(entrypoint);
    expect(
      resolveManagedGatewayEntrypoint(["/opt/homebrew/bin/bun", entrypoint, "gateway"], home),
    ).toBe(entrypoint);
    expect(
      resolveManagedGatewayEntrypoint(["/bin/sh", wrapper, envFile, ...nodeCommand], home),
    ).toBe(entrypoint);
    expect(resolveManagedGatewayEntrypoint([wrapper, envFile, ...nodeCommand], home)).toBe(
      entrypoint,
    );
    const customState = "/Users/test/state";
    const customWrapper = `${customState}/service-env/ai.openclaw.gateway-env-wrapper.sh`;
    const customEnvFile = `${customState}/service-env/ai.openclaw.gateway.env`;
    expect(
      resolveManagedGatewayEntrypoint(
        ["/bin/sh", customWrapper, customEnvFile, ...nodeCommand],
        home,
      ),
    ).toBe(entrypoint);
    expect(
      resolveManagedGatewayEntrypoint(["/usr/bin/python3", entrypoint, "gateway"], home),
    ).toBeNull();
    expect(
      resolveManagedGatewayEntrypoint(["/bin/sh", foreignWrapper, envFile, ...nodeCommand], home),
    ).toBeNull();
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
    const { mirror, run } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
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
    const { mirror } = makeFixture();
    writeBuild(mirror);
    const head = git(mirror, "rev-parse", "HEAD");
    const buildStamp = path.join(mirror, "dist", BUILD_STAMP_FILE);
    const runtimeStamp = path.join(mirror, "dist", RUNTIME_POSTBUILD_STAMP_FILE);

    writeFileSync(buildStamp, `${JSON.stringify({ head: "0".repeat(40) })}\n`);
    expect(inspectBuildState(mirror, head)).toMatchObject({
      current: false,
      buildStampHead: "0".repeat(40),
      requirements: { build: { shouldBuild: true, reason: "git_head_changed" } },
    });

    writeFileSync(buildStamp, `${JSON.stringify({ head, inputsClean: true })}\n`);
    rmSync(runtimeStamp);
    expect(inspectBuildState(mirror, head)).toMatchObject({
      current: false,
      runtimePostBuildStampHead: null,
      requirements: {
        runtimePostBuild: { shouldSync: true, reason: "missing_runtime_postbuild_stamp" },
      },
    });
  });

  test("fast-forwards, builds exact SHA, restarts Gateway, then proves exact Mac target", async () => {
    const { mirror, seed, run } = makeFixture({ includeSeed: true });
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    writeFileSync(path.join(seed, "package.json"), '{"name":"openclaw"}\n');
    git(seed, "add", "package.json");
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

    expect(output.updated).toBe(true);
    expect(output.afterSha).toBe(git(seed, "rev-parse", "HEAD"));
    expect(output.buildChangedPaths).toEqual([changedPath, "package.json"]);
    expect(output.actions).toMatchObject({ macAppRebuild: true, macUiVerification: true });
    expect(commands.calls).toEqual([
      `${process.execPath} dist/index.js gateway stop`,
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm openclaw gateway restart",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
      "env SKIP_TSC=1 SKIP_UI_BUILD=1 bash scripts/restart-mac.sh --sign --wait --target-only",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
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
      error: {
        code: "command_timeout",
        diagnostics: {
          kind: "invariant",
          code: "command_timeout",
          details: {
            phase: "Git fetch",
            serviceState: "running",
            timeoutMs: 5 * 60_000,
          },
        },
      },
    });
  });

  test("recovers the previous service after a post-stop install timeout", async () => {
    const { root, mirror, run } = makeFixture();
    writeBuild(mirror);
    const { deployment, lockPath, plistPath } = createManagedLaunchAgentFixture(root, mirror);
    const events: string[] = [];

    await expect(
      run({
        inspectGatewayDeployment: () => deployment,
        runManagedCommand: async ({
          args,
          requireProcessTreeExit,
          timeoutMs,
        }: {
          args: string[];
          requireProcessTreeExit: boolean;
          timeoutMs: number;
        }) => {
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
      details: {
        phase: "dependency install",
        serviceState: "stopped",
        timeoutMs: 15 * 60_000,
      },
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
      const { root, mirror, run } = makeFixture();
      writeBuild(mirror);
      const { deployment, lockPath } = createManagedLaunchAgentFixture(root, mirror);
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
            runManagedCommand: async ({ args }: { args: string[] }) => {
              const command = args.join(" ");
              events.push(command);
              if (command === "install --frozen-lockfile") {
                throw Object.assign(new Error("process group remained live"), {
                  code: "EPROCESSGROUP_CLEANUP_FAILED",
                  processGroupId,
                  processTreeState: "live",
                });
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
          owner: {
            processGroupId,
            reason: "command_cleanup_failed",
            serviceState: "stopped",
          },
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
    const { mirror, run } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
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
    const { mirror, run } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const marker = path.join(mirror, "dist/OpenClaw.app/Contents/signature-marker");
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, "signed\n");
    const failure = await run({
      runCommand(command: string, args: string[]) {
        if (command === "pnpm" && args[0] === "build") {
          throw Object.assign(new Error("secret build message"), {
            status: 17,
            stdout: "secret build stdout",
            stderr: "secret build stderr",
          });
        }
      },
    }).catch((error: unknown) => error);
    expect(readFileSync(marker, "utf8")).toBe("signed\n");
    const formatted = formatUpdateFailure(failure);
    expect(formatted.error.message).toBe("build failed");
    expect(formatted.error.diagnostics).toEqual({
      kind: "command",
      operation: "build",
      status: 17,
    });
    expect(JSON.stringify(formatted)).not.toContain("secret build");
  });

  test("preserves a build failure after a delayed external restore of the exact Mac bundle", async () => {
    const { root, mirror, run } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const appBundle = path.join(mirror, "dist/OpenClaw.app");
    const appMarker = path.join(appBundle, "Contents/signature-marker");
    mkdirSync(path.dirname(appMarker), { recursive: true });
    writeFileSync(appMarker, "signed\n");
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
            const preserved = readdirSync(path.join(mirror, ".git")).find((entry) =>
              entry.startsWith(".openclaw-live-mac-"),
            );
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
    expect(
      readdirSync(path.join(mirror, ".git")).filter((entry) =>
        entry.startsWith(".openclaw-live-mac-"),
      ),
    ).toEqual([]);
  });

  test("repoints an ancestor snapshot across the next source update", async () => {
    const fixture = createSnapshotFixture({ advance: true });
    const { commands, source, snapshot, plistPath } = fixture;
    const inspectGatewayDeployment = () => ({
      ...fixture.inspect(),
      serviceEnvironment: { PRIVATE_MARKER: "not-serialized" },
    });
    const deferred = await fixture.run({
      inspectGatewayDeployment,
      prepareGatewaySuspension: () => ({
        status: "busy",
        reason: "active-work",
        retryAfterMs: 20_000,
        activeCount: 1,
        blockers: [{ kind: "agent-run", count: 1, message: "busy" }],
      }),
    });
    expect(deferred).toMatchObject({ deferred: true, reason: "gateway_active_work" });
    expect(commands.calls).toEqual([]);

    const resumed: string[] = [];
    await expect(
      fixture.run({
        inspectGatewayDeployment,
        prepareGatewaySuspension: () => ({ status: "ready", suspensionId: "failed-preparation" }),
        prepareGatewayEntrypointReplacement: () => {
          throw new Error("replacement plist lint failed");
        },
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
        return { status: "ready", suspensionId: "fixture-suspension" };
      },
      prepareGatewayEntrypointReplacement: () => {
        commands.calls.push("prepare replacement plist");
        return {
          ...fixture.replacement,
          install() {
            commands.calls.push("install replacement plist");
            fixture.replacement.install();
          },
        };
      },
      verifyAndAuditGateway: passGatewayRestartVerification,
      proveGatewayStopped: () => {
        commands.calls.push("prove gateway stopped");
        return stoppedGateway();
      },
    });
    expect(output.gatewayDeployment).toMatchObject({
      changed: true,
      entrypoint: source,
      previousEntrypoint: snapshot,
    });
    expect(JSON.stringify(output)).not.toContain("not-serialized");
    expect(controlEntrypoint).toBe(source);
    const uid = process.getuid?.() ?? 501;
    expect(commands.calls).toEqual([
      "prepare replacement plist",
      `/bin/launchctl bootout gui/${uid}/ai.openclaw.gateway`,
      "prove gateway stopped",
      "pnpm build",
      "install replacement plist",
      "/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE 1",
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
      "/bin/launchctl unsetenv OPENCLAW_GATEWAY_STARTUP_TRACE",
    ]);
  });

  test("reports primary invariant and rollback command diagnostics", async () => {
    const { root, mirror, run } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const { deployment } = createManagedLaunchAgentFixture(root, mirror);
    const failure = await run({
      inspectGatewayDeployment: () => deployment,
      runCommand(command: string, args: string[]) {
        if (command === "pnpm" && args[0] === "build") {
          resolveLaunchAgentExitTimeoutSeconds(0);
        }
        if (command === "/bin/launchctl" && args[0] === "bootstrap") {
          throw Object.assign(new Error("secret rollback command message"), {
            status: 23,
            stderr: "secret rollback stderr",
            stdout: "secret rollback stdout",
          });
        }
      },
      waitForGatewayProcess: () => {
        throw new Error("managed process was not observed");
      },
    }).catch((error: unknown) => error);

    const formatted = formatUpdateFailure(failure);
    expect(formatted.error.diagnostics).toEqual({
      kind: "aggregate",
      causeMember: 1,
      members: [
        {
          role: "primary",
          error: {
            kind: "invariant",
            code: "gateway_launchagent_failed",
            details: { exitTimeoutSeconds: 0 },
          },
        },
        {
          role: "rollback",
          error: { kind: "command", operation: "launchd.bootstrap", status: 23 },
        },
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
        prepareGatewayEntrypointReplacement: () => {
          commands.calls.push("prepare replacement plist");
          return {
            ...fixture.replacement,
            install() {
              commands.calls.push("install replacement plist");
              fixture.replacement.install();
            },
            restore() {
              commands.calls.push("restore previous plist");
              fixture.replacement.restore();
            },
          };
        },
        proveGatewayStopped: () => {
          commands.calls.push("prove gateway stopped");
          return stoppedGateway();
        },
        isGatewayLoaded: () => serviceLoaded,
        verifyAndAuditGateway: () => {
          commands.calls.push("verify replacement readiness");
          throw new Error("replacement readiness failed");
        },
      }),
    ).rejects.toThrow("replacement readiness failed");

    const uid = process.getuid?.() ?? 501;
    expect(serviceLoaded).toBe(true);
    expect(fixture.inspect().entrypoint).toBe(snapshot);
    expect(commands.calls).toEqual([
      "assert system ownership",
      "prepare replacement plist",
      `/bin/launchctl bootout gui/${uid}/ai.openclaw.gateway`,
      "prove gateway stopped",
      "pnpm build",
      "assert system ownership",
      "install replacement plist",
      "assert system ownership",
      "/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE 1",
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
      "/bin/launchctl unsetenv OPENCLAW_GATEWAY_STARTUP_TRACE",
      "verify replacement readiness",
      `/bin/launchctl bootout gui/${uid}/ai.openclaw.gateway`,
      "prove gateway stopped",
      "restore previous plist",
      "assert system ownership",
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
    ]);
  });

  test("resumes suspension when system ownership appears before bootout", async () => {
    const fixture = createSnapshotFixture({ advance: true });
    const resumed: string[] = [];
    await expect(
      maintainFixture(fixture.options, {
        assertNoSystemLaunchDaemonOwnership: () => {
          throw new Error("same-label system owner");
        },
        inspectGatewayDeployment: fixture.inspect,
        prepareGatewayEntrypointReplacement: () => {
          throw new Error("replacement preparation must not run");
        },
        resumeGatewaySuspension: (_checkout: string, id: string) => {
          resumed.push(id);
        },
      }),
    ).rejects.toThrow("same-label system owner");
    expect(resumed).toEqual(["fixture-suspension"]);
  });

  test("builds a trusted source control client while a snapshot is still running", async () => {
    const fixture = createSnapshotFixture({ current: false });
    const { commands, source, snapshot, plistPath } = fixture;
    let controlEntrypoint = "";
    let proofAttempts = 0;
    const output = await fixture.run({
      prepareGatewaySuspension: (_checkout: string, deployment: { entrypoint: string }) => {
        controlEntrypoint = deployment.entrypoint;
        return { status: "ready", suspensionId: "fixture-suspension" };
      },
      verifyAndAuditGateway: passGatewayRestartVerification,
      proveGatewayStopped: () => {
        commands.calls.push("prove gateway stopped");
        if (++proofAttempts <= 2) {
          throw new Error("snapshot still owns its listener");
        }
        return stoppedGateway();
      },
      sleep: (ms: number) => {
        commands.calls.push(`sleep ${ms}`);
      },
    });
    expect(controlEntrypoint).toBe(source);
    expect(proofAttempts).toBe(3);
    expect(output.gatewayDeployment).toMatchObject({
      changed: true,
      entrypoint: source,
      previousEntrypoint: snapshot,
    });
    const uid = process.getuid?.() ?? 501;
    expect(commands.calls).toEqual([
      "prove gateway stopped",
      "pnpm install --frozen-lockfile",
      "pnpm build",
      `/bin/launchctl bootout gui/${uid}/ai.openclaw.gateway`,
      "prove gateway stopped",
      "sleep 250",
      "prove gateway stopped",
      "/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE 1",
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
      "/bin/launchctl unsetenv OPENCLAW_GATEWAY_STARTUP_TRACE",
    ]);
  });

  test("recovers a stopped snapshot when the source control build is missing", async () => {
    const fixture = createSnapshotFixture({ current: false });
    const { commands, source, snapshot, plistPath } = fixture;
    let prepareCalled = false;
    const output = await fixture.run({
      prepareGatewaySuspension: () => {
        prepareCalled = true;
        throw new Error("must not execute an unavailable control build");
      },
      verifyAndAuditGateway: passGatewayRestartVerification,
    });
    expect(prepareCalled).toBe(false);
    expect(output.gatewayDeployment).toMatchObject({
      changed: true,
      entrypoint: source,
      previousEntrypoint: snapshot,
    });
    const uid = process.getuid?.() ?? 501;
    expect(commands.calls).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE 1",
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
      "/bin/launchctl unsetenv OPENCLAW_GATEWAY_STARTUP_TRACE",
    ]);
  });

  test("accepts an observed LaunchAgent process after bootstrap reports failure", async () => {
    const uid = process.getuid?.() ?? 501;
    const { root, mirror, run } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const source = path.join(mirror, "dist/index.js");
    const { deployment, plistPath } = createManagedLaunchAgentFixture(root, mirror);
    const calls: string[] = [];
    let processObserved = false;

    await run({
      runCommand(command: string, args: string[]) {
        const call = [command, ...args].join(" ");
        calls.push(call);
        if (command === "/bin/launchctl" && args[0] === "bootstrap") {
          throw Object.assign(new Error("Bootstrap failed: 5: Input/output error"), {
            status: 5,
          });
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
      verifyGateway: () => {
        throw new Error("managed job is unloaded");
      },
      verifyAndAuditGateway: () => ({
        entries: 0,
        errorCount: 0,
        warningCount: 0,
        errors: [],
        warnings: [],
      }),
      verifyGatewayRuntime: () => ({ entrypoint: source, pid: 123, port: 18789 }),
      waitForGatewayProcess: () => {
        processObserved = true;
      },
    });

    expect(processObserved).toBe(true);
    expect(calls).toEqual([
      "arm environment restore",
      "/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE 1",
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
      "/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE already-enabled",
      "disarm environment restore",
    ]);
  });

  test("rejects unsafe bootstrap command cleanup before process observation", async () => {
    const { root, mirror, run } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const { deployment } = createManagedLaunchAgentFixture(root, mirror);
    let processObserved = false;

    const failure = await run({
      inspectGatewayDeployment: () => deployment,
      isGatewayLoaded: () => false,
      runManagedCommand: ({ args, bin }: { args: string[]; bin: string }) => {
        if (bin === "/bin/launchctl" && args[0] === "bootstrap") {
          throw Object.assign(new Error("launchctl cleanup remained live"), {
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processGroupId: 4321,
            processTreeState: "live",
          });
        }
        return 0;
      },
      verifyGateway: () => {
        throw new Error("managed job is unloaded");
      },
      waitForGatewayProcess: () => {
        processObserved = true;
      },
    }).catch((error: unknown) => error);

    expect(processObserved).toBe(false);
    expect(formatUpdateFailure(failure)).toMatchObject({
      error: {
        code: "command_cleanup_failed",
        diagnostics: {
          kind: "invariant",
          code: "command_cleanup_failed",
          details: {
            processTreeState: "live",
            serviceState: "stopped",
          },
        },
      },
    });
  });

  test("audits restart-window logs even when deep Gateway verification fails", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
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

  test("refuses a symlinked maintenance state file without touching its target", async () => {
    const { root, mirror } = makeFixture();
    const statePath = path.join(root, "maintenance-state.json");
    const victimPath = path.join(root, "victim.txt");
    writeFileSync(victimPath, '{"untouched":true}\n');
    symlinkSync(victimPath, statePath);

    await expect(
      maintainFixture({
        checkout: mirror,
        remote: "origin",
        lockPath: path.join(root, "maintenance.lock"),
        statePath,
      }),
    ).rejects.toThrow(/maintenance state is unreadable/u);
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
    writeFileSync(path.join(seed, "linux-preflight.txt"), "advance origin\n");
    git(seed, "add", "linux-preflight.txt");
    git(seed, "commit", "-m", "advance origin");
    git(seed, "push");
    const before = git(mirror, "rev-parse", "HEAD");
    const beforeTracking = git(mirror, "rev-parse", "refs/remotes/origin/main");
    const binDir = writeFixtureGitBin(root, origin);

    const result = spawnSync(process.execPath, [...updaterLoaderArgs, script], {
      cwd: mirror,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
    expect(result.status).toBe(1);
    expect(git(mirror, "rev-parse", "HEAD")).toBe(before);
    expect(git(mirror, "rev-parse", "refs/remotes/origin/main")).toBe(beforeTracking);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: "unsupported_gateway_control_platform",
        message:
          "live updater managed Gateway control requires macOS LaunchAgent inspection; Linux systemd installs must use the standard update CLI instead of this helper",
        diagnostics: {
          kind: "invariant",
          code: "unsupported_gateway_control_platform",
        },
      },
    });
  });
});
