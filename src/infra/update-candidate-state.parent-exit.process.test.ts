import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { runtimeProcessScriptEntrypoints } from "./runtime-process-manifest.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { runUpdateStateInspectionWorker } from "./update-candidate-state.inspection.js";
import {
  createStateInspectionScope,
  runStateInspectionCommand,
  withStateInspectionStaging,
  withUpdateStateInspectionWork,
} from "./update-candidate-state.process.js";

it.for([
  { mode: "sqlite-generations", parentOwned: false },
  { mode: "database-generations", parentOwned: false },
  { mode: "sqlite-generations", parentOwned: true },
  { mode: "database-generations", parentOwned: true },
] as const)(
  "shares staging within one %s command and retires it before returning",
  async ({ mode, parentOwned }, { expect, signal, onTestFinished, skip }) => {
    if (parentOwned && process.platform === "win32") {
      skip(); // The observer executable uses a POSIX shell wrapper.
    }
    const fixture = createFixtureLifetime();
    onTestFinished(() => fixture.cleanup());
    await fixture.run(async () => {
      const root = fixture.createTempDir("update-generation-command-");
      const paths = Array.from({ length: 6 }, (_, index) => path.join(root, `${index}.sqlite`));
      for (const file of paths) {
        using db = new DatabaseSync(file);
        db.exec("CREATE TABLE evidence(value); INSERT INTO evidence VALUES(7)");
      }
      const original = paths.map((file) => fs.readFileSync(file));
      const events = path.join(root, "workers");
      fs.writeFileSync(events, "");
      const worker = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState);
      const observer = new URL("./worker-request-diagnostics.ts", import.meta.url);
      const entry = path.join(root, "observe.mts");
      fs.writeFileSync(
        entry,
        `
import fs from "node:fs";
import { runWithWorkerStartObserver } from ${JSON.stringify(observer.href)};
await runWithWorkerStartObserver(script => {
  if (script === "sqlite-snapshot-staging.worker.js") fs.appendFileSync(${JSON.stringify(events)}, "start" + String.fromCharCode(10));
}, () => import(${JSON.stringify(worker.href)}));
`,
      );
      const cache = path.join(root, "cache");
      const stagingParent = path.join(cache, "openclaw");
      fs.mkdirSync(stagingParent, { recursive: true });
      const executable = resolveTestNodeExecPath();
      const argv = [executable, ...resolveRuntimeWorkerArgv(pathToFileURL(entry), executable)];
      const input = { mode, paths, stateDir: root, config: {}, generationFormat: "paired" };
      const env = { HOME: root, XDG_CACHE_HOME: cache };
      const runner = path.join(root, "observe-worker");
      if (parentOwned) {
        fs.writeFileSync(runner, `#!/bin/sh\nexec ${argv.map(quoteCliArg).join(" ")} "$@"\n`, {
          mode: 0o755,
        });
      }
      const result = parentOwned
        ? await withStateInspectionStaging(stagingParent, (stagingRoot) =>
            runUpdateStateInspectionWorker({
              input,
              nodeRunner: runner,
              sourceEnv: {
                ...process.env,
                ...env,
                TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
              },
              stagingRoot,
              databases: paths.map((file) => ({
                path: file,
                sizeBytes: fs.statSync(file, { bigint: true }).size,
              })),
              timeoutMs: 30_000,
              ioBudget: "deadline",
              signal,
            }),
          )
        : await runUtf8CommandWithTimeout(argv, {
            signal,
            timeoutMs: 30_000,
            env,
            input: JSON.stringify(input),
          });
      expect(result, result.stderr).toMatchObject({ code: 0 });
      expect(JSON.parse(result.stdout)).toMatchObject({
        committed: Object.fromEntries(
          paths.map((file) => [file, expect.stringMatching(/^[a-f0-9]{64}$/)]),
        ),
      });
      expect(paths.map((file) => fs.readFileSync(file))).toEqual(original);
      expect(fs.readdirSync(stagingParent)).toEqual([]);
      expect(fs.readFileSync(events, "utf8")).toBe(parentOwned ? "" : "start\n");
    });
  },
);

