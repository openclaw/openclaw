import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
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
    const driver = path.join(directory, "driver.mjs");
    await writeFile(
      driver,
      `
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
const libc = require("koffi").load(null);
const prctl = libc.func("int prctl(int option, unsigned long, unsigned long, unsigned long, unsigned long)");
const waitpid = libc.func("int waitpid(int pid, int *status, int options)");
assert.equal(prctl(36, 1, 0, 0, 0), 0, "isolated fixture must own orphan adoption");
const directory = ${JSON.stringify(directory)};

const unrelated = spawn(process.execPath, ["-e", \`
  process.once("message", () => process.exit(37));
  process.send("ready");
\`], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
const unrelatedExit = once(unrelated, "exit");
await once(unrelated, "message");
const reports = [];
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
      require("node:fs").writeFileSync(\${JSON.stringify(receipt)},
        JSON.stringify({ root: process.pid, descendant: child.pid }));
      child.once("message", () => {
        require("node:fs").writeFileSync(\${JSON.stringify(receipt)},
          JSON.stringify({ root: process.pid, descendant: child.pid, ready: true }));
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
      assert.equal(pids.ready, true, "descendant must be ready before root exit");
      reports.push({
        mode,
        rootCode: mode === "runner" ? result?.code : result?.exitCode,
        rootSignal: result?.signal ?? null,
        cleanup: mode === "runner" ? result?.cleanup : failure ? "failed" : "settled",
        descendantPresent: fields !== undefined,
        cooperative: existsSync(marker),
        ...(fields ? { descendant: { state: fields[0], parent: Number(fields[1]), group: Number(fields[2]) } } : {}),
        ...(failure ? { failure } : {}),
      });
    } finally {
      // A red regression can leave our adopted zombie. Never consume the tracked root.
      if (fields) {
        assert.notEqual(pids.descendant, pids.root);
        assert.notEqual(pids.descendant, unrelated.pid);
        assert.equal(Number(fields[1]), process.pid, "fixture cleanup requires actual adoption");
        assert.equal(Number(fields[2]), pids.root, "fixture cleanup requires the owned group");
        try { process.kill(-pids.root, "SIGKILL"); } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        assert.equal(waitpid(pids.descendant, null, 0), pids.descendant);
      }
    }
  }
  assert.equal(unrelated.exitCode, null, "cleanup must leave the unrelated child running");
  unrelated.send("finish");
  assert.deepEqual(await unrelatedExit, [37, null], "libuv must retain unrelated exit status");
  process.stdout.write(JSON.stringify(reports));
} finally {
  if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill("SIGKILL");
  await unrelatedExit;
}
`,
    );
    const { stdout } = await promisify(execFile)(requireNodeTool("node"), [driver], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(JSON.parse(stdout)).toEqual([
      {
        mode: "runner",
        rootCode: 0,
        rootSignal: null,
        cleanup: "cooperative",
        descendantPresent: false,
        cooperative: true,
      },
      {
        mode: "scope",
        rootCode: 0,
        rootSignal: null,
        cleanup: "settled",
        descendantPresent: false,
        cooperative: false,
      },
    ]);
  },
);
