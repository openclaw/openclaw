import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  isProcessAlive,
  waitForChildClose,
  waitForDead,
  waitForFile,
  waitForFixtureFile,
  waitForPidFile,
} from "../helpers/process-wait.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyDockerSchedulerHarness } from "./docker-all-harness.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const posixIt = process.platform === "win32" ? it.skip : it;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const laneNames = ["gateway-network", "gateway-concurrency", "live-models"];

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function setupFixture(
  mode: "split" | "override" | "local",
  missingTargetScript = false,
  corepack = false,
  makeTempDir: typeof tempDirs.make = (prefix, root) => tempDirs.make(prefix, root),
) {
  const artifactRoot = path.resolve(".artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  const root = realpathSync(makeTempDir("docker-harness-", artifactRoot));
  const target = path.join(root, "frozen pnpm target");
  mkdirSync(target);
  const harness = mode === "local" ? target : path.join(target, ".release-harness");
  const selectedHarness =
    mode === "override" ? path.join(root, "operator's $& pnpm harness") : harness;
  copyDockerSchedulerHarness(harness);
  if (selectedHarness !== harness) {
    mkdirSync(selectedHarness, { recursive: true });
  }
  const marker = path.join(root, "calls.jsonl");
  const poison = path.join(root, "target-ran");
  const toolchainMarker = path.join(root, "toolchains.jsonl");
  const version = "2026.8.1";
  const packageDir = path.join(root, "packed", "package");
  writeJson(path.join(packageDir, "package.json"), { name: "openclaw", version });
  const tarball = path.join(root, "frozen candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(packageDir), "package"]);
  const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const trustedScript = `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
  lane: process.env.OPENCLAW_DOCKER_ALL_LANE_NAME,
  cwd: process.cwd(),
  phase: process.argv[2],
  skipDockerBuild: process.env.OPENCLAW_SKIP_DOCKER_BUILD,
  registry: process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR,
  registryVersion: process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION,
  registrySha256: process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256,
  target: process.env.OPENCLAW_DOCKER_E2E_REPO_ROOT,
  harness: process.env.OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR,
  liveTarget: process.env.OPENCLAW_LIVE_DOCKER_REPO_ROOT,
  package: process.env.OPENCLAW_CURRENT_PACKAGE_TGZ,
  sha256: process.env.OPENCLAW_CURRENT_PACKAGE_SHA256,
  selectedSha: process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA,
  cache: process.env.OPENCLAW_DOCKER_CACHE_HOME_DIR,
  tools: process.env.OPENCLAW_DOCKER_CLI_TOOLS_DIR,
}) + '\\n');
`;
  const poisonedScript = `require('node:fs').writeFileSync(${JSON.stringify(poison)}, 'old harness'); process.exit(47);`;
  for (const [dir, script] of [
    [target, poisonedScript],
    [selectedHarness, trustedScript],
  ] as const) {
    const scriptsDir = path.join(dir, "scripts");
    mkdirSync(path.join(scriptsDir, "e2e"), { recursive: true });
    writeFileSync(path.join(dir, "marker.cjs"), script);
    for (const leaf of [
      "e2e/gateway-concurrency-docker.sh",
      "test-live-models-docker.sh",
      "test-live-build-docker.sh",
    ]) {
      writeFileSync(
        path.join(scriptsDir, leaf),
        `#!/usr/bin/env bash\nexec node ${quote(path.join(dir, "marker.cjs"))} ${leaf === "test-live-build-docker.sh" ? "live-build" : ""}\n`,
      );
    }
    writeJson(path.join(dir, "package.json"), {
      name: "openclaw",
      version,
      ...(corepack && {
        packageManager: dir === selectedHarness ? "pnpm@11.22.0" : "pnpm@12.0.0",
      }),
      scripts:
        dir === target && missingTargetScript
          ? {}
          : {
              "test:docker:gateway-network": "node marker.cjs",
              "test:docker:package-install": "node marker.cjs",
              "test:docker:cli-installer-distribution": "node marker.cjs",
              "test:docker:e2e-build": "node marker.cjs package-image",
              "test:docker:cleanup": "node marker.cjs cleanup",
              "test:docker:all": `node ${quote(path.join(harness, "scripts/test-docker-all.mjs"))}`,
            },
    });
    // Keep pnpm in this miniature workspace, away from the host repo's toolchain pin.
    writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  }
  execFileSync("git", ["init", "-q"], { cwd: target });
  execFileSync("git", ["add", "package.json"], { cwd: target });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "candidate"],
    { cwd: target },
  );
  const selectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: target,
    encoding: "utf8",
  }).trim();
  const registry = path.join(root, "frozen registry");
  mkdirSync(registry);
  writeJson(path.join(packageDir, "package.json"), { name: "@openclaw/codex", version });
  const pluginTarball = path.join(registry, "codex.tgz");
  execFileSync("tar", ["-czf", pluginTarball, "-C", path.dirname(packageDir), "package"]);
  const registryManifest = path.join(registry, "prepublish-plugin-registry.json");
  writeJson(registryManifest, {
    schema: "openclaw.prepublish-plugin-registry/v1",
    schemaVersion: 1,
    sourceSha: selectedSha,
    candidateVersion: version,
    packages: [
      {
        name: "@openclaw/codex",
        version,
        tarball: "codex.tgz",
        sha256: createHash("sha256").update(readFileSync(pluginTarball)).digest("hex"),
      },
    ],
  });
  const registrySha256 = createHash("sha256").update(readFileSync(registryManifest)).digest("hex");
  const pnpm = execFileSync("bash", ["-c", "command -v pnpm"], { encoding: "utf8" }).trim();
  const pinnedPnpm = path.join(root, "pinned '$& pnpm wrapper");
  // Corepack Engine.executePackageManagerRequest resolves findProjectSpec(cwd)
  // before runVersion forwards argv. pnpm then checks its effective project's pin.
  // Model only that offline boundary; package scripts still execute as real children.
  writeFileSync(
    pinnedPnpm,
    corepack
      ? `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const manifest = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
const selected = manifest(process.cwd()).packageManager;
const args = process.argv.slice(2);
const cwd = args[0] === '--dir' ? args.splice(0, 2)[1] : process.cwd();
const project = manifest(cwd);
fs.appendFileSync(${JSON.stringify(toolchainMarker)}, JSON.stringify({ cwd: process.cwd(), selected, required: project.packageManager }) + '\\n');
if (selected !== project.packageManager) {
  console.error('ERR_PNPM_BAD_PM_VERSION: Corepack selected ' + selected + ' before --dir; project requires ' + project.packageManager);
  process.exit(1);
}
const result = spawnSync(project.scripts[args[0]], { cwd, shell: true, stdio: 'inherit' });
process.exit(result.status ?? 1);
`
      : `#!/usr/bin/env bash\nexec ${quote(pnpm)} "$@"\n`,
  );
  chmodSync(pinnedPnpm, 0o755);
  return {
    root,
    target,
    harness,
    selectedHarness,
    marker,
    poison,
    tarball,
    sha256,
    selectedSha,
    pinnedPnpm,
    registry,
    registrySha256,
    toolchainMarker,
  };
}

