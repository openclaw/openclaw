import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSpawnBrokerHost } from "./host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("spawn broker recovery budget", () => {
  it("recovers after more than five independently healthy generations", async () => {
    let onRecovered: ((pid: number) => void) | undefined;
    const host = createSpawnBrokerHost({ onReady: (pid) => onRecovered?.(pid) });
    try {
      await host.ready();
      const runHealthyCommand = async () => {
        const child = host.spawn(
          process.execPath,
          ["-e", "process.stdout.write(String(process.ppid))"],
          {
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        await child.ready();
        let stdout = "";
        child.stdout!.on("data", (chunk) => {
          stdout += chunk;
        });
        await child.waitForClose();
        expect(Number(stdout)).toBe(host.pid);
      };
      for (let cycle = 0; cycle < 7; cycle += 1) {
        await runHealthyCommand();
        const previousPid = host.pid!;
        const recovered = createDeferredCore<number>();
        onRecovered = recovered.resolve;
        process.kill(previousPid, "SIGKILL");
        const nextPid = await withTestTimeout(
          recovered.promise,
          5000,
          `Broker recovery ${cycle + 1} did not become ready`,
        );
        expect(nextPid).not.toBe(previousPid);
        await host.ready();
      }
      await runHealthyCommand();
    } finally {
      await host.close();
    }
  }, 20_000);
  it("stops after bounded consecutive recovery failures following a healthy startup", async () => {
    const directory = tempDirs.make("openclaw-broker-restarts-");
    const marker = path.join(directory, "starts");
    const preload = path.join(directory, "fail-startup.mjs");
    await writeFile(
      preload,
      `
      import {appendFileSync,existsSync} from 'node:fs';
      if (/\\/spawn-broker\\/worker\\.(?:ts|js)$/.test(process.argv[1] ?? '')) {
        const recovering = existsSync(${JSON.stringify(marker)});
        appendFileSync(${JSON.stringify(marker)}, 'start\\n');
        if (recovering) process.exit(1);
      }
    `,
    );
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${previousNodeOptions ?? ""} --import=${pathToFileURL(preload).href}`;
    const host = createSpawnBrokerHost();
    const starts = async () => (await readFile(marker, "utf8")).trim().split("\n").length;
    try {
      await host.ready();
      process.kill(host.pid!, "SIGKILL");
      await vi.waitFor(
        async () => {
          expect(await starts()).toBeGreaterThanOrEqual(6);
        },
        { timeout: 7000 },
      );
      await expect(host.ready()).rejects.toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
      await delay(2500);
      expect(await starts()).toBe(6);
    } finally {
      await host.close();
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
    }
  }, 15_000);
});
