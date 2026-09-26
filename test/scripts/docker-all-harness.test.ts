import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import {
  isProcessAlive,
  waitForChildClose,
  waitForDead,
  waitForFile,
  waitForFixtureFile,
  waitForPidFile,
} from "../helpers/process-wait.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { quote, setupFixture } from "./docker-all-harness-fixture.test-support.js";
import { assertFixtureProcessGroupStopped } from "./exited-descendant-reaper.test-support.js";
import { toolingMtsEntrypoints } from "./tooling-mts-runtime.test-support.mts";

const posixIt = process.platform === "win32" ? it.skip : it;
const laneNames = ["gateway-network", "gateway-concurrency", "live-models"];

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

function observeCleanupClock() {
  const advances = [10_000, 1_000];
  const prefix = "DOCKER_CLEANUP_CLOCK ";
  function waitForReceipt(
    owner: ReturnType<typeof startOwnedScheduler>,
    event: "ready" | "advanced",
    step: number,
  ) {
    return new Promise<{ pid: number; advances: number[] }>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        owner.shim.stderr.off("data", check);
        reject(
          error instanceof Error
            ? error
            : new Error("Cleanup clock observation failed", { cause: error }),
        );
      };
      const check = () => {
        if (settled) {
          return;
        }
        try {
          for (const line of owner.stderr().split("\n").slice(0, -1)) {
            if (!line.startsWith(prefix)) {
              continue;
            }
            const receipt: { event: string; pid: number; step: number; advances: number[] } =
              JSON.parse(line.slice(prefix.length));
            if (receipt.event !== event || receipt.step !== step) {
              continue;
            }
            expect(receipt).toEqual({
              event,
              pid: receipt.pid,
              step,
              advances: advances.slice(0, step),
            });
            expect(owner.children()).toContainEqual({
              owner: owner.shim.pid,
              pid: receipt.pid,
            });
            settled = true;
            owner.shim.stderr.off("data", check);
            resolve(receipt);
            return;
          }
        } catch (error) {
          fail(error);
        }
      };
      owner.shim.stderr.on("data", check);
      void owner.result.then(() => {
        check();
        fail(new Error(`Scheduler exited before cleanup clock ${event} ${step}`));
      }, fail);
      check();
    });
  }
  return {
    // Keep native polling timers and signals; advance only after the denied
    // inspection reaches each production grace window in the owned scheduler.
    probe: `
      const cleanupClockAdvances = ${JSON.stringify(advances)};
      const cleanupClockNow = Date.now.bind(Date);
      let cleanupClockOffset = 0;
      let cleanupClockStep = 0;
      let cleanupClockWaiting = false;
      let cleanupClockDenied = false;
      let cleanupClockGroup;
      let cleanupClockForced = false;
      const cleanupClockReceipt = event => process.stderr.write('\\n' + ${JSON.stringify(prefix)} + JSON.stringify({
        event, pid: process.pid, step: cleanupClockStep,
        advances: cleanupClockAdvances.slice(0, cleanupClockStep),
      }) + '\\n');
      Date.now = () => cleanupClockNow() + cleanupClockOffset;
      const cleanupClockKill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (signal === 0) cleanupClockDenied = false;
        try { return cleanupClockKill(pid, signal); }
        catch (error) {
          if (signal === 0 && error.code === 'EPERM') {
            cleanupClockDenied = true;
            cleanupClockGroup ??= pid;
          }
          throw error;
        } finally {
          if (pid === cleanupClockGroup && signal === 'SIGKILL') cleanupClockForced = true;
        }
      };
      const cleanupClockTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (...args) => {
        const timer = cleanupClockTimeout(...args);
        const denied = cleanupClockDenied;
        cleanupClockDenied = false;
        if (denied && !cleanupClockWaiting && cleanupClockStep < cleanupClockAdvances.length) {
          if (cleanupClockStep === 1 && !cleanupClockForced) {
            throw new Error('cleanup clock reached its force-kill wait before forwarding SIGKILL');
          }
          cleanupClockWaiting = true;
          cleanupClockReceipt('ready');
        }
        return timer;
      };
      process.on('SIGUSR1', () => {
        if (!cleanupClockWaiting) throw new Error('cleanup clock advanced before its owner waited');
        cleanupClockOffset += cleanupClockAdvances[cleanupClockStep++];
        cleanupClockWaiting = false;
        cleanupClockReceipt('advanced');
      });
    `,
    async advance(owner: ReturnType<typeof startOwnedScheduler>) {
      for (let step = 0; step < advances.length; step += 1) {
        const ready = await waitForReceipt(owner, "ready", step);
        process.kill(ready.pid, "SIGUSR1");
        const advanced = await waitForReceipt(owner, "advanced", step + 1);
        if (step === advances.length - 1) {
          expect(advanced.advances).toEqual([10_000, 1_000]);
        }
      }
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
      const cleanupClock = fatal ? observeCleanupClock() : undefined;
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
        `${timer.probe}\n${probe}\n${cleanupClock?.probe ?? ""}`,
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
            await cleanupClock!.advance(owner);
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

  posixIt.each([
    "ordinary",
    "signal-first",
    "write error held close",
    "write and close errors",
  ] as const)(
    "preserves %s cleanup-smoke command provenance",
    async (order) => {
      const fixture = setupFixture("split", false, true, (prefix, root) =>
        mkdtempSync(path.join(root!, prefix)),
      );
      const leaderPath = path.join(fixture.root, "cleanup-smoke.pid");
      const resultPath = path.join(fixture.root, "cleanup-smoke-result.json");
      const statePath = path.join(fixture.root, "cleanup-smoke-log-state.json");
      const closeHeldPath = path.join(fixture.root, "cleanup-smoke-close-held.pid");
      const logFailure = order === "write error held close" || order === "write and close errors";
      const driver = path.join(fixture.harness, "cleanup-smoke-driver.mjs");
      writeFileSync(
        path.join(fixture.selectedHarness, "marker.cjs"),
        [
          "const fs = require('node:fs');",
          "for (const signal of ['SIGUSR1', 'SIGTERM']) process.on(signal, () => process.exit(3));",
          `fs.writeFileSync(${JSON.stringify(leaderPath)}, String(process.pid));`,
          "console.log('cleanup smoke retained stdout');",
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
          `const paths = ${JSON.stringify({ statePath, closeHeldPath, order, logFailure })};`,
          `
          const writeError = new Error('cleanup smoke late write failed');
          const closeError = new Error('cleanup smoke native close failed');
          const state = { returned: false, rejected: false, closed: false };
          const snapshot = () => {
            fs.writeFileSync(paths.statePath + '.pending', JSON.stringify({ ...state, phases }));
            fs.renameSync(paths.statePath + '.pending', paths.statePath);
          };
          if (paths.logFailure) {
            const nativeCreate = fs.createWriteStream.bind(fs);
            const nativeFs = { open: fs.open.bind(fs), write: fs.write.bind(fs), close: fs.close.bind(fs) };
            let release;
            let keepAlive;
            process.on('SIGUSR2', () => {
              clearInterval(keepAlive);
              const callback = release;
              release = undefined;
              callback?.();
            });
            fs.createWriteStream = (file, options) => {
              if (!String(file).endsWith('/cleanup-smoke.log')) return nativeCreate(file, options);
              const stream = nativeCreate(file, {
                ...options,
                fs: {
                  open: nativeFs.open,
                  write(fd, buffer, offset, length, position, callback) {
                    const late = buffer.toString('utf8', offset, offset + length).includes('finished:');
                    nativeFs.write(fd, buffer, offset, length, position, (error, bytes) => {
                      callback(error || (late ? writeError : null), bytes);
                    });
                  },
                  close(fd, callback) {
                    release = () => nativeFs.close(fd, error =>
                      callback(error || (paths.order === 'write and close errors' ? closeError : null)));
                    keepAlive = setInterval(() => {}, 1000);
                    snapshot();
                    fs.writeFileSync(paths.closeHeldPath, String(process.pid));
                  },
                },
              });
              stream.once('close', () => { state.closed = true; snapshot(); });
              return stream;
            };
          }
          `,
          "fs.mkdirSync(process.env.OPENCLAW_DOCKER_ALL_LOG_DIR, { recursive: true });",
          "try {",
          "const failure = await runCleanupSmokePhase(process.env, process.env.OPENCLAW_DOCKER_ALL_LOG_DIR, phases);",
          "state.returned = true; snapshot();",
          `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ failure, phases }));`,
          `} catch (error) {
            state.rejected = true;
            state.writeIdentity = error === writeError;
            state.aggregateIdentity = error instanceof AggregateError && error.errors.length === 2
              && error.errors[0] === writeError && error.errors[1] === closeError && error.cause === writeError;
            snapshot();
            throw error;
          }`,
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
          if (logFailure) {
            const controller = await owner.ready(closeHeldPath);
            expect(controller).toBe(owner.shim.pid);
            expect(isProcessAlive(controller)).toBe(true);
            expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
              returned: false,
              rejected: false,
              closed: false,
            });
            expect(existsSync(resultPath)).toBe(false);
            process.kill(controller, "SIGUSR2");
            expect(await owner.result).toEqual({ code: 1, signal: null });
            expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
              returned: false,
              rejected: true,
              closed: true,
              writeIdentity: order === "write error held close",
              aggregateIdentity: order === "write and close errors",
              phases: [expect.objectContaining({ name: "cleanup-smoke", status: "failed" })],
            });
            expect(existsSync(resultPath)).toBe(false);
            const log = readFileSync(path.join(fixture.root, "logs/cleanup-smoke.log"), "utf8");
            expect(log).toContain("cleanup smoke retained stdout");
            expect(log).toContain("cleanup smoke failed intentionally");
            expect(log).toContain("finished:");
            expect(owner.stderr()).toContain("cleanup smoke late write failed");
            if (order === "write and close errors") {
              expect(owner.stderr()).toContain("cleanup smoke native close failed");
            }
            expect(isProcessAlive(leaderPid)).toBe(false);
            return;
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
        async () => {
          if (existsSync(closeHeldPath)) {
            try {
              process.kill(Number(readFileSync(closeHeldPath, "utf8")), "SIGUSR2");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                throw error;
              }
            }
          }
          await owner.cleanup();
        },
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
      const cleanupClock = unjoined ? observeCleanupClock() : undefined;
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
          cleanupClock?.probe ?? "",
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
            await cleanupClock!.advance(owner);
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

  posixIt.each(["timeout", "deterministic failure", "rate limited", "ECONNRESET"])(
    "fails on the first lane outcome: %s",
    (failure) => {
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
            OPENCLAW_DOCKER_ALL_FAIL_FAST: "0",
            OPENCLAW_DOCKER_ALL_PARALLELISM: "1",
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(readFileSync(attemptLog, "utf8").trim().split("\n")).toHaveLength(1);
      const summary = JSON.parse(readFileSync(path.join(logDir, "summary.json"), "utf8"));
      const live = summary.lanes.find((lane: { name: string }) => lane.name === "live-models");
      expect(live.attempts).toHaveLength(1);
      expect(live.status).not.toBe(0);
      expect(live.timedOut).toBe(failure === "timeout");
      expect(
        summary.lanes.find((lane: { name: string }) => lane.name === "gateway-concurrency").status,
      ).toBe(0);
    },
  );

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

describe("Docker scheduler publication settlement", () => {
  posixIt.each([
    "delayed close",
    "repeated signals after group join",
    "write error held close",
    "open failure",
    "premature destroy",
    "write and close errors",
    "tree and log errors",
    "cancel pending open",
    "tree error fences admission",
    "log error fences admission",
    "shutdown-only sibling cleanup error",
    "sibling log errors",
  ] as const)(
    "joins the native log owner with %s",
    async (mode) => {
      const fixture = setupFixture("split");
      const statePath = path.join(fixture.root, "log-state.json");
      const readyPath = path.join(fixture.root, "log-held.pid");
      const checkpoint = path.join(fixture.root, "command-checkpoint");
      const summaryPath = path.join(fixture.root, "logs", "summary.json");
      const treeReady = path.join(fixture.root, "tree-final-verification");
      const fence = mode === "tree error fences admission" || mode === "log error fences admission";
      const shutdownOnly = mode === "shutdown-only sibling cleanup error";
      const siblingLogs = mode === "sibling log errors";
      const cleanupClock =
        mode === "tree and log errors" || mode === "tree error fences admission" || shutdownOnly
          ? observeCleanupClock()
          : undefined;
      if (siblingLogs) {
        const marker = path.join(fixture.selectedHarness, "marker.cjs");
        writeFileSync(
          marker,
          `${readFileSync(marker, "utf8")}\nconsole.log('lane stdout ' + process.env.OPENCLAW_DOCKER_ALL_LANE_NAME); console.error('lane stderr ' + process.env.OPENCLAW_DOCKER_ALL_LANE_NAME);\n`,
        );
      }
      const timer = observeStaggerTimer(fixture);
      const probe = `
      const paths = ${JSON.stringify({ mode, statePath, readyPath, checkpoint, treeReady, fence, shutdownOnly, siblingLogs })};
      const nativeFs = { open: fs.open.bind(fs), write: fs.write.bind(fs), close: fs.close.bind(fs) };
      const nativeCreate = fs.createWriteStream.bind(fs);
      const nativePublication = fs.promises.writeFile.bind(fs.promises);
      const writeError = new Error('owned late log write failed');
      const closeError = new Error('owned log close failed');
      const openError = new Error('owned log open failed');
      const siblingWriteError = new Error('sibling log write failed');
      const siblingCloseError = new Error('sibling log close failed');
      const state = { finished: false, closed: false, siblingClosed: false, summaryStarted: false, writeIdentity: false, closeIdentity: false, siblingIdentity: false, poolIdentity: false, poolClosed: false, treePrimary: false, destroyedIdentity: false, prematureIdentity: false, groupSignals: [], termTurns: 0 };
      const destroyedErrors = [];
      let siblingPid;
      let primaryWrite;
      let siblingError;
      const snapshot = () => {
        fs.writeFileSync(paths.statePath + '.pending', JSON.stringify(state));
        fs.renameSync(paths.statePath + '.pending', paths.statePath);
      };
      let release;
      let keepAlive;
      let held = false;
      process.on('SIGUSR2', () => {
        clearInterval(keepAlive);
        const callback = release;
        release = undefined;
        callback?.();
      });
      const hold = callback => {
        held = true;
        release = callback;
        keepAlive = setInterval(() => {}, 1000);
        snapshot();
        fs.writeFileSync(paths.readyPath, String(process.pid));
        if (paths.fence) checkpointStagger();
      };
      fs.promises.writeFile = (...args) => {
        if (String(args[0]).endsWith('/summary.json')) {
          state.summaryStarted = true;
          snapshot();
        }
        return nativePublication(...args);
      };
      const NativeAggregateError = globalThis.AggregateError;
      globalThis.AggregateError = class extends NativeAggregateError {
        constructor(errors, ...args) {
          const values = Array.from(errors);
          super(values, ...args);
          state.writeIdentity ||= values.includes(writeError);
          state.closeIdentity ||= values.includes(closeError);
          state.treePrimary ||= values[0]?.code === 'EPROCESSGROUP_CLEANUP_FAILED' && values.includes(writeError);
          if (paths.siblingLogs) {
            if (values.length === 2 && values[0] === siblingWriteError && values[1] === siblingCloseError) {
              siblingError = this;
              state.siblingIdentity = this.cause === siblingWriteError;
            }
            if (values[0] === writeError) {
              state.poolIdentity = values.length === 2 && values[1] === siblingError && this.cause === writeError;
              state.poolClosed = state.closed && state.siblingClosed;
            }
          }
          if (paths.mode === 'premature destroy') {
            state.destroyedIdentity = destroyedErrors.length >= 2 && new Set(destroyedErrors).size === destroyedErrors.length && destroyedErrors.every((error, index) => error.code === 'ERR_STREAM_DESTROYED' && values[index] === error) && this.cause === destroyedErrors[0];
            state.prematureIdentity = values.length === destroyedErrors.length + 1 && values.at(-1)?.code === 'ERR_STREAM_PREMATURE_CLOSE' && !destroyedErrors.includes(values.at(-1));
          }
          snapshot();
        }
      };
      const nativeSpawn = cp.spawn;
      const commandPids = new Set();
      cp.spawn = (...args) => {
        const child = nativeSpawn(...args);
        if (args[0] === 'bash' && child.pid) {
          commandPids.add(child.pid);
          if (paths.shutdownOnly && args[2]?.env?.OPENCLAW_DOCKER_ALL_LANE_NAME === 'live-models') {
            siblingPid = child.pid;
            clearInterval(keepAlive);
            const callback = release;
            release = undefined;
            // Let spawn return so the scheduler registers the sibling's ownership.
            if (callback) queueMicrotask(callback);
          }
          child.once('close', () => setImmediate(() => {
            snapshot();
            if (!paths.siblingLogs) fs.writeFileSync(paths.checkpoint, 'closed');
          }));
        }
        return child;
      };
      const nativeKill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (paths.shutdownOnly && signal === 0 && pid === -siblingPid) {
          throw Object.assign(new Error('sibling cleanup probe denied'), { code: 'EPERM' });
        }
        if (held && signal && commandPids.has(-pid)) {
          state.groupSignals.push({ pid, signal });
          snapshot();
        }
        if (['tree and log errors', 'tree error fences admission'].includes(paths.mode) && signal === 0 && commandPids.has(-pid)) {
          const stack = new Error().stack ?? '';
          if (paths.fence && !stack.includes('shellProcessGroupAlive') && !stack.includes('waitForManagedProcessGroupExit')) {
            fs.writeFileSync(paths.treeReady, 'final-verification');
          }
          throw Object.assign(new Error('command cleanup probe denied'), { code: 'EPERM' });
        }
        return nativeKill(pid, signal);
      };
      if (paths.mode === 'repeated signals after group join') {
        process.on('SIGTERM', () => setImmediate(() => {
          state.termTurns += 1;
          snapshot();
          fs.writeFileSync(paths.checkpoint + '.term-' + state.termTurns, 'handled');
        }));
      }
      fs.createWriteStream = (file, options) => {
        const sibling = paths.siblingLogs && String(file).endsWith('/live-models.log');
        if (!String(file).endsWith('/gateway-concurrency.log') && !sibling) return nativeCreate(file, options);
        const stream = nativeCreate(file, {
          ...options,
          fs: {
            open(file, flags, mode, callback) {
              if (paths.mode === 'open failure') {
                queueMicrotask(() => callback(openError));
                return;
              }
              nativeFs.open(file, flags, mode, (error, fd) => {
                if (paths.mode === 'cancel pending open' && !error) hold(() => callback(error, fd));
                else callback(error, fd);
              });
            },
            write(fd, buffer, offset, length, position, callback) {
              const late = buffer.toString('utf8', offset, offset + length).includes('finished:');
              nativeFs.write(fd, buffer, offset, length, position, (error, bytes) => {
                const complete = () => callback(error || (late && (paths.siblingLogs || ['write error held close', 'write and close errors', 'tree and log errors', 'log error fences admission', 'shutdown-only sibling cleanup error'].includes(paths.mode)) ? (sibling ? siblingWriteError : writeError) : null), bytes);
                if (paths.siblingLogs && late) {
                  // Both commands and their real footer writes precede the first failure.
                  if (sibling) {
                    hold(complete);
                    const primary = primaryWrite;
                    primaryWrite = undefined;
                    primary?.();
                  } else if (held) complete();
                  else primaryWrite = complete;
                  return;
                }
                // The primary log failure must observe an already admitted sibling.
                if (paths.shutdownOnly && late && !siblingPid) hold(complete);
                else complete();
              });
            },
            close(fd, callback) {
              const close = () => nativeFs.close(fd, error =>
                callback(error || (sibling ? siblingCloseError : paths.mode === 'write and close errors' ? closeError : null)));
              if (['delayed close', 'repeated signals after group join', 'write error held close', 'tree error fences admission', 'log error fences admission'].includes(paths.mode)) hold(close);
              else close();
            },
          },
        });
        stream.on('finish', () => { state.finished = true; snapshot(); });
        stream.on('error', () => snapshot());
        stream.on('close', () => {
          if (sibling) state.siblingClosed = true;
          else state.closed = true;
          snapshot();
          if (paths.siblingLogs && !sibling) fs.writeFileSync(paths.checkpoint, 'primary-log-closed');
        });
        if (paths.mode === 'premature destroy') {
          const nativeWrite = stream.write.bind(stream);
          stream.write = (chunk, callback) => nativeWrite(chunk, error => {
            if (error) destroyedErrors.push(error);
            callback(error);
          });
          stream.once('open', () => stream.destroy());
        }
        return stream;
      };
      syncBuiltinESMExports();
    `;
      const owner = startOwnedScheduler(
        fixture,
        {
          OPENCLAW_DOCKER_ALL_LANES:
            fence || shutdownOnly || siblingLogs
              ? "gateway-concurrency,live-models"
              : "gateway-concurrency",
          OPENCLAW_DOCKER_ALL_RUN_ID: "owned-log-invocation",
          ...(fence || shutdownOnly || siblingLogs
            ? {
                OPENCLAW_DOCKER_ALL_PARALLELISM: "2",
                OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT: "8",
                OPENCLAW_DOCKER_ALL_DOCKER_LIMIT: "8",
                OPENCLAW_DOCKER_ALL_LIVE_LIMIT: "4",
                OPENCLAW_DOCKER_ALL_LIVE_CLAUDE_LIMIT: "4",
                OPENCLAW_DOCKER_ALL_LIVE_GEMINI_LIMIT: "4",
                OPENCLAW_DOCKER_ALL_START_STAGGER_MS: fence ? "600000" : "0",
              }
            : {}),
        },
        `${fence ? timer.probe : ""}\n${probe}\n${cleanupClock?.probe ?? ""}`,
      );
      await runQaGatewayFixture(
        async () => {
          await cleanupClock?.advance(owner);
          const held = [
            "delayed close",
            "repeated signals after group join",
            "write error held close",
            "cancel pending open",
            "tree error fences admission",
            "log error fences admission",
            "sibling log errors",
          ].includes(mode);
          if (held) {
            if (fence) {
              await owner.ready(timer.ready);
            }
            if (mode === "tree error fences admission") {
              await waitForFixtureFile(treeReady, owner.result, "final-verification");
            }
            const schedulerPid = await owner.ready(readyPath);
            if (siblingLogs) {
              await waitForFixtureFile(checkpoint, owner.result, "primary-log-closed");
            } else {
              await waitForFile(checkpoint, 5_000);
            }
            const state = JSON.parse(readFileSync(statePath, "utf8"));
            expect(state.closed).toBe(siblingLogs);
            expect(state.summaryStarted).toBe(false);
            expect(owner.shim.exitCode).toBeNull();
            if (siblingLogs) {
              expect(state.siblingClosed).toBe(false);
              expect(existsSync(summaryPath)).toBe(false);
              const commands = owner
                .children()
                .filter(({ owner: commandOwner }) => commandOwner === schedulerPid);
              expect(commands).toHaveLength(2);
              for (const { pid } of commands) {
                await waitForFile(path.join(owner.events, `${pid}.close`), 5_000);
              }
            }
            if (fence) {
              await waitForFixtureFile(timer.checkpoint, owner.result);
              expect(JSON.parse(readFileSync(timer.checkpoint, "utf8"))).toMatchObject({
                cleared: true,
                fired: false,
                fixtureReleased: false,
                started: ["gateway-concurrency"],
              });
              expect(existsSync(summaryPath)).toBe(false);
              expect(existsSync(path.join(fixture.root, "logs/live-models.log"))).toBe(false);
            }
            if (mode === "cancel pending open") {
              owner.shim.kill("SIGTERM");
              await waitForFile(path.join(owner.events, "SIGTERM"), 5_000);
            }
            if (mode === "repeated signals after group join") {
              const commands = owner
                .children()
                .filter(({ owner: commandOwner }) => commandOwner === schedulerPid);
              expect(commands).toHaveLength(1);
              assertFixtureProcessGroupStopped(commands[0]!.pid);
              for (let turn = 1; turn <= 2; turn += 1) {
                process.kill(schedulerPid, "SIGTERM");
                await waitForFile(checkpoint + ".term-" + turn, 5_000);
                expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
                  termTurns: turn,
                  groupSignals: [],
                  closed: false,
                  summaryStarted: false,
                });
                expect(owner.shim.exitCode).toBeNull();
              }
            }
            process.kill(schedulerPid, "SIGUSR2");
          }
          const expected =
            mode === "delayed close"
              ? 0
              : mode === "cancel pending open" || mode === "repeated signals after group join"
                ? 143
                : mode === "tree and log errors" ||
                    mode === "tree error fences admission" ||
                    shutdownOnly
                  ? 2
                  : 1;
          expect(await owner.result, owner.stderr()).toEqual({ code: expected, signal: null });
          const state = JSON.parse(readFileSync(statePath, "utf8"));
          expect(state.closed).toBe(true);
          const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
          expect(summary.runId).toBe("owned-log-invocation");
          expect(Array.isArray(summary.lanes)).toBe(true);
          expect(summary.status).toBe(expected === 0 ? "passed" : "failed");
          if (expected === 0 || expected === 143) {
            expect(summary.cleanup).toEqual({ joined: true });
          } else {
            expect(summary).not.toHaveProperty("cleanup");
            expect(owner.stderr()).toContain(
              mode === "open failure"
                ? "owned log open failed"
                : mode === "premature destroy"
                  ? "Premature close"
                  : mode === "tree and log errors" || mode === "tree error fences admission"
                    ? "Docker lane process group did not stop"
                    : mode === "write and close errors"
                      ? "log publication failed"
                      : "owned late log write failed",
            );
          }
          if (mode === "write and close errors") {
            expect(state).toMatchObject({ writeIdentity: true, closeIdentity: true });
          } else if (mode === "tree and log errors") {
            expect(state.treePrimary).toBe(true);
          }
          if (mode === "premature destroy") {
            expect(state).toMatchObject({ destroyedIdentity: true, prematureIdentity: true });
          }
          if (shutdownOnly) {
            const primary = "owned late log write failed";
            const cleanup = "Docker lane process group did not stop";
            expect(owner.stderr()).toContain(cleanup);
            expect(owner.stderr().indexOf(primary)).toBeLessThan(owner.stderr().indexOf(cleanup));
          }
          if (siblingLogs) {
            expect(state).toMatchObject({
              siblingClosed: true,
              siblingIdentity: true,
              poolIdentity: true,
              poolClosed: true,
            });
            expect(summary.lanes).toEqual([]);
            const diagnostics = [
              "owned late log write failed",
              "sibling log write failed",
              "sibling log close failed",
            ];
            for (const message of diagnostics) {
              expect(owner.stderr()).toContain(message);
            }
            expect(owner.stderr().indexOf(diagnostics[0]!)).toBeLessThan(
              owner.stderr().indexOf(diagnostics[1]!),
            );
            expect(owner.stderr().indexOf(diagnostics[1]!)).toBeLessThan(
              owner.stderr().indexOf(diagnostics[2]!),
            );
            for (const lane of ["gateway-concurrency", "live-models"]) {
              const log = readFileSync(path.join(fixture.root, `logs/${lane}.log`), "utf8");
              expect(log).toContain(`lane stdout ${lane}`);
              expect(log).toContain(`lane stderr ${lane}`);
              expect(log).toContain("finished:");
            }
          }
          if (fence) {
            expect(JSON.parse(readFileSync(timer.settled, "utf8"))).toMatchObject({
              cleared: true,
              fired: false,
              fixtureReleased: false,
              started: ["gateway-concurrency"],
            });
            expect(summary.lanes).toEqual([]);
            expect(existsSync(path.join(fixture.root, "logs/live-models.log"))).toBe(false);
          }
          for (const { pid } of owner.children()) {
            expect(isProcessAlive(pid)).toBe(false);
            if (siblingLogs) {
              assertFixtureProcessGroupStopped(pid);
            }
          }
        },
        async () => {
          if (existsSync(readyPath)) {
            try {
              process.kill(Number(readFileSync(readyPath, "utf8")), "SIGUSR2");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                throw error;
              }
            }
          }
          await owner.cleanup();
        },
      );
    },
    30_000,
  );

  posixIt("reports original terminal error graphs before final publication", async () => {
    const fixture = setupFixture("split");
    const receiptPath = path.join(fixture.root, "terminal-errors.json");
    const summaryPath = path.join(fixture.root, "logs", "summary.json");
    const probe = `
      const receiptPath = ${JSON.stringify(receiptPath)};
      const reads = [];
      let publicationReads;
      const snapshot = () => fs.writeFileSync(receiptPath, JSON.stringify({ reads, publicationReads }));
      const member = label => {
        const error = Object.assign(new Error('same terminal failure'), { code: 'EFIXTURE' });
        Object.defineProperty(error, 'message', { get() {
          reads.push(label);
          snapshot();
          return 'same terminal failure';
        } });
        return error;
      };
      const first = member('first');
      const second = member('second');
      const cause = new Error('owned terminal cause');
      const root = new AggregateError([first, second, undefined, 'owned non-Error failure'], 'owned terminal graph', { cause });
      first.cause = root;
      second.error = second;
      cause.error = first;
      const nativeMkdir = fs.promises.mkdir.bind(fs.promises);
      let rejected = false;
      fs.promises.mkdir = (...args) => {
        if (!rejected && String(args[0]) === ${JSON.stringify(path.join(fixture.root, "logs"))}) {
          rejected = true;
          return Promise.reject(root);
        }
        return nativeMkdir(...args);
      };
      const nativeWrite = fs.promises.writeFile.bind(fs.promises);
      fs.promises.writeFile = (...args) => {
        if (String(args[0]) === ${JSON.stringify(summaryPath)}) {
          publicationReads = [...reads];
          snapshot();
        }
        return nativeWrite(...args);
      };
      syncBuiltinESMExports();
    `;
    const owner = startOwnedScheduler(fixture, {}, probe);
    await runQaGatewayFixture(
      async () => {
        expect(await owner.result, owner.stderr()).toEqual({ code: 1, signal: null });
        expect(owner.stderr()).toBe(
          [
            "owned terminal graph",
            "same terminal failure",
            "same terminal failure",
            "undefined",
            "owned non-Error failure",
            "owned terminal cause",
            "",
          ].join("\n"),
        );
        expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual({
          reads: ["first", "second"],
          publicationReads: ["first", "second"],
        });
        const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
        expect(summary).toMatchObject({ status: "failed", lanes: [] });
        expect(summary).not.toHaveProperty("cleanup");
        expect(existsSync(fixture.marker)).toBe(false);
        for (const { pid } of owner.children()) {
          expect(isProcessAlive(pid)).toBe(false);
        }
      },
      () => owner.cleanup(),
    );
  });

  posixIt.each([
    { signal: "SIGINT", code: 130, phase: "raw summary" },
    { signal: "SIGTERM", code: 143, phase: "raw summary" },
    { signal: "SIGINT", code: 130, phase: "staging close" },
    { signal: "SIGTERM", code: 143, phase: "staging close" },
    { signal: "SIGINT", code: 130, phase: "committed" },
    { signal: "SIGTERM", code: 143, phase: "committed" },
  ] as const)(
    "orders $signal at $phase against terminal publication",
    async ({ signal, code, phase }) => {
      const fixture = setupFixture("split");
      const ready = path.join(fixture.root, "publication-held.pid");
      const handled = path.join(fixture.root, "publication-signal.pid");
      const summaryPath = path.join(fixture.root, "logs", "summary.json");
      const indexPath = path.join(fixture.root, "logs", "failures.json");
      const probe = `
        const phase = ${JSON.stringify(phase)};
        let release;
        let keepAlive;
        const hold = () => new Promise(resolve => {
          release = resolve;
          keepAlive = setInterval(() => {}, 1000);
          fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        });
        process.on('SIGUSR2', () => {
          clearInterval(keepAlive);
          release?.();
        });
        process.on(${JSON.stringify(signal)}, () => setImmediate(() =>
          fs.writeFileSync(${JSON.stringify(handled)}, String(process.pid))));
        const nativeWrite = fs.promises.writeFile.bind(fs.promises);
        fs.promises.writeFile = async (...args) => {
          const result = await nativeWrite(...args);
          if (phase === 'raw summary' && String(args[0]) === ${JSON.stringify(summaryPath)}) await hold();
          return result;
        };
        const nativeOpen = fs.promises.open.bind(fs.promises);
        fs.promises.open = async (...args) => {
          const handle = await nativeOpen(...args);
          if (phase === 'staging close' && String(args[0]).includes('/.summary-')) {
            const close = handle.close.bind(handle);
            handle.close = async () => { await close(); await hold(); };
          }
          return handle;
        };
        const nativeRename = fs.renameSync.bind(fs);
        fs.renameSync = (...args) => {
          const result = nativeRename(...args);
          if (phase === 'committed' && String(args[0]).includes('/.summary-')) void hold();
          return result;
        };
        syncBuiltinESMExports();
      `;
      const owner = startOwnedScheduler(
        fixture,
        {
          OPENCLAW_DOCKER_ALL_LANES: "gateway-concurrency",
          OPENCLAW_DOCKER_ALL_RUN_ID: "publication-signal-invocation",
        },
        probe,
      );
      await runQaGatewayFixture(
        async () => {
          const schedulerPid = await owner.ready(ready);
          expect(owner.children().some(({ pid }) => pid === schedulerPid)).toBe(true);
          const before = readFileSync(summaryPath, "utf8");
          const indexBefore = phase === "committed" ? readFileSync(indexPath, "utf8") : undefined;
          if (phase === "committed") {
            expect(JSON.parse(before)).toMatchObject({
              status: "passed",
              cleanup: { joined: true },
            });
          } else {
            expect(JSON.parse(before)).not.toHaveProperty("cleanup");
            expect(JSON.parse(before).status).toBe("failed");
          }
          process.kill(schedulerPid, signal);
          expect(await owner.ready(handled)).toBe(schedulerPid);
          expect(owner.shim.exitCode).toBeNull();
          expect(readFileSync(summaryPath, "utf8")).toBe(before);
          process.kill(schedulerPid, "SIGUSR2");
          expect(await owner.result, owner.stderr()).toEqual({ code, signal: null });
          const summary = readFileSync(summaryPath, "utf8");
          const index = readFileSync(indexPath, "utf8");
          const status = phase === "committed" ? "passed" : "failed";
          expect(JSON.parse(summary)).toMatchObject({
            status,
            runId: "publication-signal-invocation",
            cleanup: { joined: true },
            lanes: [expect.objectContaining({ name: "gateway-concurrency", status: 0 })],
          });
          expect(JSON.parse(index)).not.toHaveProperty("status");
          if (phase === "committed") {
            expect(summary).toBe(before);
            expect(index).toBe(indexBefore);
          }
          expect(
            readdirSync(path.dirname(summaryPath)).filter((name) => name.startsWith(".summary-")),
          ).toEqual([]);
          for (const { pid } of owner.children()) {
            expect(isProcessAlive(pid)).toBe(false);
            assertFixtureProcessGroupStopped(pid);
          }
        },
        () => cleanupStaggerFixture(owner),
      );
    },
    30_000,
  );

  posixIt.each([
    "initial log directory",
    "failure index",
    "final failure index",
    "cancelled summary",
    "late timing",
    "staging close",
    "rename",
    "staging cleanup",
  ] as const)(
    "never publishes an affirmative summary after %s failure",
    async (mode) => {
      const fixture = setupFixture("split");
      const receiptPath = path.join(fixture.root, "publication-errors.json");
      const probe = `
        const mode = ${JSON.stringify(mode)};
        const receiptPath = ${JSON.stringify(receiptPath)};
        const primary = new Error('owned publication failed: ' + mode);
        const cleanup = new Error('owned staging unlink failed');
        const identity = { primary: false, cleanup: false, cause: false, mkdirAttempts: 0 };
        const snapshot = () => fs.writeFileSync(receiptPath, JSON.stringify(identity));
        const message = primary.message;
        // Observe the original error when diagnostics read it, without replacing it.
        Object.defineProperty(primary, 'message', { get() {
          identity.primary = true;
          snapshot();
          return message;
        } });
        const nativeWrite = fs.promises.writeFile.bind(fs.promises);
        const nativeSyncWrite = fs.writeFileSync.bind(fs);
        const nativeMkdir = fs.promises.mkdir.bind(fs.promises);
        const nativeOpen = fs.promises.open.bind(fs.promises);
        const nativeRename = fs.renameSync.bind(fs);
        const nativeRm = fs.promises.rm.bind(fs.promises);
        fs.promises.mkdir = (...args) => {
          if (mode === 'initial log directory' && String(args[0]) === ${JSON.stringify(path.join(fixture.root, "logs"))}) {
            identity.mkdirAttempts += 1;
            snapshot();
            if (identity.mkdirAttempts === 1) return Promise.reject(primary);
          }
          return nativeMkdir(...args);
        };
        fs.promises.writeFile = (...args) => {
          const file = String(args[0]);
          if ((mode === 'failure index' && file.endsWith('/failures.json')) ||
              (mode === 'late timing' && file.endsWith('/timings.json'))) return Promise.reject(primary);
          return nativeWrite(...args);
        };
        fs.writeFileSync = (...args) => {
          const file = String(args[0]);
          if ((mode === 'final failure index' && file.endsWith('/failures.json')) ||
              (mode === 'cancelled summary' && file.includes('/.summary-'))) throw primary;
          return nativeSyncWrite(...args);
        };
        fs.promises.open = async (...args) => {
          const handle = await nativeOpen(...args);
          if (String(args[0]).includes('/.summary-') && ['staging close', 'staging cleanup'].includes(mode)) {
            const close = handle.close.bind(handle);
            handle.close = async () => { await close(); throw primary; };
          }
          if (String(args[0]).includes('/.summary-') && mode === 'cancelled summary') {
            const close = handle.close.bind(handle);
            handle.close = async () => {
              await close();
              const keepAlive = setInterval(() => {}, 1000);
              try {
                const handled = new Promise(resolve => process.once('SIGTERM', resolve));
                process.kill(process.pid, 'SIGTERM');
                await handled;
              } finally { clearInterval(keepAlive); }
            };
          }
          return handle;
        };
        fs.renameSync = (...args) => {
          if (mode === 'rename' && String(args[0]).includes('/.summary-')) throw primary;
          return nativeRename(...args);
        };
        fs.promises.rm = (...args) => mode === 'staging cleanup' && String(args[0]).includes('/.summary-')
          ? Promise.reject(cleanup) : nativeRm(...args);
        const NativeAggregateError = globalThis.AggregateError;
        globalThis.AggregateError = class extends NativeAggregateError {
          constructor(errors, ...args) {
            const values = Array.from(errors);
            super(values, ...args);
            identity.primary ||= values[0] === primary;
            identity.cleanup ||= values[1] === cleanup;
            identity.cause ||= this.cause === primary;
            snapshot();
          }
        };
        syncBuiltinESMExports();
      `;
      const owner = startOwnedScheduler(
        fixture,
        {
          OPENCLAW_DOCKER_ALL_LANES: "gateway-concurrency",
          OPENCLAW_DOCKER_ALL_RUN_ID: "owned-publication-invocation",
          OPENCLAW_DOCKER_ALL_TIMINGS: mode === "late timing" ? "1" : "0",
          OPENCLAW_DOCKER_ALL_TIMINGS_FILE: path.join(fixture.root, "timings.json"),
        },
        probe,
      );
      await runQaGatewayFixture(
        async () => {
          expect(await owner.result, owner.stderr()).toEqual({ code: 1, signal: null });
          const summaryPath = path.join(fixture.root, "logs", "summary.json");
          const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
          expect(summary).not.toHaveProperty("cleanup");
          expect(summary.status).toBe("failed");
          expect(summary.runId).toBe("owned-publication-invocation");
          expect(summary.lanes).toEqual(
            mode === "initial log directory"
              ? []
              : [expect.objectContaining({ name: "gateway-concurrency", status: 0 })],
          );
          if (mode === "staging close" || mode === "rename") {
            expect(
              JSON.parse(readFileSync(path.join(fixture.root, "logs", "failures.json"), "utf8")),
            ).not.toHaveProperty("status");
            for (const [entrypoint, args, expected] of [
              [
                toolingMtsEntrypoints.dockerSummary,
                ["summary", summaryPath, "Docker scheduler"],
                "Status: `failed`",
              ],
              [toolingMtsEntrypoints.dockerTimings, [summaryPath], "Status: failed"],
            ] as const) {
              const output = execFileSync(
                process.execPath,
                [...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(entrypoint)), ...args],
                { encoding: "utf8", timeout: 10_000 },
              );
              expect(output).toContain(expected);
            }
          }
          expect(owner.stderr()).toContain(
            mode === "staging cleanup"
              ? "Docker summary staging cleanup failed"
              : "owned publication failed: " + mode,
          );
          expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual({
            primary: true,
            cleanup: mode === "staging cleanup",
            cause: mode === "staging cleanup",
            mkdirAttempts: mode === "initial log directory" ? 2 : 0,
          });
          expect(
            readdirSync(path.join(fixture.root, "logs")).filter((name) =>
              name.startsWith(".summary-"),
            ),
          ).toHaveLength(mode === "staging cleanup" ? 1 : 0);
          for (const { pid } of owner.children()) {
            expect(isProcessAlive(pid)).toBe(false);
          }
        },
        () => owner.cleanup(),
      );
    },
    30_000,
  );
});
