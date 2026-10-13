import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { closeOwnedStdioProcess, createOwnedStdioProcess } from "./owned-stdio.js";
import { createChildAdapter } from "./supervisor/adapters/child.js";

it("drains protocol output and shutdown diagnostics before confirming real stdio cleanup", async () => {
  const diagnostic = "shutdown: 🌊\n".repeat(8192);
  const child = await createOwnedStdioProcess({
    argv: [
      process.execPath,
      "-e",
      `process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("done\\n", () => {
    process.stderr.write("shutdown: 🌊\\n".repeat(8192), () => process.exit(0));
  });
});`,
    ],
    env: {},
    exactEnv: true,
  });
  let stdout = "";
  let stderr = "";
  child.onStdout((chunk) => {
    stdout += chunk;
  });
  child.onStderr((chunk) => {
    stderr += chunk;
  });
  const result = child.wait();
  try {
    await closeOwnedStdioProcess(child);
    await expect(result).resolves.toEqual({ code: 0, signal: null });
    expect(stdout).toBe("done\n");
    expect(stderr).toBe(diagnostic);
  } finally {
    await closeOwnedStdioProcess(child, { force: true }).catch(() => undefined);
  }
});

it.runIf(process.platform === "win32")(
  "certifies a grandchild holding stdio after its interactive parent exits",
  async () => {
    const child = await createOwnedStdioProcess({
      argv: [
        process.execPath,
        "-e",
        `
const { spawn } = require("node:child_process");
process.stdin.once("data", () => {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: ["ignore", "inherit", "inherit"]
  });
  grandchild.once("spawn", () => process.stdout.write(String(grandchild.pid) + "\\n", () => process.exit(0)));
});`,
      ],
    });
    let output = "";
    const outputReady = createDeferred();
    const rootExit = createDeferred();
    child.onExit(() => rootExit.resolve());
    child.onStdout((chunk) => {
      output += chunk;
      if (output.includes("\n")) {
        outputReady.resolve();
      }
    });
    child.onStderr(() => {});
    try {
      child.stdin!.write("start\n");
      await Promise.all([rootExit.promise, outputReady.promise]);
      const pid = Number(output.trim());
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(pid, 0)).not.toThrow();
      await closeOwnedStdioProcess(child, { force: true });
      await expect(child.waitForExtinction!()).resolves.toEqual({ status: "confirmed" });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await closeOwnedStdioProcess(child, { force: true }).catch(() => undefined);
    }
  },
);

it.runIf(process.platform === "win32")(
  "preserves the worker IPC start gate and interactive stdin inside the Job",
  async () => {
    const { adapter, ready } = await createChildAdapter({
      argv: [
        process.execPath,
        "-e",
        `
process.once("message", (message) => {
  process.stdout.write(message.type + "\\n");
  process.stdin.once("data", (data) => process.stdout.write(data, () => process.exit(0)));
});`,
      ],
      ownedWorker: true,
      stdinMode: "pipe-open",
    });
    let output = "";
    const gate = createDeferred();
    adapter.onStdout((chunk) => {
      output += chunk;
      if (output.includes("\n")) {
        gate.resolve();
      }
    });
    adapter.onStderr(() => {});
    try {
      await ready;
      await adapter.openStartGate!();
      await gate.promise;
      adapter.stdin!.write("interactive\n");
      await adapter.wait();
      await expect(adapter.waitForExtinction!()).resolves.toEqual({ status: "confirmed" });
      expect(output).toBe("openclaw-worker-start-v1\ninteractive\n");
    } finally {
      await closeOwnedStdioProcess(adapter, { force: true }).catch(() => undefined);
    }
  },
);