it("shares command custody while retiring each inspection tree before the next", async ({
  expect,
  signal,
  onTestFinished,
}) => {
  const fixture = createFixtureLifetime();
  onTestFinished(() => fixture.cleanup());
  await fixture.run(async () => {
    const root = fixture.createTempDir("update-inspection-scope-");
    const directories: string[] = [];
    const parents: number[] = [];
    const scope = createStateInspectionScope();
    try {
      await scope.run(async () => {
        for (let index = 0; index < 2; index++) {
          await withStateInspectionStaging(root, async (directory) => {
            directories.push(directory);
            const result = await runStateInspectionCommand(
              [process.execPath, "-e", "process.stdout.write(String(process.ppid))"],
              { signal, timeoutMs: 5_000 },
            );
            expect(result, result.stderr).toMatchObject({ code: 0, termination: "exit" });
            parents.push(Number(result.stdout));
          });
          expect(fs.readdirSync(root)).toEqual([]);
        }
      });
    } finally {
      await scope.close();
    }
    expect(new Set(directories).size).toBe(2);
    const brokerPid = parents[0];
    if (brokerPid === undefined) {
      throw new Error("Inspection command did not report its native parent");
    }
    expect(brokerPid).toBeGreaterThan(0);
    expect(parents[1]).toBe(brokerPid);
    expect(() => process.kill(brokerPid, 0)).toThrow();
  });
});

it.for([false, true])(
  "cancels inspection commands with their enclosing work (explicit signal=%s)",
  async (explicitSignal, { expect, onTestFinished }) => {
    const fixture = createFixtureLifetime();
    onTestFinished(() => fixture.cleanup());
    await fixture.run(async () => {
      const root = fixture.createTempDir("update-inspection-cancel-");
      const cancellation = new AbortController();
      const result = await withUpdateStateInspectionWork(
        () =>
          withStateInspectionStaging(root, () =>
            runStateInspectionCommand(
              [
                process.execPath,
                "-e",
                "process.stdout.write('ready'); setInterval(() => {}, 1000)",
              ],
              {
                signal: explicitSignal ? new AbortController().signal : undefined,
                timeoutMs: 5_000,
                killProcessTree: true,
                onOutputChunk() {
                  cancellation.abort();
                },
              },
            ),
          ),
        cancellation.signal,
      );
      expect(result).toMatchObject({
        stdout: "ready",
        termination: "signal",
        killIssuedByAbort: true,
      });
      expect(fs.readdirSync(root)).toEqual([]);
    });
  },
);

it.for([false, true])(
  "preserves output observer stop classification across the inspection socket (waiting=%s)",
  async (waiting, { expect, signal, onTestFinished }) => {
    const fixture = createFixtureLifetime();
    onTestFinished(() => fixture.cleanup());
    await fixture.run(async () => {
      const root = fixture.createTempDir("update-inspection-output-");
      const argv = [
        process.execPath,
        "-e",
        `process.stdout.write('stop'); ${waiting ? "setInterval(() => {}, 1000)" : ""}`,
      ];
      const options = { signal, timeoutMs: 5_000, onOutputChunk: () => false };
      const direct = await runUtf8CommandWithTimeout(argv, options);
      const owned = await withStateInspectionStaging(root, () =>
        runStateInspectionCommand(argv, options),
      );
      for (const result of [direct, owned]) {
        expect(result).toMatchObject({
          stdout: "stop",
          outputLimitExceeded: true,
          termination: "signal",
          killIssuedByAbort: true,
          noOutputTimedOut: false,
        });
      }
    });
  },
);

