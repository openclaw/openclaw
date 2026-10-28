import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileClaudeCliNativeLauncher,
  runClaudeCliNativeSpawnProof,
} from "../../test/helpers/claude-cli-native-spawn-proof.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  inspectNodeWorkerProcessIdentity as inspectIdentity,
  requireNodeWorkerProcessIdentity as requireIdentity,
  type NodeWorkerProcessIdentity as ProcessIdentity,
} from "../node-host/node-worker-process-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runUtf8CommandWithTimeout } from "./exec.js";
import { killProcessTree } from "./kill-tree.js";

const windows = process.platform === "win32";
const cliProofEnabled = windows || process.env.OPENCLAW_CLAUDE_CLI_SPAWN_PROOF === "1";

// libuv owns the Job, but no retained handle exposes this foreign descendant's exit.
async function expectDescendantExit(identity: ProcessIdentity, signal: AbortSignal): Promise<void> {
  while (inspectIdentity(identity) !== "dead") {
    await waitForProcessTick(50, undefined, { signal });
  }
}

function readyBeforeExit<T>(ready: Promise<T>, closed: Promise<unknown>, signal: AbortSignal) {
  return withinTest(
    awaitGateBeforeSettlement(ready, closed, "Child exited before readiness"),
    signal,
  );
}

it.runIf(windows)(
  "closes a nested Node descendant after an inner spawnSync timeout and outer failure",
  async ({ signal }) => {
    const descendantSource = 'setInterval(() => {}, 1000); process.send("ready");';
    const innerSource = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });`,
      'child.once("message", () => process.stdout.write(String(child.pid) + "\\n"));',
    ].join("\n");
    // Match the finalization fence; libuv Jobs own only these non-detached Node children.
    const outerSource = [
      'const { spawnSync } = require("node:child_process");',
      `const result = spawnSync(process.execPath, ["-"], { input: ${JSON.stringify(innerSource)}, stdio: ["pipe", "inherit", "pipe"], timeout: 60_000, killSignal: "SIGKILL", encoding: "utf8", windowsHide: true });`,
      "if (result.error) process.stderr.write(result.error.message);",
      "process.exitCode = result.error || result.status !== 0 ? 1 : 0;",
    ].join("\n");
    const ready = createDeferredCore<ProcessIdentity>();
    const controller = new AbortController();
    let child: ProcessIdentity | undefined;
    let output = "";
    const pending = runUtf8CommandWithTimeout([process.execPath, "-e", outerSource], {
      timeoutMs: 75_000,
      killProcessTree: true,
      signal: controller.signal,
      onOutputChunk: (chunk, stream) => {
        if (stream !== "stdout" || child) {
          return;
        }
        output += chunk.toString("utf8");
        if (output.includes("\n")) {
          child = requireIdentity(Number(output.trim()));
          ready.resolve(child);
        }
      },
    });
    try {
      const descendant = await readyBeforeExit(ready.promise, pending, signal);
      expect(inspectIdentity(descendant)).toBe("live");
      const result = await withinTest(pending, signal);
      expect(result).toMatchObject({ code: 1, termination: "exit" });
      expect(result.stderr).toContain("ETIMEDOUT");
      await expectDescendantExit(descendant, signal);
    } finally {
      controller.abort();
      await pending.catch(() => undefined);
      // Failed assertions still clean only the exact observed fixture process.
      if (child && inspectIdentity(child) === "live") {
        process.kill(child.pid, "SIGKILL");
        await expectDescendantExit(child, signal);
      }
    }
  },
  90_000,
);

it.runIf(windows)(
  "force-kills a real Windows process tree when graceful taskkill refuses it",
  async ({ signal }) => {
    const program = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
      'child.once("spawn", () => process.stdout.write(String(child.pid) + "\\n"));',
      'child.once("error", () => process.exit(1));',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parent = spawn(process.execPath, ["-e", program], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const parentClosed = once(parent, "close");
    const parentPid = parent.pid;
    const parentStdout = parent.stdout;

    if (parentPid === undefined || parentStdout === null) {
      parent.kill();
      throw new Error("Could not start the Windows process tree");
    }

    try {
      const [output] = await readyBeforeExit(
        once(parentStdout, "data", { signal }),
        parentClosed,
        signal,
      );
      const childPid = Number.parseInt(String(output).trim(), 10);
      expect(Number.isSafeInteger(childPid)).toBe(true);
      const descendant = requireIdentity(childPid);
      expect(inspectIdentity(descendant)).toBe("live");
      expect(() => process.kill(parentPid, 0)).not.toThrow();

      // Unforced taskkill refuses Node; do not depend on its unref'd grace timer.
      killProcessTree(parentPid, { graceMs: 30_000 });

      await withinTest(parentClosed, signal);
      await expectDescendantExit(descendant, signal);
      expect(() => process.kill(parentPid, 0)).toThrow();
    } finally {
      // Use the retained handle, not a reusable PID; libuv owns this Node child.
      parent.kill("SIGKILL");
      parentStdout.destroy();
      await parentClosed;
    }
  },
  15_000,
);

describe.runIf(cliProofEnabled)("ordinary Claude CLI executable launch", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  let nativeLauncher = "";

  beforeAll(async () => {
    if (windows) {
      nativeLauncher = await compileClaudeCliNativeLauncher(
        tempDirs.make("openclaw-claude-native-"),
      );
    }
  }, 150_000);
  beforeAll(async () => {
    const instance = await createOpenClawTestInstance({ name: "claude-cli-spawn-prepare" });
    // Reuse CI's built runtime; launcher cases do not own artifact publication.
    try {
      await instance.entrypoint();
    } finally {
      await instance.cleanup();
    }
  }, 240_000);

  const launchKinds = ["native", "node-leading", "npm-shim"] as const;
  it.each(windows ? launchKinds : (["npm-shim"] as const))(
    "completes an ordinary agent turn through %s",
    async (kind) => {
      const proof = await runClaudeCliNativeSpawnProof(
        kind === "native" ? { kind, launcher: nativeLauncher } : { kind },
      );
      console.log("[claude-cli-native-proof]", JSON.stringify(proof));
      expect(proof.code, proof.stderr).toBe(0);
      expect(JSON.parse(proof.stdout).payloads).toContainEqual(
        expect.objectContaining({ text: "PONG" }),
      );
      if (kind === "native") {
        expect(proof.launches).toContainEqual(
          expect.objectContaining({ phase: "native-launch", platform: "win32" }),
        );
      }
    },
    360_000,
  );
});
