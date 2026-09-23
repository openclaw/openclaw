import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommandBuffered, runExec } from "../exec.js";
import { createChildAdapter } from "../supervisor/adapters/child.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost } from "./host.js";

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("Gateway spawn transports", () => {
  let broker: ReturnType<typeof createSpawnBrokerHost>;

  beforeAll(async () => {
    broker = createSpawnBrokerHost();
    await broker.ready();
  });

  afterAll(async () => {
    await broker?.close();
  });

  it("runs buffered exec and Git-style commands as children of the broker", async () => {
    await runWithSpawnBroker(broker, async () => {
      const args = ["-e", "process.stdout.write(String(process.ppid))"];
      const exec = await runExec(process.execPath, args, { logOutput: false });
      expect(Number(exec.stdout)).toBe(broker.pid);
      const buffered = await runCommandBuffered([process.execPath, ...args]);
      expect(buffered.termination).toBe("exit");
      expect(Number(buffered.stdout.toString())).toBe(broker.pid);
    });
  });

  it("keeps the exec-tool child adapter off the Gateway process", async () => {
    await runWithSpawnBroker(broker, async () => {
      const { adapter, ready } = await createChildAdapter({
        argv: [process.execPath, "-e", "process.stdout.write(String(process.ppid))"],
        stdinMode: "pipe-closed",
        exactEnv: true,
      });
      let output = "";
      adapter.onStdout((chunk) => {
        output += chunk;
      });
      adapter.onStderr(() => {});
      try {
        await ready;
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
        expect(Number(output)).toBe(broker.pid);
      } finally {
        adapter.dispose();
      }
    });
  });

  it("leaves one-shot commands in the calling process outside Gateway scope", async () => {
    const result = await runExec(process.execPath, ["-e", "console.log(process.ppid)"], {
      logOutput: false,
    });
    expect(Number(result.stdout)).toBe(process.pid);
  });

  it("preserves runExec launch error metadata across asynchronous readiness", async () => {
    const command = "/openclaw-nonexistent-spawn-broker-command";
    const options = { logOutput: false };
    const local = await runExec(command, [], options).catch((error: unknown) => error);
    const remote = await runWithSpawnBroker(broker, () =>
      runExec(command, [], options).catch((error: unknown) => error),
    );
    expect(local).toBeInstanceOf(Error);
    expect(remote).toMatchObject({ code: "ENOENT", failed: true, stdout: "", stderr: "" });
    expect(remote).toMatchObject({ message: (local as Error).message });
  });
});
