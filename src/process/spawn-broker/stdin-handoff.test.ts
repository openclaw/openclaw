import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("spawn broker stdin handoff", () => {
  let host: SpawnBrokerHost;
  beforeAll(async () => {
    host = createSpawnBrokerHost();
    await host.ready();
  });
  afterAll(async () => {
    await host.close();
  });

  it("settles short-lived commands whose stdin closes while pipe transfer is queued", async () => {
    const brokerPid = host.pid;
    const commands = Array.from({ length: 24 }, (_, index) => {
      const child = host.spawn("/bin/sh", ["-c", `printf '${index}'`], { stdio: "pipe" });
      const result = (async () => {
        await child.ready();
        let output = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr!.resume();
        const closed = once(child, "close");
        child.stdin?.end();
        expect(await closed).toEqual([0, null]);
        expect(output).toBe(String(index));
      })();
      void result.catch(() => {});
      return result;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const resumeAt = performance.now() + 200;
    while (performance.now() < resumeAt) {
      // Children can exit while the Gateway delays descriptor acknowledgments.
    }
    await Promise.all(commands);
    expect(host.pid).toBe(brokerPid);
  });
});
