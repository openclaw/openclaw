import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { requireNodeTool } from "../../test/helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { updateExecutorNativeEntrypoints } from "../cli/update-cli/update-command-executor-native-runtime.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform !== "linux")(
  "settles adopted descendants through command termination and scoped spawn cleanup",
  async () => {
    const directory = temp.make("exec-adopted-reaping-");
    const execUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.processExec);
    const executorUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor);
    const loader = execUrl.pathname.endsWith(".ts")
      ? new URL("../../scripts/tsx.mjs", import.meta.url).href
      : undefined;
    const driver = `
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

${loader ? `await import(${JSON.stringify(loader)});` : ""}
const { runCommandWithTimeout, spawnCommand } = await import(${JSON.stringify(execUrl.href)});
const { withUpdateCommandExecutor } = await import(${JSON.stringify(executorUrl.href)});
const require = createRequire(${JSON.stringify(execUrl.href)});
const { becomeChildSubreaper, inspectChildWaitState, reapChild } = require("@openclaw/proc-safe/reaper");
becomeChildSubreaper();
const directory = ${JSON.stringify(directory)};

const unrelated = spawn(process.execPath, ["-e", \`
  process.once("message", () => process.exit(37));
  process.send("ready");
\`], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
const unrelatedExit = once(unrelated, "exit");
await once(unrelated, "message");
try {
  for (const mode of ["runner", "scope"]) {
    const receipt = path.join(directory, mode + ".json");
    const marker = path.join(directory, mode + ".stopped");
    const socket = "\\0openclaw-adopted-" + process.pid + "-" + mode;
    const descendant = \`
      const fs = require("node:fs");
      const server = require("node:net").createServer();
      process.once("SIGTERM", () => {
        fs.writeFileSync(\${JSON.stringify(marker)}, "cooperative");
        server.close(() => process.exit(0));
      });
      server.listen(\${JSON.stringify(socket)}, () => process.send("ready"));
    \`;
    const root = \`
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", \${JSON.stringify(descendant)}], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const record = (ready = false) => require("node:fs").writeFileSync(\${JSON.stringify(receipt)},
        JSON.stringify({ root: process.pid, descendant: child.pid, ready }));
      record();
      child.once("message", () => {
        record(true);
        child.disconnect();
        child.unref();
      });
    \`;
    let result;
    let failure;
    try {
      if (mode === "runner") {
        result = await runCommandWithTimeout([process.execPath, "-e", root], {
          timeoutMs: 5000,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
        });
      } else {
        // Enter the existing command scope without acquiring update/database authority.
        await withUpdateCommandExecutor("adopted-reaping-fixture", async () => {
          result = await spawnCommand([process.execPath, "-e", root], {
            detached: true, reject: false, stdio: "ignore",
          });
        });
      }
    } catch (error) {
      failure = String(error);
    }
    const pids = JSON.parse(readFileSync(receipt, "utf8"));
    const descendantPath = "/proc/" + pids.descendant + "/stat";
    const remaining = existsSync(descendantPath) ? readFileSync(descendantPath, "utf8") : undefined;
    const fields = remaining?.slice(remaining.lastIndexOf(")") + 2).split(" ");
    try {
      assert.deepEqual({ ready: pids.ready, failure,
        code: mode === "runner" ? result?.code : result?.exitCode,
        signal: result?.signal ?? null },
        { ready: true, failure: undefined, code: 0, signal: null }, mode);
      if (mode === "runner") assert.equal(result?.cleanup, "cooperative");
      assert.equal(fields, undefined, mode + ": descendant must be reaped");
      assert.equal(existsSync(marker), mode === "runner", mode + ": cooperative stop");
    } finally {
      // A red regression can leave our adopted zombie. Never consume the tracked root.
      if (fields) {
        assert.notEqual(pids.descendant, pids.root);
        assert.notEqual(pids.descendant, unrelated.pid);
        assert.equal(Number(fields[1]), process.pid, "fixture cleanup requires actual adoption");
        assert.equal(Number(fields[2]), pids.root, "fixture cleanup requires the owned group");
        const noticeAbort = new AbortController();
        const exited = once(process, "SIGCHLD", { signal: noticeAbort.signal });
        try {
          if (inspectChildWaitState(pids.descendant).kind === "running") {
            try { process.kill(-pids.root, "SIGKILL"); } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
            await exited;
          }
          assert.deepEqual(inspectChildWaitState(pids.descendant), { kind: "exited", pid: pids.descendant });
          assert.equal(reapChild(pids.descendant)?.pid, pids.descendant);
        } finally {
          noticeAbort.abort();
          await exited.catch(() => {});
        }
      }
    }
  }
  assert.equal(unrelated.exitCode, null, "cleanup must leave the unrelated child running");
  unrelated.send("finish");
  assert.deepEqual(await unrelatedExit, [37, null], "libuv must retain unrelated exit status");
  process.stdout.write("reaped");
} finally {
  if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill("SIGKILL");
  await unrelatedExit;
}
`;
    const { stdout } = await promisify(execFile)(
      requireNodeTool("node"),
      ["--input-type=module", "-e", driver],
      { timeout: 15_000 },
    );
    expect(stdout).toBe("reaped");
  },
);
