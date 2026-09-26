import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { createSpawnBrokerHost } from "./host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("spawn broker admission custody", () => {
  it("cleans a command when the broker dies before its pipes are ready", async () => {
    const host = createSpawnBrokerHost();
    const marker = path.join(tempDirs.make("openclaw-broker-handoff-"), "pid");
    let pid: number | undefined;
    let stoppedBroker: number | undefined;
    try {
      await host.ready();
      const child = host.spawn(
        "/bin/sh",
        ["-c", 'printf "%s" "$$" > "$1"; exec sleep 30', "fixture", marker],
        {
          stdio: Array.from({ length: 32 }, () => "pipe" as const),
          detached: true,
        },
      );
      const readiness = child.ready().catch((error: unknown) => error);
      const pipeDeadline = Date.now() + 5_000;
      while (!child.stdin && Date.now() < pipeDeadline) {
        await delay(0);
      }
      expect(child.stdin).not.toBeNull();
      stoppedBroker = host.pid;
      process.kill(stoppedBroker!, "SIGSTOP");
      const markerDeadline = Date.now() + 5_000;
      while (!pid && Date.now() < markerDeadline) {
        const content = await readFile(marker, "utf8").catch(() => "");
        pid = Number(content) || undefined;
        if (!pid) {
          await delay(10);
        }
      }
      expect(pid).toBeTypeOf("number");
      expect(child.pid).toBeUndefined();
      process.kill(stoppedBroker!, "SIGKILL");
      stoppedBroker = undefined;
      await expect(readiness).resolves.toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
      await host.close();
      expect(isPidDefinitelyDead(pid!)).toBe(true);
    } finally {
      for (const candidate of [stoppedBroker, pid]) {
        if (candidate) {
          try {
            process.kill(candidate, "SIGKILL");
          } catch {}
        }
      }
      await host.close();
    }
  }, 15_000);
});