function runFixture(
  fixture: ReturnType<typeof setupFixture>,
  mode: string,
  lanes = laneNames,
  options: { args?: string[]; env?: NodeJS.ProcessEnv } = {},
) {
  const logDir = path.join(fixture.root, "logs");
  const result = spawnSync(
    process.execPath,
    [path.join(fixture.harness, "scripts/test-docker-all.mjs"), ...(options.args ?? [])],
    {
      cwd: fixture.target,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        OPENCLAW_DOCKER_ALL_BUILD: "0",
        OPENCLAW_DOCKER_ALL_PREFLIGHT: "0",
        OPENCLAW_DOCKER_ALL_TIMINGS: "0",
        OPENCLAW_DOCKER_ALL_START_STAGGER_MS: "0",
        OPENCLAW_DOCKER_ALL_LIVE_RETRIES: "0",
        OPENCLAW_DOCKER_ALL_LANES: lanes.join(","),
        OPENCLAW_DOCKER_ALL_LOG_DIR: logDir,
        OPENCLAW_DOCKER_ALL_PNPM_COMMAND: fixture.pinnedPnpm,
        OPENCLAW_DOCKER_E2E_REPO_ROOT: mode === "local" ? "" : fixture.target,
        OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR:
          mode === "override" ? path.relative(fixture.target, fixture.selectedHarness) : "",
        OPENCLAW_DOCKER_E2E_SELECTED_SHA: fixture.selectedSha,
        OPENCLAW_CURRENT_PACKAGE_TGZ: fixture.tarball,
        OPENCLAW_CURRENT_PACKAGE_VERSION: "2026.8.1",
        OPENCLAW_CURRENT_PACKAGE_SHA256: fixture.sha256,
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: fixture.registry,
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: "2026.8.1",
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: fixture.registrySha256,
        ...options.env,
      },
    },
  );
  return { result, logDir };
}

function configureSignalFixtureLanes(
  fixture: ReturnType<typeof setupFixture>,
  names: readonly string[],
) {
  const catalog = path.join(fixture.harness, "scripts/lib/docker-e2e-scenarios.mts");
  const command = `exec ${quote(process.execPath)} "$OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR/marker.cjs"`;
  // These outcomes belong to the synthetic group leader, not Bash's optional last-command exec.
  writeFileSync(
    catalog,
    `${readFileSync(catalog, "utf8")}\n` +
      [
        `for (const name of ${JSON.stringify(names)}) {`,
        "  const lane = mainLanes.find((entry) => entry.name === name);",
        '  if (!lane) throw new Error("unknown signal fixture lane: " + name);',
        `  lane.command = ${JSON.stringify(command)};`,
        "}",
        "",
      ].join("\n"),
  );
}

