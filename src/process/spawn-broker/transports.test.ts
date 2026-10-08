import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommandBuffered, runExec } from "../exec.js";
import { prepareOomScoreAdjustedSpawn } from "../linux-oom-score.js";
import { createChildAdapter } from "../supervisor/adapters/child.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

const skipBrokerTests = !supportsSpawnBrokerCommandTransport();

describe.skipIf(skipBrokerTests)("Gateway spawn transports", () => {
  let broker: ReturnType<typeof createSpawnBrokerHost>;

  beforeAll(async () => {
    broker = createSpawnBrokerHost();
    await broker.ready();
  });

  afterAll(async () => {
    await broker?.close();
  });

  it.runIf(process.platform === "linux").each([
    { name: "adjusted", enabled: true, missing: false },
    { name: "opt-out", enabled: false, missing: false },
    { name: "failed launch", enabled: true, missing: true },
  ])("restores the broker OOM score after $name", async ({ enabled, missing }) => {
    const scorePath = `/proc/${broker.pid}/oom_score_adj`;
    const original = await readFile(scorePath, "utf8");
    const prepared = prepareOomScoreAdjustedSpawn(
      missing ? "/openclaw-nonexistent-oom-command" : "/bin/cat",
      missing ? [] : ["/proc/self/oom_score_adj"],
      { env: { ...process.env, OPENCLAW_CHILD_OOM_SCORE_ADJ: enabled ? "1" : "0" } },
    );
    const child = broker.spawn(prepared.command, prepared.args, {
      env: prepared.env,
      stdio: missing ? "ignore" : ["ignore", "pipe", "ignore"],
    });
    if (missing) {
      await expect(child.ready()).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await child.ready();
      let output = "";
      child.stdout!.on("data", (chunk) => {
        output += chunk;
      });
      expect(await once(child, "close")).toEqual([0, null]);
      expect(output.trim()).toBe(enabled ? "1000" : original.trim());
      expect(child.spawnfile).toBe("/bin/cat");
    }
    expect(await readFile(scorePath, "utf8")).toBe(original);
  });

  it.each(["exec", "buffered", "adapter", "one-shot"] as const)(
    "routes %s commands to the scope's process owner",
    async (transport) => {
      await runWithSpawnBroker(transport === "one-shot" ? undefined : broker, async () => {
        const args = ["-e", "process.stdout.write(String(process.ppid))"];
        let output = "";
        if (transport === "buffered") {
          const result = await runCommandBuffered([process.execPath, ...args]);
          expect(result.termination).toBe("exit");
          output = result.stdout.toString();
        } else if (transport === "adapter") {
          const { adapter, ready } = await createChildAdapter({
            argv: [process.execPath, ...args],
            stdinMode: "pipe-closed",
            exactEnv: true,
          });
          adapter.onStdout((chunk) => {
            output += chunk;
          });
          adapter.onStderr(() => {});
          try {
            await ready;
            await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
          } finally {
            adapter.dispose();
          }
        } else {
          output = (await runExec(process.execPath, args, { logOutput: false })).stdout;
        }
        expect(Number(output)).toBe(transport === "one-shot" ? process.pid : broker.pid);
      });
    },
  );

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
