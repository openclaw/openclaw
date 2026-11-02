import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { runtimeProcessScriptEntrypoints } from "./runtime-process-manifest.js";
import {
  runStateInspectionCommand,
  withStateInspectionStaging,
} from "./update-candidate-state.process.js";

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
await readUpdateStateSchemaVersions({ stateDir: ${JSON.stringify(stateDir)}, config: {}, nodeRunner: ${JSON.stringify(runner)} });
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