it
  .skipIf(process.platform === "win32")
  .for(
    (process.versions.bun ? ["node", "bun"] : ["node"]).flatMap((runtime) =>
      [false, true].map((legacy) => ({ runtime, legacy })),
    ),
  )(
  "joins a surviving schema command before retiring its killed creator's staging (%s)",
  async ({ legacy, runtime }, { expect, signal, onTestFinished }) => {
    const fixture = createFixtureLifetime();
    onTestFinished(() => fixture.cleanup());
    await fixture.run(async () => {
      const root = fixture.createTempDir("update-inspection-exit-");
      fs.mkdirSync(path.join(root, "cache"), { mode: 0o700 });
      const stateDir = path.join(root, "state");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      using database = new DatabaseSync(databasePath);
      database.exec(
        "PRAGMA user_version=3; CREATE TABLE evidence(value); INSERT INTO evidence VALUES(7)",
      );
      database.close();
      const original = fs.readFileSync(databasePath);
      const marker = path.join(root, "entered.json");
      const violation = path.join(root, "premature-removal");
      const runner = path.join(root, "inspection.mjs");
      fs.writeFileSync(
        runner,
        `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
if (process.argv.some(arg => path.basename(arg) === ${JSON.stringify(runtimeProcessScriptEntrypoints.updateStateSizes.fileName)})) {
  process.exit(spawnSync(process.execPath, process.argv.slice(2), { stdio: "inherit" }).status ?? 1);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
const parsed = input ? JSON.parse(input) : {};
if (${legacy} && parsed.mode === "discover") {
  process.stderr.write("Unknown update state inspection mode");
  process.exit(1);
}
const directory = parsed.stagingRoot ?? process.argv.at(-1);
const payload = path.join(directory, "database.sqlite.partial");
fs.writeFileSync(payload, Buffer.alloc(2 * 1024 * 1024));
fs.writeFileSync(${JSON.stringify(marker + ".tmp")}, JSON.stringify({ pid: process.pid, directory }));
fs.renameSync(${JSON.stringify(marker + ".tmp")}, ${JSON.stringify(marker)});
process.on("SIGTERM", () => {
  if (!fs.existsSync(payload)) fs.writeFileSync(${JSON.stringify(violation)}, "removed while command alive");
  setTimeout(() => process.exit(0), 100);
});
setInterval(() => {}, 1000);
`,
        { mode: 0o755 },
      );
      const producer = `
import { readUpdateStateSchemaVersions } from ${JSON.stringify(new URL("./update-candidate-state.ts", import.meta.url).href)};
import { createStateInspectionScope, withStateInspectionStaging } from ${JSON.stringify(new URL("./update-candidate-state.process.ts", import.meta.url).href)};
const scope = createStateInspectionScope();
try { await scope.run(async () => {
  await withStateInspectionStaging(${JSON.stringify(path.join(root, "cache"))}, async () => {});
  await readUpdateStateSchemaVersions({ stateDir: ${JSON.stringify(stateDir)}, config: {}, nodeRunner: ${JSON.stringify(runner)} });
}); } finally { await scope.close(); }
`;
      const supervisor = `
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const host = spawn(${runtime === "bun" ? JSON.stringify(process.execPath) : "process.execPath"}, ["--import=tsx", "--input-type=module", "--eval", ${JSON.stringify(producer)}], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
host.stderr.on("data", value => { stderr += value; });
const exited = new Promise(resolve => host.once("exit", resolve));
let command;
try {
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(${JSON.stringify(marker)})) {
    if (Date.now() > deadline || host.exitCode !== null) throw new Error("schema command not ready: " + stderr);
    await delay(10);
  }
  command = JSON.parse(fs.readFileSync(${JSON.stringify(marker)}, "utf8"));
  host.kill("SIGKILL");
  await exited;
  const deadlineCleanup = Date.now() + 10000;
  while ((alive(command.pid) || fs.existsSync(command.directory)) && Date.now() < deadlineCleanup) await delay(10);
  const cache = path.dirname(command.directory);
  console.log(JSON.stringify({ alive: alive(command.pid), retained: fs.existsSync(command.directory), premature: fs.existsSync(${JSON.stringify(violation)}), entries: fs.readdirSync(cache) }));
} finally {
  if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
  await exited;
  if (command && alive(command.pid)) process.kill(command.pid, "SIGKILL");
}
`;
      const result = await fixture.track(
        runNodeScript(
          ["--import=tsx", "--input-type=module", "--eval", supervisor],
          {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            XDG_CACHE_HOME: path.join(root, "cache"),
            NODE_DISABLE_COMPILE_CACHE: "1",
            TSX_DISABLE_CACHE: "1",
          },
          40_000,
          { signal, maxBuffer: 1024 * 1024 },
        ),
      );
      expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
      expect(JSON.parse(result.stdout)).toEqual({
        alive: false,
        retained: false,
        premature: false,
        entries: [],
      });
      expect(fs.readFileSync(databasePath)).toEqual(original);
    });
  },
);
