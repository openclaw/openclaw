import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { runClaudeCliNativeSpawnProof } from "../../test/helpers/claude-cli-native-spawn-proof.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "../node-host/node-worker-process-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runUtf8CommandWithTimeout } from "./exec.js";
import { killProcessTree } from "./kill-tree.js";

// libuv owns the Job, but no retained handle exposes this foreign descendant's exit.
async function waitForDescendantExit(
  identity: NodeWorkerProcessIdentity,
  signal: AbortSignal,
): Promise<void> {
  try {
    while (inspectNodeWorkerProcessIdentity(identity) !== "dead") {
      await waitForProcessTick(50, undefined, { signal });
    }
  } catch (error) {
    throw new Error(`Timed out waiting for Windows descendant ${identity.pid} to exit`, {
      cause: error,
    });
  }
}

describe("runUtf8CommandWithTimeout Windows integration", () => {
  it.runIf(process.platform === "win32")(
    "closes a nested Node descendant after an inner spawnSync timeout and outer failure",
    async ({ signal }) => {
      const descendantSource = 'setInterval(() => {}, 1000); process.send("ready");';
      const innerSource = [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });`,
        'child.once("message", () => process.stdout.write(String(child.pid) + "\\n"));',
      ].join("\n");
      // Match the finalization fence's real child deadline. Each non-detached Node
      // child has libuv job ownership; this does not cover arbitrary grandchildren
      // or hosts that deny job assignment.
      const outerSource = [
        'const { spawnSync } = require("node:child_process");',
        `const result = spawnSync(process.execPath, ["-"], { input: ${JSON.stringify(innerSource)}, stdio: ["pipe", "inherit", "pipe"], timeout: 60_000, killSignal: "SIGKILL", encoding: "utf8", windowsHide: true });`,
        "if (result.error) process.stderr.write(result.error.message);",
        "process.exitCode = result.error || result.status !== 0 ? 1 : 0;",
      ].join("\n");
      const ready = createDeferredCore<NodeWorkerProcessIdentity>();
      const controller = new AbortController();
      let child: NodeWorkerProcessIdentity | undefined;
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
            child = requireNodeWorkerProcessIdentity(Number(output.trim()));
            ready.resolve(child);
          }
        },
      });
      try {
        const descendant = await withinTest(
          awaitGateBeforeSettlement(
            ready.promise,
            pending,
            "inner command ended without descendant readiness",
          ),
          signal,
        );
        expect(inspectNodeWorkerProcessIdentity(descendant)).toBe("live");
        await expect(withinTest(pending, signal)).resolves.toMatchObject({
          code: 1,
          termination: "exit",
          stderr: expect.stringContaining("ETIMEDOUT"),
        });
        await waitForDescendantExit(descendant, signal);
        expect(inspectNodeWorkerProcessIdentity(descendant)).toBe("dead");
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
        // Failed assertions still clean only the exact observed fixture process.
        if (child && inspectNodeWorkerProcessIdentity(child) === "live") {
          process.kill(child.pid, "SIGKILL");
          await waitForDescendantExit(child, signal);
          expect(inspectNodeWorkerProcessIdentity(child)).toBe("dead");
        }
      }
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
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
        const [output] = await withinTest(
          awaitGateBeforeSettlement(
            once(parentStdout, "data", { signal }),
            parentClosed,
            "Could not start the Windows process tree",
          ),
          signal,
        );
        const childPid = Number.parseInt(String(output).trim(), 10);
        expect(Number.isSafeInteger(childPid)).toBe(true);
        const descendant = requireNodeWorkerProcessIdentity(childPid);
        expect(() => process.kill(parentPid, 0)).not.toThrow();
        expect(() => process.kill(childPid, 0)).not.toThrow();

        // An unforced taskkill refuses Node console processes. Cleanup must not
        // depend on this unref'd timer surviving an application shutdown.
        killProcessTree(parentPid, { graceMs: 30_000 });

        await withinTest(parentClosed, signal);
        await waitForDescendantExit(descendant, signal);
        expect(() => process.kill(parentPid, 0)).toThrow();
        expect(() => process.kill(childPid, 0)).toThrow();
      } finally {
        // The retained child handle is safe after exit; taskkill of its reusable
        // PID is not. This fixture's non-detached Node child is in its libuv job.
        parent.kill("SIGKILL");
        parentStdout.destroy();
        await parentClosed;
      }
    },
    15_000,
  );
});

describe.runIf(process.platform === "win32" || process.env.OPENCLAW_CLAUDE_CLI_SPAWN_PROOF === "1")(
  "ordinary Claude CLI executable launch",
  () => {
    it.each(
      process.platform === "win32"
        ? (["native", "node-leading", "npm-shim"] as const)
        : (["npm-shim"] as const),
    )(
      "completes an ordinary agent turn through %s",
      async (kind) => {
        const proof = await runClaudeCliNativeSpawnProof(kind);
        console.log("[claude-cli-native-proof]", JSON.stringify(proof));
        expect(proof.code, proof.stderr).toBe(0);
        expect(JSON.parse(proof.stdout)).toMatchObject({
          payloads: expect.arrayContaining([expect.objectContaining({ text: "PONG" })]),
        });
        expect(proof.launches).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              phase: "run",
              platform: process.platform,
              entrypoint: proof.entrypoint,
            }),
          ]),
        );
        if (kind === "native") {
          expect(proof.launches).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ phase: "native-launch", platform: "win32" }),
            ]),
          );
        }
      },
      360_000,
    );
  },
);
