import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { requireNodeTool } from "../../test/helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { updateExecutorNativeEntrypoints } from "../cli/update-cli/update-command-executor-native-runtime.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform !== "linux")(
  "reaps adopted descendants before scoped spawn cleanup completes",
  async () => {
    const directory = temp.make("exec-adopted-reaping-");
    const execUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.processExec);
    const executorUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor);
    const loader = execUrl.pathname.endsWith(".ts")
      ? new URL("../../scripts/tsx.mjs", import.meta.url).href
      : undefined;
    const driver = `
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

${loader ? `await import(${JSON.stringify(loader)});` : ""}
const { spawnCommand } = await import(${JSON.stringify(execUrl.href)});
const { withUpdateCommandExecutor } = await import(${JSON.stringify(executorUrl.href)});
const require = createRequire(${JSON.stringify(execUrl.href)});
const { becomeChildSubreaper, inspectChildWaitState, reapChild } = require("@openclaw/proc-safe/reaper");
becomeChildSubreaper();
const directory = ${JSON.stringify(directory)};

    const receipt = path.join(directory, "scope.json");
    const descendant = 'setInterval(() => {}, 1000); process.send("ready");';
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
      // Enter the existing command scope without acquiring update/database authority.
      await withUpdateCommandExecutor("adopted-reaping-fixture", async () => {
        result = await spawnCommand([process.execPath, "-e", root], {
          detached: true, reject: false, stdio: "ignore",
        });
      });
    } catch (error) {
      failure = String(error);
    }
    const pids = JSON.parse(readFileSync(receipt, "utf8"));
    const descendantPath = "/proc/" + pids.descendant + "/stat";
    const remaining = existsSync(descendantPath) ? readFileSync(descendantPath, "utf8") : undefined;
    const fields = remaining?.slice(remaining.lastIndexOf(")") + 2).split(" ");
    try {
      assert.deepEqual({ ready: pids.ready, failure,
        code: result?.exitCode,
        signal: result?.signal ?? null },
        { ready: true, failure: undefined, code: 0, signal: null });
      assert.equal(fields, undefined, "descendant must be reaped");
    } finally {
      // A red regression can leave our adopted zombie. Never consume the tracked root.
      if (fields) {
        assert.notEqual(pids.descendant, pids.root);
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
  process.stdout.write("reaped");
`;
    const { stdout } = await promisify(execFile)(
      requireNodeTool("node"),
      ["--input-type=module", "-e", driver],
      { timeout: 15_000 },
    );
    expect(stdout).toBe("reaped");
  },
);
