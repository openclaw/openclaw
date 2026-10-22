import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { createSpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

const skipBrokerTests = !supportsSpawnBrokerCommandTransport();

describe.skipIf(skipBrokerTests)("spawn broker joined shutdown", () => {
  it("retains child cleanup until a stopped broker resumes its shutdown", async () => {
    const host = createSpawnBrokerHost();
    let childPid: number | undefined;
    let stopped = false;
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
      const closing = host.close();
      expect(isPidDefinitelyDead(host.pid!)).toBe(false);
      // A paused owner cannot settle native work. Resume it instead of treating
      // a watchdog kill as proof that its cleanup ran.
      process.kill(host.pid!, "SIGCONT");
      await closing;
      stopped = isPidDefinitelyDead(childPid!);
      expect(stopped).toBe(true);
      expect(isPidDefinitelyDead(host.pid!)).toBe(true);
    } finally {
      if (host.pid && !isPidDefinitelyDead(host.pid)) {
        process.kill(host.pid, "SIGCONT");
      }
      if (!stopped && childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
      await host.close();
    }
  }, 15_000);
});
