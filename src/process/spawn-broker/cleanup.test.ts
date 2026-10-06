import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../supervisor/cancellation-policy.js";
import { createSpawnBrokerHost } from "./host.js";

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("spawn broker forced shutdown", () => {
  it("retains child cleanup when a stopped broker requires forced shutdown", async () => {
    const host = createSpawnBrokerHost();
    let childPid: number | undefined;
    let stopped = false;
    let busyTimer: NodeJS.Timeout | undefined;
    try {
      await host.ready();
      const child = host.spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await child.ready();
      childPid = child.pid;
      expect(String((await once(child.stdout!, "data"))[0])).toBe("ready");
      // The broker cannot process disconnect or perform its own graceful cleanup.
      process.kill(host.pid!, "SIGSTOP");
      busyTimer = setTimeout(() => {
        // Let the old child-verification deadline expire before the broker watchdog runs.
        const resumeAt = performance.now() + 300;
        while (performance.now() < resumeAt) {
          /* Model delayed Gateway shutdown callbacks. */
        }
      }, GRACEFUL_CANCEL_TIMEOUT_MS + 1800);
      await host.close();
      stopped = isPidDefinitelyDead(childPid!);
      expect(stopped).toBe(true);
      expect(isPidDefinitelyDead(host.pid!)).toBe(true);
    } finally {
      clearTimeout(busyTimer);
      if (!stopped && childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
      await host.close();
    }
  }, 15_000);
});
