import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repo = path.resolve(import.meta.dirname, "../..");
const temps = useAutoCleanupTempDirTracker(afterEach);
const workflow = parse(fs.readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8"));
const swiftSteps = workflow.jobs["macos-swift"].steps;
const swiftBuildStep = swiftSteps.find(
  (step: { name?: string }) => step.name === "Build Swift tests",
).run as string;
const swiftStep =
  swiftBuildStep +
  "\n" +
  swiftSteps.find((step: { name?: string }) => step.name === "Swift test").run;
const read = (file: string) => fs.readFileSync(file, "utf8");
const rows = (file: string) => read(file).trim().split("\n");
const readJson = (file: string) => JSON.parse(read(file));

function eventStream(...kinds: string[]) {
  return records(kinds.map((kind) => ({ kind: "event", payload: { kind } })));
}

function records(values: object[]) {
  return values.map((record) => JSON.stringify({ version: "6.3.0", ...record })).join("\n") + "\n";
}

function appHostEventStream(outcome: "complete" | "skipped" | "suite-only"): string {
  const test = (kind: string, id: string) => ({
    kind: "test",
    payload: { kind, id },
  });
  const event = (kind: string, testID?: string) => ({
    kind: "event",
    payload: { kind, testID },
  });
  return records([
    test("suite", "fixture/suite"),
    test("function", "fixture/function"),
    event("runStarted"),
    ...(outcome === "complete"
      ? [event("testStarted", "fixture/function"), event("testEnded", "fixture/function")]
      : outcome === "skipped"
        ? [event("testSkipped", "fixture/function")]
        : []),
    event("testEnded", "fixture/suite"),
    event("runEnded"),
  ]);
}

function fixture(
  securityFailure = "",
  logicalCpu = "3",
  eventReport: string | null = eventStream("runStarted", "runEnded"),
  waitForSignal: false | "swift" | "security" = false,
) {
  const root = temps.make("native-launch-");
  const bin = path.join(root, "bin");
  const home = path.join(root, "ambient-home");
  const runnerTemp = path.join(root, "runner-temp");
  const workspace = path.join(root, "workspace");
  const log = path.join(root, "calls.jsonl");
  for (const dir of [bin, home, runnerTemp, workspace]) {
    fs.mkdirSync(dir);
  }
  const toolchain = path.join(root, ".ci-harness/scripts/lib");
  fs.mkdirSync(toolchain, { recursive: true });
  fs.copyFileSync(
    path.join(repo, "scripts/lib/swift-toolchain.sh"),
    path.join(toolchain, "swift-toolchain.sh"),
  );
  fs.copyFileSync(
    path.join(repo, "scripts/ci-collect-checks.sh"),
    path.join(root, ".ci-harness/scripts/ci-collect-checks.sh"),
  );
  fs.symlinkSync(path.join(root, ".ci-harness"), path.join(workspace, ".ci-harness"));
  fs.symlinkSync(path.join(repo, "scripts"), path.join(workspace, "scripts"));
  const cache = path.join(home, "Library/Caches/org.swift.swiftpm");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "fixture-cache"), "reusable build cache");
  // Every executable that could build, test, or mutate the checkout is fake.
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
const resources = ['HOME', 'CFFIXED_USER_HOME', 'TMPDIR', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'];
const present = Object.fromEntries(resources.map(key => [key, !!env[key] && fs.existsSync(env[key])]));
const cachePath = path.join(env.HOME, 'Library/Caches/org.swift.swiftpm/fixture-cache');
const cache = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, 'utf8') : null;
const preferences = path.join(env.HOME, 'Library/Preferences');
const keychains = path.join(env.HOME, 'Library/Keychains');
const settingsPath = path.join(preferences, 'fixture-keychain.json');
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
const keychain = settings.default && fs.existsSync(settings.default) ? JSON.parse(fs.readFileSync(settings.default, 'utf8')) : null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool, args, env, present, cache, settings, keychain, pid: process.pid, ppid: process.ppid}) + '\\n');
function awaitSignal(ownedKeychain) {
  process.on('SIGTERM', () => {
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool: 'shutdown', resourcesPresent: fs.existsSync(env.HOME) && fs.existsSync(env.OPENCLAW_STATE_DIR), keychainPresent: !!ownedKeychain && fs.existsSync(ownedKeychain)}) + '\\n');
    process.exit(0);
  });
  console.log('fake-child-ready');
  setInterval(() => {}, 1000);
}
if (tool === 'security') {
  const ownedKeychains = env.HOME === ${JSON.stringify(home)}
    ? path.join(path.dirname(env.TMPDIR), 'home/Library/Keychains') : keychains;
  for (const dir of [preferences, ownedKeychains]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const owned = args.at(-1);
  assert.equal(path.dirname(owned), ownedKeychains);
  const operation = args[0];
  if (operation === 'delete-keychain' && env.OPENCLAW_TEST_MENU_CAPTURE_DIR) {
    const mode = env.OPENCLAW_PROFILE === 'default' ? 'default' : 'named';
    const name = mode === 'default' ? 'catalog' : 'thread-reasoning';
    const image = path.join(env.OPENCLAW_TEST_MENU_CAPTURE_DIR, name + '-window.png');
    if (fs.existsSync(image)) {
      const prefix = 'menu-' + mode + '-artifact-path=';
      const exported = fs.readFileSync(${JSON.stringify(path.join(root, "outputs"))}, 'utf8')
        .split('\\n').filter(line => line.startsWith(prefix)).at(-1)?.slice(prefix.length);
      assert.ok(exported && fs.existsSync(env.HOME));
      assert.deepEqual(fs.readFileSync(path.join(exported, name + '-window.png')), fs.readFileSync(image));
    }
  }
  if (operation === 'create-keychain' || operation === 'unlock-keychain') {
    assert.deepEqual(args.slice(1, -1), ['-p', '']);
  } else if (operation === 'list-keychains' || operation === 'default-keychain') {
    assert.deepEqual(args.slice(1, -1), ['-d', 'user', '-s']);
  } else {
    assert.ok(['set-keychain-settings', 'delete-keychain'].includes(operation));
    assert.equal(args.length, 2);
  }
  // A failed create may already have left its owned database behind.
  if (operation === 'create-keychain') fs.writeFileSync(owned, JSON.stringify({locked: true, autoLock: true}));
  if (${JSON.stringify(waitForSignal)} === 'security' && operation === 'create-keychain') awaitSignal(owned);
  if (operation === ${JSON.stringify(securityFailure)}) process.exit(29);
  const data = JSON.parse(fs.readFileSync(owned, 'utf8'));
  if (operation === 'unlock-keychain') data.locked = false;
  if (operation === 'set-keychain-settings') data.autoLock = false;
  if (operation === 'list-keychains') settings.search = [owned];
  if (operation === 'default-keychain') settings.default = owned;
  if (operation === 'delete-keychain') fs.unlinkSync(owned);
  else fs.writeFileSync(owned, JSON.stringify(data));
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
}
if (tool === 'uname') console.log('Darwin');
if (tool === 'sysctl') {
  assert.deepEqual(args, ['-n', 'hw.logicalcpu']);
  console.log(${JSON.stringify(logicalCpu)});
}
if (tool === 'rg') console.log('apps/macos/Sources/Fixture.swift');
if (tool === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') console.log(${JSON.stringify(root)});
if (tool === 'git' && args[0] === 'diff' && args.includes('--name-only')) console.log('apps/macos/Sources/Fixture.swift');
if (['xcrun', 'lldb', 'xctest', 'swiftpm-testing-helper'].includes(tool)) {
  throw new Error('Unexpected native tool invocation in the fake launcher fixture');
}
if ((tool === 'swift' && args[0] === 'test') || tool === 'OpenClawRecoveryTestHost') {
  const appHost = tool === 'OpenClawRecoveryTestHost';
  if (!appHost && env.OPENCLAW_TEST_MENU_CAPTURE_DIR) {
    const name = env.OPENCLAW_PROFILE === 'default' ? 'catalog' : 'thread-reasoning';
    for (const suffix of ['-window.png', '-menu-42.png', '-capture-status.json']) {
      fs.writeFileSync(path.join(env.OPENCLAW_TEST_MENU_CAPTURE_DIR, name + suffix), suffix.endsWith('.json') ? JSON.stringify({blockers: ['synthetic fixture, not visual proof']}) : 'synthetic-png-bytes');
    }
    fs.writeFileSync(path.join(env.OPENCLAW_TEST_MENU_CAPTURE_DIR, 'unrelated.log'), 'must remain private');
    fs.mkdirSync(path.join(env.OPENCLAW_TEST_MENU_CAPTURE_DIR, 'ignored-directory'));
  }
  const eventPathIndex = args.indexOf('--event-stream-output-path');
  if (eventPathIndex !== -1) {
    const eventPath = args[eventPathIndex + 1];
    assert.ok(path.isAbsolute(eventPath));
    assert.ok(eventPath.startsWith(path.dirname(appHost ? env.TMPDIR : env.HOME) + path.sep));
    assert.equal(args[args.indexOf('--event-stream-version') + 1], '6.3');
    const report = ${JSON.stringify(eventReport)};
    if (report !== null) fs.writeFileSync(eventPath, appHost ? report.replaceAll('fixture/function', 'fixture/' + args[args.indexOf('--filter') + 1]) : report);
  }
  if (env.OPENCLAW_STATE_DIR !== ${JSON.stringify(path.join(root, "ambient-state"))}) {
    fs.writeFileSync(path.join(env.OPENCLAW_STATE_DIR, 'child-owned'), 'fixture');
  }
  if (${JSON.stringify(waitForSignal)} === 'swift') awaitSignal(settings.default);
  else process.exit(0);
}
`;
  for (const tool of [
    "security",
    "swift",
    "pnpm",
    "node",
    "git",
    "uname",
    "sysctl",
    "rg",
    "xcrun",
    "lldb",
    "xctest",
    "swiftpm-testing-helper",
  ]) {
    if (tool === "node") {
      fs.symlinkSync(process.execPath, path.join(bin, tool));
    } else {
      fs.writeFileSync(path.join(bin, tool), fake, { mode: 0o755 });
    }
  }
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: root,
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "macOS",
    RUNNER_TEMP: runnerTemp,
    RUNNER_TRACKING_ID: "synthetic-native-runner-tracking",
    GITHUB_OUTPUT: path.join(root, "outputs"),
    HISTORICAL_TARGET: "false",
    SWIFT_TEST_EXECUTION: "serial",
    OPENCLAW_PROFILE: "ambient-fixture",
    OPENCLAW_STATE_DIR: path.join(root, "ambient-state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "ambient-config.json"),
    OPENCLAW_GATEWAY_TOKEN: "synthetic-not-a-credential",
    DEVELOPER_DIR: "/synthetic/Xcode.app/Contents/Developer",
    DYLD_FRAMEWORK_PATH: "/synthetic/frameworks",
    DYLD_LIBRARY_PATH: "/synthetic/libraries",
  };
  return {
    root,
    workspace,
    env,
    log,
    capturePath: (profileMode: "default" | "named") => {
      if (!fs.existsSync(env.GITHUB_OUTPUT)) {
        return undefined;
      }
      const prefix = `menu-${profileMode}-artifact-path=`;
      return rows(env.GITHUB_OUTPUT)
        .findLast((line) => line.startsWith(prefix))
        ?.slice(prefix.length);
    },
    calls: () => rows(log).map((line) => JSON.parse(line)),
    run: (script: string, cwd = workspace, overrides = {}) =>
      spawnSync(
        "/bin/bash",
        [
          "-c",
          `export DYLD_FRAMEWORK_PATH=/synthetic/frameworks DYLD_LIBRARY_PATH=/synthetic/libraries\n${script}`,
        ],
        {
          cwd,
          env: { ...env, ...overrides },
          encoding: "utf8",
          timeout: 15_000,
        },
      ),
  };
}

function launchNamed(f: ReturnType<typeof fixture>, readyText: string) {
  const child = spawn(
    process.execPath,
    ["scripts/test-macos-native.mts", "named", "--skip-build"],
    {
      cwd: repo,
      env: f.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const completion = once(child, "close");
  let stdout = "",
    stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const ready = new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(readyText)) {
        resolve();
      }
    });
  });
  return {
    child,
    completion,
    stderr: () => stderr,
    ready: () =>
      Promise.race([
        ready,
        completion.then(() => {
          throw new Error(stderr || `launcher exited before ${readyText}`);
        }),
      ]),
  };
}

describe.skipIf(process.platform === "win32")("native test launch ownership", () => {
  it.each([
    [appHostEventStream("complete"), "absent", 0, 3, ["retry", "credential-startup", "relaunch"]],
    [eventStream("runStarted", "runEnded"), "absent", 1, 1],
    [appHostEventStream("skipped"), "absent", 1, 1],
    [appHostEventStream("suite-only"), "absent", 1, 1],
    [appHostEventStream("complete"), "unknown", 1, 2],
  ] satisfies [
    events: string,
    inspection: string,
    expected: number,
    hosts: number,
    filters?: string[],
  ][])(
    "owns fresh app hosts and refuses incomplete proof (case %#)",
    (events, inspection, expected, hosts, filters = ["retry", "relaunch"]) => {
      const f = fixture("", "3", events);
      const contents = path.join(f.root, "Fixture.app/Contents");
      fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
      fs.copyFileSync(
        path.join(f.root, "bin/swift"),
        path.join(contents, "MacOS/OpenClawRecoveryTestHost"),
      );
      const bundle = path.join(f.root, "compiled-tests");
      fs.writeFileSync(bundle, "synthetic compiled test bundle");
      fs.writeFileSync(
        path.join(f.root, "bin/launchctl"),
        `#!${process.execPath}
if (process.argv[2] === 'print') {
  console.error(${JSON.stringify(inspection === "absent" ? "Could not find service in domain" : "Inspection permission denied")});
  process.exit(${inspection === "absent" ? 113 : 5});
}
`,
        { mode: 0o755 },
      );
      const result = f.run(
        `node '${path.join(repo, "scripts/test-macos-native.mts")}' app-host '${path.dirname(contents)}' '${bundle}' ${filters.join(" ")}`,
      );
      expect(result.status, result.stderr).toBe(expected);
      const calls = f.calls();
      const invoked = calls.filter((call) => call.tool === "OpenClawRecoveryTestHost");
      const home = invoked[0].env.HOME;
      const ownedRoot = path.dirname(invoked[0].env.TMPDIR);
      const state = invoked[0].env.OPENCLAW_STATE_DIR;
      try {
        expect(invoked).toHaveLength(hosts);
        expect(home).toBe(fs.realpathSync(f.env.HOME));
        const security = calls.find((call) => call.tool === "security");
        expect(security.args.at(-1)).toBe(
          path.join(ownedRoot, "home/Library/Keychains/native-tests.keychain-db"),
        );
        expect(invoked.every((call) => call.keychain?.locked === false)).toBe(true);
        expect(new Set(invoked.map((call) => call.env.HOME)).size).toBe(1);
        expect(new Set(invoked.map((call) => call.env.OPENCLAW_PROFILE)).size).toBe(1);
        expect(invoked[0].env.OPENCLAW_STATE_DIR).toBe(
          path.join(home, `.openclaw-${invoked[0].env.OPENCLAW_PROFILE}`),
        );
        expect(invoked.map((call) => call.args[call.args.indexOf("--filter") + 1])).toEqual(
          filters.slice(0, hosts),
        );
        const artifactLine = rows(f.env.GITHUB_OUTPUT).find((line) =>
          line.startsWith("recovery-artifact-path="),
        );
        expect(artifactLine).toBeDefined();
        const artifact = artifactLine!.slice("recovery-artifact-path=".length);
        expect(fs.readdirSync(artifact)).toHaveLength(hosts);
        expect(read(path.join(artifact, "phase-0-events.jsonl"))).toContain("runEnded");
        expect(fs.existsSync(home)).toBe(true);
        expect(fs.existsSync(state)).toBe(inspection === "unknown");
        expect(fs.existsSync(ownedRoot)).toBe(inspection === "unknown");
        if (inspection === "unknown") {
          expect(result.stderr).toContain("retirement is unverified");
        }
        if (expected === 1 && inspection === "absent") {
          expect(result.stderr).toContain("Swift Testing did not finish its run");
        }
      } finally {
        // Every executable was synthetic and joined; unknown inspection retained only fixture files.
        fs.rmSync(state, { recursive: true, force: true });
        fs.rmSync(ownedRoot, { recursive: true, force: true });
      }
    },
  );

  it.each(["scripts/test-macos-native.mts"])("routes %s through macOS CI", (changedPath) => {
    expect(detectChangedScope([changedPath])).toMatchObject({ runNode: true, runMacos: true });
  });

  it.each(["default", "named"] as const)(
    "isolates the %s profile and exports only captures",
    (mode) => {
      const f = fixture();
      const result = f.run(`node scripts/test-macos-native.mts ${mode} --skip-build`);
      expect(result.status, result.stderr).toBe(0);
      const test = f.calls().find((call) => call.tool === "swift");
      const ownedRoot = path.dirname(test.env.HOME);
      expect(test.env.OPENCLAW_PROFILE).toEqual(
        mode === "default" ? "default" : expect.stringMatching(/^test-[a-z0-9-]+$/),
      );
      expect(test.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      expect(test.env.CFFIXED_USER_HOME).toBe(test.env.HOME);
      expect(test.env).toMatchObject({
        RUNNER_TRACKING_ID: f.env.RUNNER_TRACKING_ID,
        DEVELOPER_DIR: f.env.DEVELOPER_DIR,
        DYLD_FRAMEWORK_PATH: f.env.DYLD_FRAMEWORK_PATH,
        DYLD_LIBRARY_PATH: f.env.DYLD_LIBRARY_PATH,
      });
      expect(test.keychain).toEqual({ locked: false, autoLock: false });
      expect(test.settings.search).toEqual([test.settings.default]);
      expect(path.dirname(test.settings.default)).toBe(
        path.join(test.env.HOME, "Library/Keychains"),
      );
      const tokens = new Set<string>();
      for (const call of f.calls()) {
        expect(call.ppid).toBe(test.ppid);
        expect(call.env).toEqual({
          ...test.env,
          OPENCLAW_MANAGED_CLEANUP_PARENT: expect.stringMatching(
            new RegExp(
              `^${test.ppid}:3:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
              "u",
            ),
          ),
        });
        const token = call.env.OPENCLAW_MANAGED_CLEANUP_PARENT.split(":")[2];
        expect(tokens.has(token)).toBe(false);
        tokens.add(token);
      }
      for (const key of ["HOME", "TMPDIR", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]) {
        expect(test.env[key].startsWith(`${ownedRoot}/`)).toBe(true);
        expect(test.present[key]).toBe(key !== "OPENCLAW_CONFIG_PATH");
      }
      expect(test.cache).toBe("reusable build cache");
      expect(fs.existsSync(ownedRoot)).toBe(false);
      expect(fs.existsSync(f.env.HOME)).toBe(true);
      const exported = f.capturePath(mode);
      expect(exported).toBeDefined();
      const name = mode === "default" ? "catalog" : "thread-reasoning";
      expect(read(path.join(exported!, `${name}-window.png`))).toBe("synthetic-png-bytes");
      expect(fs.readdirSync(exported!).toSorted()).toEqual(
        [
          "capture-export.json",
          `${name}-capture-status.json`,
          `${name}-menu-42.png`,
          `${name}-window.png`,
        ].toSorted(),
      );
      expect(readJson(path.join(exported!, "capture-export.json"))).toMatchObject({
        profileMode: mode,
        source: "ordinary-swift-run",
        swiftExitCode: 0,
      });
    },
  );

  it("rejects zero exit with incomplete Swift Testing completion", () => {
    const f = fixture("", "3", eventStream("runStarted"));
    const result = f.run(
      'node scripts/test-macos-native.mts named --package-path apps/macos --build-system native --enable-code-coverage --skip-build --experimental-maximum-parallelization-width 3 --filter "AppStateIsolationTests|ProfileChatPreferencesTests"',
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("[macos-native] FAILED (exit 1)");
    const calls = f.calls();
    const test = calls.find((call) => call.tool === "swift");
    expect(calls.filter((call) => call.tool === "swift")).toHaveLength(1);
    expect(calls.at(-1).args).toEqual(["delete-keychain", test.settings.default]);
    expect(fs.existsSync(path.dirname(test.env.HOME))).toBe(false);
  });

  it("rejects an invalid launch before starting Swift", () => {
    const f = fixture();
    const result = spawnSync(
      process.execPath,
      ["scripts/test-macos-native.mts", "named", "--skip-build"],
      {
        cwd: repo,
        env: { ...f.env, GITHUB_ACTIONS: "" },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("macos-swift");
    expect(result.stderr).toContain("[macos-native] FAILED (exit 1)");
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it.each(["security", "swift"] as const)(
    "keeps resources alive until interrupted %s has stopped",
    async (tool) => {
      const f = fixture("", "3", undefined, tool);
      const { child, completion, ready } = launchNamed(f, "fake-child-ready");
      try {
        await ready();
        const ownedRoot = path.dirname(f.calls()[0].env.HOME);
        expect(fs.existsSync(ownedRoot)).toBe(true);
        expect(fs.statSync(ownedRoot).mode & 0o777).toBe(0o700);
        child.kill("SIGTERM");
        const [code] = await completion;
        expect(code).toBe(143);
        expect(f.calls().at(-2)).toEqual({
          tool: "shutdown",
          resourcesPresent: true,
          keychainPresent: true,
        });
        expect(f.calls().at(-1).args[0]).toBe("delete-keychain");
        if (tool === "security") {
          expect(f.calls().some((call) => call.tool === "swift")).toBe(false);
        }
        expect(fs.existsSync(ownedRoot)).toBe(false);
      } finally {
        child.kill("SIGTERM");
        await completion;
      }
    },
  );

  it("retains the Keychain when escaped output cannot be joined", async () => {
    const f = fixture();
    const leafPidPath = path.join(f.root, "leaf.pid");
    const leaf = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid));
process.on('disconnect', () => console.log('fake-output-held'));
setInterval(() => {}, 1000);
process.send('ready');
`;
    fs.writeFileSync(
      path.join(f.root, "bin/swift"),
      `#!${process.execPath}
const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], {detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
child.once('message', () => process.exit(0));
`,
    );
    const { child, completion, ready, stderr } = launchNamed(f, "fake-output-held");
    let ownedRoot: string | undefined;
    try {
      await ready();
      const calls = f.calls();
      ownedRoot = path.dirname(calls[0].env.HOME);
      const ownedKeychain = calls[0].args.at(-1);
      expect(fs.existsSync(ownedKeychain)).toBe(true);
      expect(calls.some((call) => call.args?.[0] === "delete-keychain")).toBe(false);
      expect(f.capturePath("named")).toBeUndefined();
      const [code] = await completion;
      expect(code, stderr()).toBe(1);
      expect(f.capturePath("named")).toBeUndefined();
      expect(fs.existsSync(ownedKeychain)).toBe(true);
      expect(f.calls().some((call) => call.args?.[0] === "delete-keychain")).toBe(false);
      expect(stderr()).toContain("EPROCESSGROUP_CLEANUP_FAILED");
      expect(stderr()).toContain(ownedRoot);
    } finally {
      child.kill("SIGTERM");
      await completion;
      if (fs.existsSync(leafPidPath)) {
        const pid = Number(read(leafPidPath));
        process.kill(pid, "SIGKILL");
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                return true;
              }
              throw error;
            }
          })
          .toBe(true);
      }
      if (ownedRoot) {
        fs.rmSync(ownedRoot, { recursive: true, force: true });
      }
    }
  });

  it("cleans a completed create-keychain failure without starting Swift", () => {
    const f = fixture("create-keychain");
    const result = f.run("node scripts/test-macos-native.mts named --skip-build");
    expect(result.status, result.stderr).not.toBe(0);
    const calls = f.calls();
    expect(calls.every((call) => call.tool === "security")).toBe(true);
    expect(calls.at(-2).args[0]).toBe("create-keychain");
    expect(calls.at(-1).args[0]).toBe("delete-keychain");
    expect(fs.existsSync(path.dirname(calls[0].env.HOME))).toBe(false);
    expect(result.stderr).toContain("[macos-native] FAILED");
  });

  it("retains resources and reports Keychain cleanup failure", () => {
    const f = fixture("delete-keychain");
    const result = f.run("node scripts/test-macos-native.mts named --skip-build");
    expect(result.status, result.stderr).not.toBe(0);
    const calls = f.calls();
    const ownedRoot = path.dirname(calls[0].env.HOME);
    try {
      expect(calls.at(-2).tool).toBe("swift");
      expect(calls.at(-1).args[0]).toBe("delete-keychain");
      expect(fs.existsSync(calls.at(-1).args.at(-1))).toBe(true);
      expect(result.stderr).toContain(ownedRoot);
      expect(result.stderr).toContain("delete-keychain");
      expect(result.stderr).toContain("[macos-native] FAILED");
    } finally {
      fs.rmSync(ownedRoot, { recursive: true, force: true });
    }
  });

  it("requires the launcher for current release targets", () => {
    const f = fixture();
    const result = f.run(swiftStep, f.root, { HISTORICAL_TARGET: "false" });
    expect(result.status, result.stderr).toBe(1);
    const calls = f.calls().filter((call) => call.tool === "swift");
    expect(calls.map((call) => call.args[0])).toEqual(["build"]);
    expect(result.stderr).toContain("must provide scripts/test-macos-native.mts");
  });

  it("refuses native execution from prepush even with CI markers", () => {
    const f = fixture();
    // The real prepush has Node test commands; replace node only in this fixture.
    fs.unlinkSync(path.join(f.root, "bin/node"));
    fs.copyFileSync(path.join(f.root, "bin/pnpm"), path.join(f.root, "bin/node"));
    const result = f.run(`bash '${path.join(repo, "scripts/prepush-ci.sh")}'`, f.root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("macos-swift");
    const calls = f.calls().filter((call) => call.tool === "swift");
    expect(calls.map((call) => call.args[0])).toEqual(["build"]);
  });
});
