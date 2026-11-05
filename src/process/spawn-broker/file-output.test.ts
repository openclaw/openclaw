import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { spawnProcessToFile } from "../spawn-to-file.js";
import { BrokerChild } from "./child.js";
import { runWithSpawnBroker } from "./context.js";
import { useSpawnBrokerTestFixture } from "./host.test-support.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const startBroker = useSpawnBrokerTestFixture(afterEach);

describe.skipIf(!supportsSpawnBrokerCommandTransport())("process-owned output files", () => {
  it.each([false, true])(
    "keeps stdout out of the host and refuses overwrite (bounded=%s)",
    async (bounded) => {
      const broker = await startBroker();
      const directory = directories.make("openclaw-broker-output-");
      const outputPath = path.join(directory, "output");
      const prefix = `${broker!.pid}:${!bounded}:`;
      const payload = Buffer.from(`${prefix}${"x".repeat(256 * 1024)}`);
      const run = await runWithSpawnBroker(broker, () =>
        spawnProcessToFile(
          process.execPath,
          [
            "-e",
            "const fs=require('node:fs'); fs.writeSync(1,`${process.ppid}:${fs.fstatSync(1).isFile()}:`); fs.writeSync(1,'x'.repeat(256*1024));",
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
          { path: outputPath, ...(bounded ? { maxBytes: payload.length } : {}) },
        ),
      );
      const closed = new Promise<void>((resolve) => {
        run.child.once("close", () => resolve());
      });
      await expect(run.output).resolves.toBe(payload.length);
      await closed;
      expect(run.child.stdout).toBeNull();
      expect(await fs.readFile(outputPath)).toEqual(payload);
      expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600);
      const refused = await runWithSpawnBroker(broker, () =>
        spawnProcessToFile(
          process.execPath,
          ["-e", "process.stdout.write('replacement')"],
          { stdio: "ignore" },
          { path: outputPath },
        ),
      );
      await expect(refused.output).rejects.toMatchObject({ code: "EEXIST" });
      expect(await fs.readFile(outputPath)).toEqual(payload);
    },
  );

  it("rejects an oversized chunk before writing it and closes the file", async () => {
    const broker = await startBroker();
    const outputPath = path.join(directories.make("openclaw-broker-output-limit-"), "output");
    const run = await runWithSpawnBroker(broker, () =>
      spawnProcessToFile(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(1024))"],
        { stdio: ["ignore", "pipe", "ignore"] },
        { path: outputPath, maxBytes: 16 },
      ),
    );
    const closed = new Promise<void>((resolve) => {
      run.child.once("close", () => resolve());
    });
    await expect(run.output).rejects.toMatchObject({ code: "ERR_PROCESS_OUTPUT_LIMIT" });
    await closed;
    expect((await fs.stat(outputPath)).size).toBe(0);
    await fs.rm(outputPath);
  });

  it("checks launch authority after opening the destination", async () => {
    const broker = await startBroker();
    const outputPath = path.join(directories.make("openclaw-broker-output-refuse-"), "output");
    let checked = false;
    const run = await runWithSpawnBroker(broker, () =>
      spawnProcessToFile(
        process.execPath,
        ["-e", "process.stdout.write('not admitted')"],
        { stdio: "ignore" },
        { path: outputPath },
        () => {
          checked = true;
          throw new Error("authority revoked");
        },
      ),
    );
    await expect(run.output).rejects.toThrow("launch authority refused");
    expect(checked).toBe(true);
    expect(run.child.pid).toBeUndefined();
    expect((await fs.stat(outputPath)).size).toBe(0);
  });

  it.each(["kill", "broker-close", "broker-crash"] as const)(
    "settles writer custody after %s",
    async (action) => {
      const broker = await startBroker();
      const outputPath = path.join(directories.make("openclaw-broker-output-stop-"), "output");
      const run = await runWithSpawnBroker(broker, () =>
        spawnProcessToFile(
          process.execPath,
          [
            "-e",
            "const fs=require('node:fs'); fs.writeSync(1,'ready'); process.stderr.write('ready'); setInterval(()=>fs.writeSync(1,'more'),1);",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
          { path: outputPath, maxBytes: 1024 * 1024 },
        ),
      );
      const closed = new Promise<void>((resolve) => {
        run.child.once("close", () => resolve());
      });
      await once(run.child, "spawn");
      await once(run.child.stderr!, "data");
      if (action === "kill") {
        run.child.kill("SIGKILL");
        await run.output;
      } else if (action === "broker-close") {
        const stopped = broker!.close();
        await expect(run.output).rejects.toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
        await stopped;
      } else {
        process.kill(broker!.pid!, "SIGKILL");
        await expect(run.output).rejects.toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
        await broker!.waitForCleanup();
      }
      await closed;
      expect(isPidDefinitelyDead(run.child.pid!)).toBe(true);
      await fs.writeFile(outputPath, "writer closed");
      expect(await fs.readFile(outputPath, "utf8")).toBe("writer closed");
    },
  );
});

it.each([undefined, 16])(
  "preserves native failed-launch errors with output limit %s",
  async (maxBytes) => {
    const directory = directories.make("openclaw-file-output-spawn-error-");
    const outputPath = path.join(directory, "output");
    const run = await spawnProcessToFile(
      path.join(directory, "missing-command"),
      [],
      { stdio: ["ignore", "pipe", "ignore"] },
      { path: outputPath, maxBytes },
    );
    await expect(run.output).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(outputPath)).size).toBe(0);
    await fs.rm(outputPath);
  },
);

it("keeps native exit visible while broker-owned file output is pending", async () => {
  const child = new BrokerChild(1, ["fixture"], async () => {}, true);
  child.receive({
    type: "spawned",
    id: 1,
    pid: 123,
    spawnfile: "fixture",
    spawnargs: [],
    connected: false,
    stdioLength: 3,
  });
  const exited = once(child, "exit");
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  child.receive({ type: "exit", id: 1, code: 7, signal: null });
  await exited;
  expect(child.exitCode).toBe(7);
  expect(closed).toBe(false);
  child.settleFileOutput();
  await child.waitForClose();
  expect(closed).toBe(true);
});