function startOwnedScheduler(
  fixture: ReturnType<typeof setupFixture>,
  env: NodeJS.ProcessEnv,
  probe = "",
  pidFiles: readonly string[] = [],
  driver?: string,
) {
  const childrenPath = path.join(fixture.root, "scheduler-children.jsonl");
  const events = path.join(fixture.root, "scheduler-events");
  const preload = path.join(fixture.root, "scheduler-observer.mjs");
  mkdirSync(events);
  const entries = driver
    ? [driver, driver]
    : ["mjs", "mts"].map((extension) =>
        path.join(fixture.harness, `scripts/test-docker-all.${extension}`),
      );
  writeFileSync(
    preload,
    [
      "import fs from 'node:fs';",
      "import cp from 'node:child_process';",
      "import { syncBuiltinESMExports } from 'node:module';",
      `if (${JSON.stringify(entries)}.includes(process.argv[1])) {`,
      "  const spawn = cp.spawn;",
      "  cp.spawn = (...args) => {",
      "    const child = spawn(...args);",
      "    if (args[2]?.detached && child.pid) {",
      `      fs.appendFileSync(${JSON.stringify(childrenPath)}, JSON.stringify({ owner: process.pid, pid: child.pid }) + '\\n');`,
      "      for (const event of ['exit', 'close']) child.once(event, (code, signal) => {",
      `        const file = ${JSON.stringify(events)} + '/' + child.pid + '.' + event;`,
      "        fs.writeFileSync(file + '.pending', JSON.stringify({ code, signal }));",
      "        fs.renameSync(file + '.pending', file);",
      "      });",
      "    }",
      "    return child;",
      "  };",
      "  syncBuiltinESMExports();",
      "}",
      `if (process.argv[1] === ${JSON.stringify(entries[1])}) {`,
      "  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {",
      `    fs.writeFileSync(${JSON.stringify(events)} + '/' + signal, String(process.pid));`,
      "  });",
      probe,
      "}",
    ].join("\n"),
  );
  const shim = spawn(
    process.execPath,
    [
      ...(driver
        ? ["--import", pathToFileURL(path.join(fixture.harness, "scripts/tsx.mjs")).href]
        : []),
      entries[0]!,
    ],
    {
      cwd: fixture.target,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCLAW_DOCKER_ALL_BUILD: "0",
        OPENCLAW_DOCKER_ALL_PREFLIGHT: "0",
        OPENCLAW_DOCKER_ALL_TIMINGS: "0",
        OPENCLAW_DOCKER_ALL_START_STAGGER_MS: "0",
        OPENCLAW_DOCKER_ALL_STATUS_INTERVAL_MS: "0",
        OPENCLAW_DOCKER_ALL_LIVE_RETRIES: "0",
        OPENCLAW_DOCKER_ALL_LANES: laneNames.join(","),
        OPENCLAW_DOCKER_ALL_LOG_DIR: path.join(fixture.root, "logs"),
        OPENCLAW_DOCKER_ALL_PNPM_COMMAND: fixture.pinnedPnpm,
        OPENCLAW_DOCKER_E2E_REPO_ROOT: fixture.target,
        OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR: fixture.selectedHarness,
        OPENCLAW_DOCKER_E2E_SELECTED_SHA: fixture.selectedSha,
        OPENCLAW_CURRENT_PACKAGE_TGZ: fixture.tarball,
        OPENCLAW_CURRENT_PACKAGE_VERSION: "2026.8.1",
        OPENCLAW_CURRENT_PACKAGE_SHA256: fixture.sha256,
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: fixture.registry,
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: "2026.8.1",
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: fixture.registrySha256,
        ...env,
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`.trim(),
      },
    },
  );
  let stderr = "";
  shim.stdout.resume();
  shim.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  let didClose = false;
  const closed = new Promise<void>((resolve) => {
    shim.once("close", () => {
      didClose = true;
      resolve();
    });
  });
  const exited = new Promise<void>((resolve) => {
    shim.once("exit", () => resolve());
    shim.once("error", () => resolve());
  });
  let observationTimedOut = false;
  const result = waitForChildClose(shim, 25_000).catch((error: unknown) => {
    observationTimedOut = true;
    throw error;
  });
  void result.catch(() => undefined);
  const ownedPids = new Set<number>();
  const children = () => {
    const rows: Array<{ owner: number; pid: number }> = existsSync(childrenPath)
      ? readFileSync(childrenPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    const owners = new Set([shim.pid]);
    for (let remaining = rows.length; remaining > 0; remaining -= 1) {
      for (const row of rows) {
        if (owners.has(row.owner)) {
          owners.add(row.pid);
        }
      }
    }
    for (const row of rows) {
      expect(Number.isSafeInteger(row.pid) && row.pid > 1 && row.pid !== process.pid).toBe(true);
      expect(owners.has(row.owner)).toBe(true);
    }
    return rows;
  };
  const stopGroups = (pids: number[]) =>
    runQaGatewayFixture(
      async () => {},
      ...Array.from(new Set(pids), (pid) => async () => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
        await waitForDead(pid, 5_000);
      }),
    );
  return {
    shim,
    result,
    events,
    children,
    stderr: () => stderr,
    async ready(file: string) {
      try {
        return await waitForPidFile(file, 5_000);
      } catch (error) {
        throw new Error(
          `scheduler fixture readiness failed (exit=${String(shim.exitCode)}, signal=${String(shim.signalCode)}):\n${stderr}`,
          { cause: error },
        );
      }
    },
    captureGroup(startPid: number) {
      let pid = startPid;
      let group: number | undefined;
      for (let depth = 0; depth < 8 && pid !== shim.pid; depth += 1) {
        const [observed, parent, pgid] = execFileSync(
          "ps",
          ["-o", "pid=,ppid=,pgid=", "-p", String(pid)],
          { encoding: "utf8" },
        )
          .trim()
          .split(/\s+/u)
          .map(Number);
        expect(observed).toBe(pid);
        group ??= pgid;
        ownedPids.add(pid);
        pid = parent!;
      }
      expect(pid).toBe(shim.pid);
      expect(children().some((row) => row.pid === group)).toBe(true);
      return group!;
    },
    async cleanup() {
      // Stop admission, then reread acquisitions. Failed joins retain the inputs.
      await runQaGatewayFixture(
        async () => {
          if (!didClose) {
            if (shim.exitCode === null && shim.signalCode === null) {
              shim.kill("SIGTERM");
            }
            if (!observationTimedOut) {
              await waitForChildClose(shim).catch(() => undefined);
            }
          }
        },
        async () => {
          if (shim.exitCode === null && shim.signalCode === null) {
            shim.kill("SIGKILL");
          }
          await exited;
        },
        () =>
          stopGroups(
            children()
              .filter((row) => row.owner === shim.pid)
              .map((row) => row.pid),
          ),
        () => stopGroups(children().map((row) => row.pid)),
        () =>
          Promise.all(
            [
              ...ownedPids,
              ...pidFiles.filter(existsSync).map((file) => Number(readFileSync(file, "utf8"))),
            ]
              .filter((pid) => Number.isSafeInteger(pid) && pid > 1)
              .map((pid) => waitForDead(pid, 5_000)),
          ),
        () => closed,
      );
      rmSync(fixture.root, { recursive: true, force: true });
    },
  };
}

function observeStaggerTimer(fixture: Pick<ReturnType<typeof setupFixture>, "root" | "marker">) {
  const { root } = fixture;
  const ready = path.join(root, "stagger-timer.pid");
  const checkpoint = path.join(root, "stagger-checkpoint.json");
  const settled = path.join(root, "stagger-settled.json");
  return {
    ready,
    checkpoint,
    settled,
    probe: [
      "  const nativeSetTimeout = globalThis.setTimeout;",
      "  const nativeClearTimeout = globalThis.clearTimeout;",
      "  let stagger;",
      "  const receipt = (file) => {",
      `    const started = fs.existsSync(${JSON.stringify(fixture.marker)}) ? fs.readFileSync(${JSON.stringify(fixture.marker)}, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line).lane) : [];`,
      "    fs.writeFileSync(file + '.pending', JSON.stringify({ ...stagger.state, started }));",
      "    fs.renameSync(file + '.pending', file);",
      "  };",
      "  globalThis.setTimeout = (callback, ms, ...args) => {",
      "    if (!(new Error().stack ?? '').includes('waitForLaneStartSlot')) return nativeSetTimeout(callback, ms, ...args);",
      "    if (stagger) throw new Error('unexpected second stagger timer');",
      "    const state = { delay: ms, cleared: false, fired: false, fixtureReleased: false };",
      "    const timer = nativeSetTimeout(function (...values) {",
      "      state.fired = true;",
      `      receipt(${JSON.stringify(settled)});`,
      "      return Reflect.apply(callback, this, values);",
      "    }, ms, ...args);",
      "    stagger = { timer, callback, args, state };",
      `    fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
      "    return timer;",
      "  };",
      "  globalThis.clearTimeout = (timer) => {",
      "    if (stagger?.timer === timer) {",
      "      stagger.state.cleared = true;",
      `      receipt(${JSON.stringify(settled)});`,
      "    }",
      "    return nativeClearTimeout(timer);",
      "  };",
      // A full event-loop turn follows the synchronous signal handler or the
      // terminal runLane/cleanup rejection's uninterrupted observer microtasks.
      "  const checkpointStagger = () => setImmediate(() => {",
      `    if (stagger) receipt(${JSON.stringify(checkpoint)});`,
      "  });",
      "  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, checkpointStagger);",
      "  const terminalError = console.error;",
      "  console.error = (...args) => {",
      "    terminalError(...args);",
      "    if ((new Error().stack ?? '').includes('runLane') && String(args[0]).startsWith('==> [gateway-concurrency] fail')) checkpointStagger();",
      "  };",
      // This release is used only by the fixture's exceptional cleanup, after
      // assertions have already failed. It cannot produce a passing receipt.
      "  process.on('SIGUSR2', () => {",
      "    if (!stagger || stagger.state.cleared || stagger.state.fired) return;",
      "    stagger.state.fixtureReleased = true;",
      "    nativeClearTimeout(stagger.timer);",
      "    Reflect.apply(stagger.callback, stagger.timer, stagger.args);",
      "  });",
    ].join("\n"),
  };
}

