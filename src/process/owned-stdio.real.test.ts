import { Duplex } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { runGatewayCloseSteps } from "../gateway/server-shutdown.js";
import { retainGatewayPluginMetadata } from "../plugins/plugin-metadata-lifecycle.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  closeOwnedStdioProcess,
  createOwnedStdioProcess,
  type OwnedStdioProcess,
  type OwnedStdioProcessOptions,
} from "./owned-stdio.js";
import * as relaySpawn from "./spawn-broker/relay-integration.js";
import { createChildAdapter } from "./supervisor/adapters/child.js";
import { readLines } from "./supervisor/service-child-group-anchor.preparation.test-support.js";

const nodeScript = (source: string) => [process.execPath, "-e", source];
const windows = process.platform === "win32";

function observe<T extends OwnedStdioProcess>(child: T) {
  onTestFinished(async () => {
    await closeOwnedStdioProcess(child, { force: true }).catch(() => undefined);
  });
  const output = { stdout: "", stderr: "" };
  const line = Promise.withResolvers<void>();
  child.onStdout((chunk) => {
    output.stdout += chunk;
    if (output.stdout.includes("\n")) {
      line.resolve();
    }
  });
  child.onStderr((chunk) => {
    output.stderr += chunk;
  });
  return { child, output, line: line.promise };
}

async function spawnScript(source: string, options: Omit<OwnedStdioProcessOptions, "argv"> = {}) {
  return observe(await createOwnedStdioProcess({ argv: nodeScript(source), ...options }));
}

it.skipIf(windows)(
  "closes Gateway metadata after an exited service loses its stdin-end write",
  async () => {
    const spawnRelay = relaySpawn.spawnServiceChildRelay;
    const cleanupStarted = Promise.withResolvers<Promise<unknown>>();
    let service: OwnedStdioProcess | undefined;
    let failedWrites = 0;
    const spawnSpy = vi.spyOn(relaySpawn, "spawnServiceChildRelay").mockImplementation((params) => {
      const spawned = spawnRelay(params);
      const control = spawned.child.stdio[3];
      if (!(control instanceof Duplex)) {
        throw new Error("Expected the private service control pipe");
      }
      const write = control.write.bind(control);
      vi.spyOn(control, "write").mockImplementation((chunk, encoding, callback) => {
        const message: unknown = JSON.parse(chunk.toString());
        if (isRecord(message) && message.type === "stdin-end") {
          failedWrites++;
          callback?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          return false;
        }
        return write(chunk, encoding, callback);
      });
      // Observe the real root's exit before the host publishes it to consumers.
      // Only write delivery is faulted; receipt, lineage and OS exit remain native.
      readLines(control, (line) => {
        const message: unknown = JSON.parse(line);
        if (isRecord(message) && message.type === "root-result" && service) {
          const cleanup = closeOwnedStdioProcess(service);
          void cleanup.catch(() => {});
          cleanupStarted.resolve(cleanup);
        }
      });
      return spawned;
    });
    onTestFinished(() => spawnSpy.mockRestore());
    const metadata = retainGatewayPluginMetadata(createTestGatewayScheduler());
    const { child } = await spawnScript('process.stdin.once("data", () => process.exit(0));', {
      terminateOnHostLoss: true,
    });
    service = child;
    const shutdownErrors: string[] = [];
    const closing = runGatewayCloseSteps({
      owner: {
        connectionWork: { drain: async () => {} },
        stopConnectionDependentSidecars() {},
        stopRegisteredGatewayLifetimeSidecars() {},
        stopRegisteredPostReadySidecars() {},
        runClosePrelude() {},
        sealAndJoinRegisteredSidecarStops() {},
      },
      close: async () => {
        await metadata.close(async () => {
          await cleanupStarted.promise;
        });
      },
      onError: (message) => shutdownErrors.push(message),
    });
    child.stdin!.write("exit\n");
    await expect(closing).resolves.toBeUndefined();
    expect(failedWrites).toBe(1);
    expect(shutdownErrors).toEqual([]);
    await expect(child.wait()).resolves.toEqual({ code: 0, signal: null });
    await expect(child.waitForExtinction!()).resolves.toBeUndefined();
  },
);

it("drains protocol output and shutdown diagnostics before confirming real stdio cleanup", async () => {
  const diagnostic = "shutdown: 🌊\n".repeat(8192);
  const { child, output } = await spawnScript(
    `process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("done\\n", () => {
    process.stderr.write("shutdown: 🌊\\n".repeat(8192), () => process.exit(0));
  });
});`,
    { env: {}, exactEnv: true },
  );
  const result = child.wait();
  await closeOwnedStdioProcess(child);
  await expect(result).resolves.toEqual({ code: 0, signal: null });
  expect(output).toEqual({ stdout: "done\n", stderr: diagnostic });
});

it.runIf(windows)("certifies inherited stdio after parent exit", async () => {
  const { child, output, line } =
    await spawnScript(`const { spawn } = require("node:child_process");
process.stdin.once("data", () => {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: ["ignore", "inherit", "inherit"]
  });
  grandchild.once("spawn", () => process.stdout.write(String(grandchild.pid) + "\\n", () => process.exit(0)));
});`);
  const rootExit = Promise.withResolvers<void>();
  child.onExit(() => rootExit.resolve());
  child.stdin!.write("start\n");
  await Promise.all([rootExit.promise, line]);
  const pid = Number(output.stdout.trim());
  expect(pid).toBeGreaterThan(1);
  expect(() => process.kill(pid, 0)).not.toThrow();
  await closeOwnedStdioProcess(child, { force: true });
  await expect(child.waitForExtinction!()).resolves.toEqual({ status: "confirmed" });
  expect(() => process.kill(pid, 0)).toThrow();
});

it.runIf(windows)("preserves IPC and interactive stdin inside the Job", async () => {
  const { adapter, ready } = await createChildAdapter({
    argv: nodeScript(`process.once("message", (message) => {
  process.stdout.write(message.type + "\\n");
  process.stdin.once("data", (data) => process.stdout.write(data, () => process.exit(0)));
});`),
    ownedWorker: true,
    stdinMode: "pipe-open",
  });
  const { output, line } = observe(adapter);
  await ready;
  await adapter.openStartGate!();
  await line;
  adapter.stdin!.write("interactive\n");
  await adapter.wait();
  await expect(adapter.waitForExtinction!()).resolves.toEqual({ status: "confirmed" });
  expect(output.stdout).toBe("openclaw-worker-start-v1\ninteractive\n");
});
