import { expect, it, onTestFinished } from "vitest";
import {
  closeOwnedStdioProcess,
  createOwnedStdioProcess,
  type OwnedStdioProcess,
  type OwnedStdioProcessOptions,
} from "./owned-stdio.js";
import { createChildAdapter } from "./supervisor/adapters/child.js";

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
