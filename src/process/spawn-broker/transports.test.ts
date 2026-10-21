import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommandBuffered, runExec } from "../exec.js";
import { prepareOomScoreAdjustedSpawn } from "../linux-oom-score.js";
import { createChildAdapter } from "../supervisor/adapters/child.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

describe.skipIf(!supportsSpawnBrokerCommandTransport())("Gateway spawn transports", () => {
  let broker: ReturnType<typeof createSpawnBrokerHost>;

  beforeAll(async () => {
    broker = createSpawnBrokerHost();
    await broker.ready();
  });

  afterAll(() => broker?.close());

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
      const output = text(child.stdout!);
      expect(await once(child, "close")).toEqual([0, null]);
      expect((await output).trim()).toBe(enabled ? "1000" : original.trim());
      expect(child.spawnfile).toBe("/bin/cat");
    }
    expect(await readFile(scorePath, "utf8")).toBe(original);
  });

  it.each(["exec", "buffered", "adapter", "one-shot"] as const)("routes %s", async (transport) => {
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
        const result = await ready.then(() => adapter.wait()).finally(() => adapter.dispose());
        expect(result).toEqual({ code: 0, signal: null });
      } else {
        output = (await runExec(process.execPath, args, { logOutput: false })).stdout;
      }
      expect(Number(output)).toBe(transport === "one-shot" ? process.pid : broker.pid);
    });
  });

  it("preserves runExec launch error metadata across asynchronous readiness", async () => {
    const command = "/openclaw-nonexistent-spawn-broker-command";
    const run = () => runExec(command, [], { logOutput: false }).catch((error: unknown) => error);
    const local = await run();
    const remote = await runWithSpawnBroker(broker, run);
    expect(local).toBeInstanceOf(Error);
    const message = (local as Error).message;
    expect(remote).toMatchObject({ code: "ENOENT", failed: true, stdout: "", stderr: "", message });
  });
});