async function cleanupStaggerFixture(owner: ReturnType<typeof startOwnedScheduler>) {
  await runQaGatewayFixture(
    async () => {
      for (const child of owner.children().filter((row) => row.owner === owner.shim.pid)) {
        try {
          process.kill(child.pid, "SIGUSR2");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
    },
    () => owner.cleanup(),
  );
}

describe("Docker scheduler trusted harness execution", () => {
  posixIt.each(
    (["foreground", "version", "remove", "smoke"] as const).flatMap((phase) =>
      (["exit-first", "signal-first"] as const).map((order) => ({ phase, order })),
    ),
  )(
    "preserves $phase terminal ordering when $order in actual main",
    async ({ phase, order }) => {
      const fixture = setupFixture("split", false, true, (prefix, root) =>
        mkdtempSync(path.join(root!, prefix)),
      );
      const leaderPath = path.join(fixture.root, "terminal-leader.pid");
      const leafPath = path.join(fixture.root, "terminal-leaf.pid");
      const leaf = [
        "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {});",
        "process.once('SIGUSR1', () => process.exit(0));",
        `require('node:fs').writeFileSync(${JSON.stringify(leafPath)}, String(process.pid));`,
        "process.send('ready'); setInterval(() => {}, 1000);",
      ].join("\n");
      const commandBody = [
        `fs.appendFileSync(${JSON.stringify(fixture.marker)}, JSON.stringify({ phase }) + '\\n');`,
        `if (phase === ${JSON.stringify(phase)}) {`,
        "  for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR1']) process.on(signal, () => process.exit(3));",
        `  fs.writeFileSync(${JSON.stringify(leaderPath)}, String(process.pid));`,
        `  const child = spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: ${JSON.stringify(phase === "version" ? ["ignore", "inherit", "inherit", "ipc"] : ["ignore", "ignore", "ignore", "ipc"])} });`,
        "  child.once('message', () => child.disconnect()); child.unref();",
        "  setInterval(() => {}, 1000);",
        "} else if (phase === 'list') console.log('openclaw-fixture-e2e-123 Exited');",
        "else console.log('fixture');",
      ].join("\n");
      writeFileSync(
        path.join(fixture.selectedHarness, "marker.cjs"),
        `const fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nconst phase = process.argv[2] === 'live-build' ? 'foreground' : process.argv[2] ?? 'lane';\n${commandBody}\n`,
      );
      const bin = path.join(fixture.root, "bin");
      mkdirSync(bin);
      const docker = path.join(bin, "docker");
      writeFileSync(
        docker,
        `#!${process.execPath}\nimport fs from 'node:fs';\nimport { spawn } from 'node:child_process';\nconst phase = { version: 'version', ps: 'list', rm: 'remove', run: 'smoke' }[process.argv[2]];\n${commandBody}\n`,
      );
      chmodSync(docker, 0o755);
      const owner = startOwnedScheduler(
        fixture,
        {
          OPENCLAW_DOCKER_ALL_BUILD: "1",
          OPENCLAW_DOCKER_ALL_PREFLIGHT: phase === "foreground" ? "0" : "1",
          OPENCLAW_DOCKER_ALL_PREFLIGHT_CLEANUP: "1",
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        },
        "",
        [leaderPath, leafPath],
      );
      await runQaGatewayFixture(
        async () => {
          const leafPid = await owner.ready(leafPath);
          const group = owner.captureGroup(leafPid);
          const leaderPid = await owner.ready(leaderPath);
          const signal = phase === "foreground" ? "SIGINT" : "SIGTERM";
          if (order === "exit-first") {
            process.kill(leaderPid, "SIGUSR1");
            const exitFile = path.join(owner.events, `${group}.exit`);
            await waitForFile(exitFile, 5_000);
            expect(JSON.parse(readFileSync(exitFile, "utf8"))).toEqual({ code: 3, signal: null });
            if (phase === "version") {
              expect(existsSync(path.join(owner.events, `${group}.close`))).toBe(false);
            } else {
              await waitForFile(path.join(owner.events, `${group}.close`), 5_000);
            }
          }
          owner.shim.kill(signal);
          const schedulerPid = await owner.ready(path.join(owner.events, signal));
          expect(owner.children()).toContainEqual({ owner: owner.shim.pid, pid: schedulerPid });
          if (order === "signal-first") {
            await waitForFile(path.join(owner.events, `${group}.exit`), 5_000);
          }
          expect(isProcessAlive(leafPid)).toBe(true);
          expect(owner.shim.exitCode).toBeNull();
          expect(owner.shim.signalCode).toBeNull();
          process.kill(leafPid, "SIGUSR1");
          expect(await owner.result).toEqual({
            code: order === "exit-first" ? 1 : signal === "SIGINT" ? 130 : 143,
            signal: null,
          });
          expect(isProcessAlive(leafPid)).toBe(false);
          const phases = readFileSync(fixture.marker, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line).phase);
          expect(phases).toEqual(
            phase === "foreground"
              ? ["foreground"]
              : phase === "version"
                ? ["version"]
                : phase === "remove"
                  ? ["version", "list", "remove"]
                  : ["version", "list", "remove", "smoke"],
          );
          const diagnostic = {
            foreground: "shared live-test image once failed with status 3",
            version: "Docker preflight failed: docker version status=3",
            remove: "Docker preflight cleanup failed with status 3",
            smoke: "Docker preflight failed: docker run --rm --platform",
          }[phase];
          if (order === "exit-first") {
            expect(owner.stderr()).toContain(diagnostic);
            if (phase === "smoke") {
              expect(owner.stderr()).toContain("status=3");
            }
          } else {
            expect(owner.stderr()).not.toContain(diagnostic);
          }
        },
        () => owner.cleanup(),
      );
    },
    30_000,
  );

  posixIt.each([
    ...(["SIGINT", "SIGTERM"] as const).flatMap((signal) =>
      (["failure-first", "signal-first", "success-first"] as const).map((order) => ({
        signal,
        order,
        descendant: false,
      })),
    ),
    { signal: "SIGTERM" as const, order: "failure-first" as const, descendant: true },
  ])(
    "preserves lane outcome for $signal after $order (descendant=$descendant) in actual main",
    async ({ signal, order, descendant }) => {
      const fixture = setupFixture("split", false, true, (prefix, root) =>
        mkdtempSync(path.join(root!, prefix)),
      );
      const laneOrder = ["gateway-concurrency", "live-models"];
      configureSignalFixtureLanes(fixture, laneOrder);
      const firstPidPath = path.join(fixture.root, "first-lane.pid");
      const siblingPidPath = path.join(fixture.root, "sibling-lane.pid");
      const leafPidPath = path.join(fixture.root, "lane-descendant.pid");
      const observed = path.join(fixture.root, "lane-result-observed");
      const leaf = [
        "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {});",
        "process.once('SIGUSR1', () => process.exit(0));",
        `require('node:fs').writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid));`,
        "process.send('ready'); setInterval(() => {}, 1000);",
      ].join("\n");
      writeFileSync(
        path.join(fixture.selectedHarness, "marker.cjs"),
        [
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(fixture.marker)}, JSON.stringify({ lane: process.env.OPENCLAW_DOCKER_ALL_LANE_NAME }) + '\\n');`,
          `if (process.env.OPENCLAW_DOCKER_ALL_LANE_NAME === ${JSON.stringify(laneOrder[0])}) {`,
          "  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(3));",
          `  process.once('SIGUSR1', () => process.exit(${order === "success-first" ? 0 : 3}));`,
          `  fs.writeFileSync(${JSON.stringify(firstPidPath)}, String(process.pid));`,
          ...(descendant
            ? [
                `  const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
                "  child.once('message', () => child.disconnect()); child.unref();",
              ]
            : []),
          "} else {",
          "  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {});",
          "  process.once('SIGUSR1', () => process.exit(0));",
          `  fs.writeFileSync(${JSON.stringify(siblingPidPath)}, String(process.pid));`,
          "}",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const probe = [
        "  for (const method of ['log', 'error']) {",
        "    const output = console[method];",
        "    console[method] = (...args) => {",
        "      output(...args);",
        "      if (/^==> \\[gateway-concurrency\\] (pass|fail)/.test(String(args[0]))) {",
        // runLane returns immediately after this diagnostic. Its pool result
        // observer completes before the next event-loop turn records this receipt.
        `        setImmediate(() => fs.writeFileSync(${JSON.stringify(observed)}, 'observed'));`,
        "      }",
        "    };",
        "  }",
      ].join("\n");
      const owner = startOwnedScheduler(
        fixture,
        {
          OPENCLAW_DOCKER_ALL_LANES: laneOrder.join(","),
          OPENCLAW_DOCKER_ALL_PARALLELISM: "2",
          OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT: "8",
          OPENCLAW_DOCKER_ALL_DOCKER_LIMIT: "8",
          OPENCLAW_DOCKER_ALL_LIVE_LIMIT: "4",
          OPENCLAW_DOCKER_ALL_LIVE_CLAUDE_LIMIT: "4",
          OPENCLAW_DOCKER_ALL_LIVE_GEMINI_LIMIT: "4",
          OPENCLAW_DOCKER_ALL_FAIL_FAST: "0",
        },
        probe,
        [firstPidPath, siblingPidPath, leafPidPath],
      );
      await runQaGatewayFixture(
        async () => {
          const firstPid = await owner.ready(firstPidPath);
          const siblingPid = await owner.ready(siblingPidPath);
          const firstGroup = owner.captureGroup(firstPid);
          owner.captureGroup(siblingPid);
          const leafPid = descendant ? await owner.ready(leafPidPath) : undefined;
          if (leafPid) {
            expect(owner.captureGroup(leafPid)).toBe(firstGroup);
          }
          if (order !== "signal-first") {
            process.kill(firstPid, "SIGUSR1");
            if (descendant) {
              await waitForFile(path.join(owner.events, `${firstGroup}.close`), 5_000);
              expect(existsSync(observed)).toBe(false);
            } else {
              await waitForFixtureFile(observed, owner.result, "observed");
            }
          }
          owner.shim.kill(signal);
          const schedulerPid = await owner.ready(path.join(owner.events, signal));
          expect(owner.children()).toContainEqual({ owner: owner.shim.pid, pid: schedulerPid });
          await waitForFile(path.join(owner.events, `${firstGroup}.exit`), 5_000);
          expect(
            JSON.parse(readFileSync(path.join(owner.events, `${firstGroup}.exit`), "utf8")),
          ).toEqual({ code: order === "success-first" ? 0 : 3, signal: null });
          expect(isProcessAlive(siblingPid)).toBe(true);
          if (leafPid) {
            expect(isProcessAlive(leafPid)).toBe(true);
            process.kill(leafPid, "SIGUSR1");
          }
          process.kill(siblingPid, "SIGUSR1");
          expect(await owner.result).toEqual({
            code: order === "failure-first" ? 1 : signal === "SIGINT" ? 130 : 143,
            signal: null,
          });
          const summary = JSON.parse(
            readFileSync(path.join(fixture.root, "logs/summary.json"), "utf8"),
          );
          expect(summary.selectedLanes).toEqual(laneOrder);
          expect(
            summary.lanes
              .map(({ name, status }: { name: string; status: number }) => ({ name, status }))
              .toSorted((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
          ).toEqual([
            { name: laneOrder[0], status: order === "success-first" ? 0 : 3 },
            { name: laneOrder[1], status: 0 },
          ]);
          if (order !== "success-first") {
            expect(owner.stderr()).toContain("gateway-concurrency failed (status=3)");
          }
          expect(isProcessAlive(siblingPid)).toBe(false);
          if (leafPid) {
            expect(isProcessAlive(leafPid)).toBe(false);
          }
        },
        () => owner.cleanup(),
      );
    },
    30_000,
  );

  posixIt.each([
    { outcome: "fatal rejection", fatal: true, failFast: false },
    { outcome: "ordinary failure with fail-fast", fatal: false, failFast: true },
    { outcome: "ordinary failure without fail-fast", fatal: false, failFast: false },
  ])(
    "fences staggered lane admission after $outcome in actual main",
    async ({ fatal, failFast }) => {
      const fixture = setupFixture("split", false, true, (prefix, root) =>
        mkdtempSync(path.join(root!, prefix)),
      );
      const leaderPath = path.join(fixture.root, "stagger-leader.pid");
      const groupPath = path.join(fixture.root, "stagger-group.pid");
      const faultPath = path.join(fixture.root, "stagger-probe-rejected");
      const timer = observeStaggerTimer(fixture);
      const laneOrder = ["gateway-concurrency", "live-models"];
      writeFileSync(
        path.join(fixture.selectedHarness, "marker.cjs"),
        [
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(fixture.marker)}, JSON.stringify({ lane: process.env.OPENCLAW_DOCKER_ALL_LANE_NAME }) + '\\n');`,
          `if (process.env.OPENCLAW_DOCKER_ALL_LANE_NAME === ${JSON.stringify(laneOrder[0])}) {`,
          `  fs.writeFileSync(${JSON.stringify(leaderPath)}, String(process.pid));`,
          `  process.once('SIGUSR1', () => process.exit(${fatal ? 0 : 3}));`,
          "  setInterval(() => {}, 1000);",
          "}",
        ].join("\n"),
      );
      const probe = fatal
        ? [
            "  const kill = process.kill.bind(process);",
            "  process.kill = (pid, signal) => {",
            `    if (signal === 0 && fs.existsSync(${JSON.stringify(groupPath)}) && pid === -Number(fs.readFileSync(${JSON.stringify(groupPath)}, 'utf8'))) {`,
            "      const stack = new Error().stack ?? '';",
            "      if (!stack.includes('shellProcessGroupAlive') && !stack.includes('waitForManagedProcessGroupExit')) {",
            `        fs.writeFileSync(${JSON.stringify(faultPath)}, 'final-verification');`,
            "        checkpointStagger();",
            "      }",
            "      throw Object.assign(new Error('stagger cleanup probe denied'), { code: 'EPERM' });",
            "    }",
            "    return kill(pid, signal);",
            "  };",
          ].join("\n")
        : "";
      const owner = startOwnedScheduler(
        fixture,
        {
          OPENCLAW_DOCKER_ALL_LANES: laneOrder.join(","),
          OPENCLAW_DOCKER_ALL_PARALLELISM: "2",
          OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT: "8",
          OPENCLAW_DOCKER_ALL_DOCKER_LIMIT: "8",
          OPENCLAW_DOCKER_ALL_LIVE_LIMIT: "4",
          OPENCLAW_DOCKER_ALL_LIVE_CLAUDE_LIMIT: "4",
          OPENCLAW_DOCKER_ALL_LIVE_GEMINI_LIMIT: "4",
          OPENCLAW_DOCKER_ALL_START_STAGGER_MS: fatal || failFast ? "600000" : "3000",
          OPENCLAW_DOCKER_ALL_FAIL_FAST: failFast ? "1" : "0",
        },
        `${timer.probe}\n${probe}`,
        [leaderPath],
      );
      await runQaGatewayFixture(
        async () => {
          const schedulerPid = await owner.ready(timer.ready);
          expect(owner.children()).toContainEqual({ owner: owner.shim.pid, pid: schedulerPid });
          const leaderPid = await owner.ready(leaderPath);
          const group = owner.captureGroup(leaderPid);
          if (fatal) {
            writeFileSync(groupPath, String(group));
          }
          process.kill(leaderPid, "SIGUSR1");
          await waitForFile(path.join(owner.events, `${group}.close`), 5_000);
          if (fatal) {
            await waitForFixtureFile(faultPath, owner.result, "final-verification");
          }
          await waitForFixtureFile(timer.checkpoint, owner.result);
          const checkpoint = JSON.parse(readFileSync(timer.checkpoint, "utf8"));
          expect(checkpoint.fixtureReleased).toBe(false);
          if (fatal || failFast) {
            expect(checkpoint).toMatchObject({
              cleared: true,
              fired: false,
              started: [laneOrder[0]],
            });
          } else if (!checkpoint.fired) {
            // Slow startup may outlive the real stagger. Until it fires, ordinary
            // non-fail-fast failure must neither cancel it nor admit the next lane.
            expect(checkpoint).toMatchObject({ cleared: false, started: [laneOrder[0]] });
          }
          expect(await owner.result).toEqual({ code: fatal ? 2 : 1, signal: null });
          expect(JSON.parse(readFileSync(timer.settled, "utf8"))).toMatchObject({
            fired: !fatal && !failFast,
            fixtureReleased: false,
          });
          // Later shutdown can block the command after runLane already wrote its log.
          // An unstarted lane must not perform that preparation either.
          expect(existsSync(path.join(fixture.root, "logs", `${laneOrder[1]}.log`))).toBe(
            !fatal && !failFast,
          );
          const started = readFileSync(fixture.marker, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line).lane);
          expect(started.toSorted((a: string, b: string) => a.localeCompare(b))).toEqual(
            fatal || failFast ? [laneOrder[0]] : laneOrder,
          );
          const summary = JSON.parse(
            readFileSync(path.join(fixture.root, "logs/summary.json"), "utf8"),
          );
          expect(summary.status).toBe("failed");
          expect(summary.selectedLanes).toEqual(laneOrder);
          expect(
            summary.lanes
              .map(({ name, status }: { name: string; status: number }) => ({ name, status }))
              .toSorted((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
          ).toEqual(
            fatal
              ? []
              : failFast
                ? [{ name: laneOrder[0], status: 3 }]
                : [
                    { name: laneOrder[0], status: 3 },
                    { name: laneOrder[1], status: 0 },
                  ],
          );
          expect(
            summary.failures.map(({ name, status }: { name: string; status: number }) => ({
              name,
              status,
            })),
          ).toEqual(fatal ? [] : [{ name: laneOrder[0], status: 3 }]);
          if (fatal) {
            expect(owner.stderr()).toContain("Docker lane process group did not stop");
          }
        },
        () => cleanupStaggerFixture(owner),
      );
    },
    30_000,
  );
  posixIt.each(["SIGINT", "SIGTERM"] as const)(
    "cancels the native stagger timer on %s in actual main",
    async (signal) => {
      const fixture = setupFixture("split", false, true, (prefix, root) =>
        mkdtempSync(path.join(root!, prefix)),
      );
      const leaderPath = path.join(fixture.root, "stagger-signal-leader.pid");
      const laneOrder = ["gateway-concurrency", "live-models"];
      configureSignalFixtureLanes(fixture, laneOrder);
      const timer = observeStaggerTimer(fixture);
      writeFileSync(
        path.join(fixture.selectedHarness, "marker.cjs"),
        [
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(fixture.marker)}, JSON.stringify({ lane: process.env.OPENCLAW_DOCKER_ALL_LANE_NAME }) + '\\n');`,
          "for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));",
          `fs.writeFileSync(${JSON.stringify(leaderPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const owner = startOwnedScheduler(
        fixture,
        {
          OPENCLAW_DOCKER_ALL_LANES: laneOrder.join(","),
          OPENCLAW_DOCKER_ALL_PARALLELISM: "2",
          OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT: "8",
          OPENCLAW_DOCKER_ALL_DOCKER_LIMIT: "8",
          OPENCLAW_DOCKER_ALL_LIVE_LIMIT: "4",
          OPENCLAW_DOCKER_ALL_LIVE_CLAUDE_LIMIT: "4",
          OPENCLAW_DOCKER_ALL_LIVE_GEMINI_LIMIT: "4",
          OPENCLAW_DOCKER_ALL_START_STAGGER_MS: "600000",
        },
        timer.probe,
        [leaderPath],
      );
      await runQaGatewayFixture(
        async () => {
          const schedulerPid = await owner.ready(timer.ready);
          const leaderPid = await owner.ready(leaderPath);
          owner.captureGroup(leaderPid);
          expect(owner.children()).toContainEqual({ owner: owner.shim.pid, pid: schedulerPid });
          owner.shim.kill(signal);
          await owner.ready(path.join(owner.events, signal));
          await waitForFixtureFile(timer.checkpoint, owner.result);
          expect(JSON.parse(readFileSync(timer.checkpoint, "utf8"))).toMatchObject({
            cleared: true,
            fired: false,
            fixtureReleased: false,
            started: [laneOrder[0]],
          });
          expect(await owner.result).toEqual({
            code: signal === "SIGINT" ? 130 : 143,
            signal: null,
          });
          expect(existsSync(path.join(fixture.root, "logs", `${laneOrder[1]}.log`))).toBe(false);
          const summary = JSON.parse(
            readFileSync(path.join(fixture.root, "logs/summary.json"), "utf8"),
          );
          expect(summary.selectedLanes).toEqual(laneOrder);
          expect(
            summary.lanes.map(({ name, status }: { name: string; status: number }) => ({
              name,
              status,
            })),
          ).toEqual([{ name: laneOrder[0], status: 0 }]);
          expect(isProcessAlive(leaderPid)).toBe(false);
        },
        () => cleanupStaggerFixture(owner),
      );
    },
    30_000,
  );

  posixIt.each(["ordinary", "signal-first"] as const)(
    "preserves %s cleanup-smoke command provenance",
    async (order) => {
      const fixture = setupFixture("split", false, true, (prefix, root) =>
        mkdtempSync(path.join(root!, prefix)),
      );
      const leaderPath = path.join(fixture.root, "cleanup-smoke.pid");
      const resultPath = path.join(fixture.root, "cleanup-smoke-result.json");
      const driver = path.join(fixture.harness, "cleanup-smoke-driver.mjs");
      writeFileSync(
        path.join(fixture.selectedHarness, "marker.cjs"),
        [
          "const fs = require('node:fs');",
          "for (const signal of ['SIGUSR1', 'SIGTERM']) process.on(signal, () => process.exit(3));",
          `fs.writeFileSync(${JSON.stringify(leaderPath)}, String(process.pid));`,
          "console.error('cleanup smoke failed intentionally');",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      writeFileSync(
        driver,
        [
          "import fs from 'node:fs';",
          "import { runCleanupSmokePhase } from './scripts/test-docker-all.mts';",
          "const phases = [];",
          "fs.mkdirSync(process.env.OPENCLAW_DOCKER_ALL_LOG_DIR, { recursive: true });",
          "const failure = await runCleanupSmokePhase(process.env, process.env.OPENCLAW_DOCKER_ALL_LOG_DIR, phases);",
          `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ failure, phases }));`,
        ].join("\n"),
      );
      const owner = startOwnedScheduler(fixture, {}, "", [leaderPath], driver);
      await runQaGatewayFixture(
        async () => {
          const leaderPid = await owner.ready(leaderPath);
          const group = owner.captureGroup(leaderPid);
          if (order === "signal-first") {
            owner.shim.kill("SIGTERM");
            expect(await owner.ready(path.join(owner.events, "SIGTERM"))).toBe(owner.shim.pid);
          } else {
            process.kill(leaderPid, "SIGUSR1");
          }
          expect(await owner.result).toEqual({
            code: order === "signal-first" ? 143 : 0,
            signal: null,
          });
          expect(
            JSON.parse(readFileSync(path.join(owner.events, `${group}.close`), "utf8")),
          ).toEqual(
            order === "signal-first"
              ? { code: null, signal: "SIGTERM" }
              : { code: 3, signal: null },
          );
          const { failure, phases } = JSON.parse(readFileSync(resultPath, "utf8"));
          expect(failure).toMatchObject({
            name: "cleanup-smoke",
            status: order === "signal-first" ? 128 : 3,
            targetable: false,
          });
          expect(failure.cancelled).toBe(order === "signal-first" ? true : undefined);
          expect(phases).toEqual([
            expect.objectContaining({ name: "cleanup-smoke", status: "failed" }),
          ]);
          expect(readFileSync(path.join(fixture.root, "logs/cleanup-smoke.log"), "utf8")).toContain(
            "cleanup smoke failed intentionally",
          );
          expect(isProcessAlive(leaderPid)).toBe(false);
        },
        () => owner.cleanup(),
      );
    },
    30_000,
  );

  posixIt.each([
    "unjoined cleanup",
    "ordinary command failure",
    "ordinary failure then unjoined cleanup",
  ] as const)(
    "preserves foreground admission ownership after %s in actual main",
    async (failure) => {
      // This process fixture releases its files only after owned children join.
      const fixture = setupFixture("split", false, true, (prefix, root) =>
        mkdtempSync(path.join(root!, prefix)),
      );
      const leaderPath = path.join(fixture.root, "foreground.pid");
      const leafPath = path.join(fixture.root, "leaf.pid");
      const groupPath = path.join(fixture.root, "group.pid");
      const unjoined = failure !== "ordinary command failure";
      const priorFailure = failure === "ordinary failure then unjoined cleanup";
      let leafPid: number | undefined;
      const leafScript = [
        "process.on('SIGTERM', () => {});",
        "process.on('SIGHUP', () => {});",
        `require('node:fs').writeFileSync(${JSON.stringify(leafPath)}, String(process.pid));`,
        "process.send('ready'); setInterval(() => {}, 1000);",
      ].join("\n");
      writeFileSync(
        path.join(fixture.selectedHarness, "marker.cjs"),
        [
          "const fs = require('node:fs');",
          `const phase = ${priorFailure} && process.argv[2] === 'package-image' ? process.env.OPENCLAW_DOCKER_E2E_TARGET : process.argv[2] ?? 'lane';`,
          `fs.appendFileSync(${JSON.stringify(fixture.marker)}, JSON.stringify({ phase }) + '\\n');`,
          ...(priorFailure ? ["if (phase === 'live-build') process.exit(3);"] : []),
          `if (phase === ${JSON.stringify(priorFailure ? "bare" : "live-build")}) {`,
          ...(unjoined
            ? [
                `fs.writeFileSync(${JSON.stringify(leaderPath)}, String(process.pid));`,
                "process.on('SIGUSR1', () => process.exit(0));",
                `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leafScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
                "child.once('message', () => child.disconnect()); child.unref();",
                "setInterval(() => {}, 1000);",
              ]
            : ["process.exit(3);"]),
          "}",
        ].join("\n"),
      );
      const owner = startOwnedScheduler(
        fixture,
        {
          OPENCLAW_DOCKER_ALL_BUILD: "1",
          OPENCLAW_DOCKER_ALL_LANES: (priorFailure
            ? [...laneNames, "cli-installer-distribution"]
            : laneNames
          ).join(","),
          OPENCLAW_DOCKER_ALL_START_STAGGER_MS: process.env.OPENCLAW_DOCKER_ALL_START_STAGGER_MS,
          OPENCLAW_DOCKER_ALL_STATUS_INTERVAL_MS:
            process.env.OPENCLAW_DOCKER_ALL_STATUS_INTERVAL_MS,
          OPENCLAW_DOCKER_ALL_LIVE_RETRIES: process.env.OPENCLAW_DOCKER_ALL_LIVE_RETRIES,
        },
        [
          "  const kill = process.kill.bind(process);",
          // A successful probe still permits Linux's zombie census to certify cleanup.
          // Deny inspection so the simulated failure survives the real descendant's exit.
          "  process.kill = (pid, signal) => {",
          `    if (signal === 0 && fs.existsSync(${JSON.stringify(groupPath)}) && pid === -Number(fs.readFileSync(${JSON.stringify(groupPath)}, 'utf8'))) {`,
          "      throw Object.assign(new Error('foreground cleanup probe denied'), { code: 'EPERM' });",
          "    }",
          "    return kill(pid, signal);",
          "  };",
        ].join("\n"),
        [leaderPath, leafPath],
      );
      await runQaGatewayFixture(
        async () => {
          if (unjoined) {
            leafPid = await owner.ready(leafPath);
            writeFileSync(groupPath, String(owner.captureGroup(leafPid)));
            const leader = await owner.ready(leaderPath);
            process.kill(leader, "SIGUSR1");
          }
          expect(await owner.result).toEqual({ code: unjoined ? 2 : 1, signal: null });
          if (leafPid) {
            expect(isProcessAlive(leafPid)).toBe(false);
          }
          const phases = readFileSync(fixture.marker, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line).phase);
          expect(phases).toEqual(
            priorFailure
              ? ["live-build", "bare"]
              : unjoined
                ? ["live-build"]
                : ["live-build", "package-image"],
          );
          expect(owner.stderr()).toContain(
            unjoined ? "Docker lane process group did not stop" : "shared live-test image once",
          );
          if (priorFailure) {
            const first = "shared live-test image once failed with status 3";
            const second = "Docker lane process group did not stop";
            expect(owner.stderr()).toContain(first);
            expect(owner.stderr().indexOf(first)).toBeLessThan(owner.stderr().indexOf(second));
          }
        },
        () => owner.cleanup(),
      );
    },
    30_000,
  );

  posixIt(
    "preserves prepared core dependencies without shared builds for a package-only lane",
    () => {
      const fixture = setupFixture("split", false, true);
      const { result } = runFixture(fixture, "split", ["docker-package-install"], {
        env: {
          OPENCLAW_CURRENT_PACKAGE_VERSION: "",
          OPENCLAW_CURRENT_PACKAGE_SHA256: "",
          OPENCLAW_DOCKER_ALL_BUILD: "1",
        },
      });

      expect(result.status, result.stdout + result.stderr).toBe(0);
      const calls = readFileSync(fixture.marker, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        lane: "docker-package-install",
        package: fixture.tarball,
        registry: fixture.registry,
        registryVersion: "2026.8.1",
        registrySha256: fixture.registrySha256,
        skipDockerBuild: "0",
      });
    },
  );

  posixIt.each([
    { failure: "timeout", attempts: 1, passed: false },
    { failure: "deterministic failure", attempts: 1, passed: false },
    { failure: "rate limited", attempts: 2, passed: true },
  ])("retries only diagnosed transient failures: $failure", ({ failure, attempts, passed }) => {
    const fixture = setupFixture("split");
    const catalog = path.join(fixture.harness, "scripts/lib/docker-e2e-scenarios.mts");
    // Keep the real scheduler and catalog policy, with a short fixture-only deadline.
    writeFileSync(
      catalog,
      readFileSync(catalog, "utf8").replace(
        "const LIVE_PROFILE_TIMEOUT_MS = 30 * 60 * 1000;",
        "const LIVE_PROFILE_TIMEOUT_MS = 1_000;",
      ),
    );
    const attemptLog = path.join(fixture.root, "attempts");
    const command = path.join(fixture.root, "live-attempt.cjs");
    writeFileSync(
      command,
      `const fs = require("node:fs");
const attemptLog = ${JSON.stringify(attemptLog)};
fs.appendFileSync(attemptLog, "attempt\\n");
const attempt = fs.readFileSync(attemptLog, "utf8").trim().split("\\n").length;
if (${JSON.stringify(failure)} === "timeout") {
  setInterval(() => {}, 1000);
} else if (attempt === 1) {
  console.error(${JSON.stringify(failure)});
  process.exitCode = 1;
}
`,
    );
    writeFileSync(
      path.join(fixture.harness, "scripts/test-live-models-docker.sh"),
      `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(command)}\n`,
    );
    const { result, logDir } = runFixture(
      fixture,
      "split",
      ["live-models", "gateway-concurrency"],
      {
        env: {
          OPENCLAW_DOCKER_ALL_LIVE_RETRIES: "1",
          OPENCLAW_DOCKER_ALL_FAIL_FAST: "0",
          OPENCLAW_DOCKER_ALL_PARALLELISM: "1",
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(passed ? 0 : 1);
    expect(readFileSync(attemptLog, "utf8").trim().split("\n")).toHaveLength(attempts);
    const summary = JSON.parse(readFileSync(path.join(logDir, "summary.json"), "utf8"));
    const live = summary.lanes.find((lane: { name: string }) => lane.name === "live-models");
    expect(live.attempts).toHaveLength(attempts);
    expect(live.timedOut).toBe(failure === "timeout");
    expect(
      summary.lanes.find((lane: { name: string }) => lane.name === "gateway-concurrency").status,
    ).toBe(0);
  });

  posixIt.each(["split", "override", "local"] as const)(
    "executes current scripts with the frozen candidate in %s mode",
    (mode) => {
      const fixture = setupFixture(mode, false, true);
      const { result, logDir } = runFixture(fixture, mode, laneNames, {
        env: {
          OPENCLAW_DOCKER_ALL_PNPM_COMMAND: path.relative(fixture.target, fixture.pinnedPnpm),
          OPENCLAW_DOCKER_CACHE_HOME_DIR: "relative cache",
          OPENCLAW_DOCKER_CLI_TOOLS_DIR: "relative tools",
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(fixture.poison)).toBe(false);
      const calls = readFileSync(fixture.marker, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.map((call) => call.lane).toSorted((a, b) => a.localeCompare(b))).toEqual(
        laneNames.toSorted((a, b) => a.localeCompare(b)),
      );
      for (const call of calls) {
        expect(call).toMatchObject({
          target: fixture.target,
          harness: fixture.selectedHarness,
          liveTarget: fixture.target,
          package: fixture.tarball,
          sha256: fixture.sha256,
          selectedSha: fixture.selectedSha,
          registry: fixture.registry,
          registryVersion: "2026.8.1",
          registrySha256: fixture.registrySha256,
          cache: path.join(fixture.target, "relative cache"),
          tools: path.join(fixture.target, "relative tools"),
        });
      }
      expect(calls.find((call) => call.lane === "gateway-network").cwd).toBe(
        fixture.selectedHarness,
      );
      expect(calls.find((call) => call.lane === "live-models").cwd).toBe(fixture.target);
      expect(calls.find((call) => call.lane === "gateway-concurrency").cwd).toBe(fixture.target);
      const summary = JSON.parse(readFileSync(path.join(logDir, "summary.json"), "utf8"));
      expect(summary.status).toBe("passed");
      expect(summary.lanes).toHaveLength(3);
      expect(JSON.parse(readFileSync(fixture.toolchainMarker, "utf8").trim())).toEqual({
        cwd: fixture.selectedHarness,
        selected: "pnpm@11.22.0",
        required: "pnpm@11.22.0",
      });
      if (mode === "override") {
        const rerun = spawnSync(
          "bash",
          [
            "-c",
            summary.lanes.find((lane: { name: string }) => lane.name === "gateway-network")
              .rerunCommand,
          ],
          {
            cwd: fixture.target,
            encoding: "utf8",
            timeout: 30_000,
            env: {
              ...process.env,
              OPENCLAW_DOCKER_ALL_LOG_DIR: path.join(fixture.root, "rerun logs"),
              OPENCLAW_DOCKER_ALL_TIMINGS: "0",
            },
          },
        );
        expect(rerun.status, rerun.stdout + rerun.stderr).toBe(0);
        const rerunCall = JSON.parse(
          readFileSync(fixture.marker, "utf8").trim().split("\n").at(-1)!,
        );
        expect(rerunCall).toMatchObject({
          lane: "gateway-network",
          cwd: fixture.selectedHarness,
          target: fixture.target,
          package: fixture.tarball,
          sha256: fixture.sha256,
          selectedSha: fixture.selectedSha,
          registry: fixture.registry,
          registrySha256: fixture.registrySha256,
        });
      }
    },
  );

  posixIt("runs a trusted package script absent from the frozen target", () => {
    const fixture = setupFixture("split", true);
    const { result } = runFixture(fixture, "split", ["gateway-network"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(fixture.poison)).toBe(false);
    expect(JSON.parse(readFileSync(fixture.marker, "utf8").trim()).lane).toBe("gateway-network");
  });
  posixIt("keeps preflight on the target while shared builds use trusted scripts", () => {
    const fixture = setupFixture("split");
    const bin = path.join(fixture.root, "bin");
    mkdirSync(bin);
    const dockerLog = path.join(fixture.root, "docker.jsonl");
    const docker = path.join(bin, "docker");
    writeFileSync(
      docker,
      `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
console.log('fixture-docker');
`,
    );
    chmodSync(docker, 0o755);
    const { result } = runFixture(fixture, "split", laneNames, {
      env: {
        OPENCLAW_DOCKER_ALL_BUILD: "1",
        OPENCLAW_DOCKER_ALL_PREFLIGHT: "1",
        OPENCLAW_DOCKER_ALL_PREFLIGHT_CLEANUP: "0",
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const dockerCalls = readFileSync(dockerLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(dockerCalls.map((call) => call.args[0])).toEqual(["version", "run"]);
    expect(dockerCalls.every((call) => call.cwd === fixture.target)).toBe(true);
    const builds = readFileSync(fixture.marker, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((call) => call.phase);
    expect(builds).toEqual([
      expect.objectContaining({
        phase: "live-build",
        cwd: fixture.target,
        liveTarget: fixture.target,
      }),
      expect.objectContaining({
        phase: "package-image",
        cwd: fixture.selectedHarness,
        target: fixture.target,
        package: fixture.tarball,
      }),
    ]);
  });

  posixIt("prepares target bytes through the trusted packer before any Docker work", () => {
    const fixture = setupFixture("split");
    const packedMarker = path.join(fixture.root, "packed-source");
    const targetPacker = path.join(fixture.target, "scripts/package-openclaw-for-docker.mjs");
    writeFileSync(targetPacker, "process.exit(47);\n");
    writeFileSync(
      path.join(fixture.harness, "scripts/package-openclaw-for-docker.mjs"),
      `
import fs from 'node:fs'; import path from 'node:path';
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
fs.writeFileSync(${JSON.stringify(packedMarker)}, value('--source-dir'));
fs.mkdirSync(value('--output-dir'), { recursive: true });
fs.copyFileSync(${JSON.stringify(fixture.tarball)}, path.join(value('--output-dir'), value('--output-name')));
`,
    );
    execFileSync("git", ["add", "."], { cwd: fixture.target });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture packers",
      ],
      { cwd: fixture.target },
    );
    const manifestPath = path.join(fixture.root, "candidate.json");
    const { result } = runFixture(fixture, "split", ["gateway-network"], {
      args: [`--prepare-only=${manifestPath}`],
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(packedMarker, "utf8")).toBe(fixture.target);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
      candidate: { package: { sha256: fixture.sha256, version: "2026.8.1" } },
    });
    expect(existsSync(fixture.marker)).toBe(false);
  });
});
