import { readFileSync } from "node:fs";
import { setTimeout as realDelay } from "node:timers/promises";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { afterAll, aroundEach, beforeAll, describe } from "vitest";
import { getSpawnBroker, runWithSpawnBroker } from "../../spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../spawn-broker/host.js";

/** Run the existing process-owner contracts through each supported POSIX transport. */
export function describeSpawnTransports(name: string, register: () => void): void {
  describe.skipIf(process.platform === "win32").each(["native", "broker"] as const)(
    `${name} (%s transport)`,
    (transport) => {
      if (transport === "broker") {
        let broker: ReturnType<typeof createSpawnBrokerHost>;
        beforeAll(async () => {
          broker = createSpawnBrokerHost();
          await broker.ready();
        });
        aroundEach((runTest) => runWithSpawnBroker(broker, runTest));
        afterAll(async () => {
          await broker.close();
        });
      }
      register();
    },
  );
}

/** Separate host fixtures must establish their own process-local broker context. */
export function serviceChildHostTransportPrelude(): string {
  if (!getSpawnBroker()) {
    return "const withTransport = (run) => run();";
  }
  return `
    const { createSpawnBrokerHost } = await import(${JSON.stringify(new URL("../../spawn-broker/host.ts", import.meta.url).href)});
    const { runWithSpawnBroker } = await import(${JSON.stringify(new URL("../../spawn-broker/context.ts", import.meta.url).href)});
    const broker = createSpawnBrokerHost();
    await broker.ready();
    const withTransport = (run) => runWithSpawnBroker(broker, run);
  `;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return extractErrorCode(error) === "EPERM";
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // kill(pid, 0) also succeeds for a terminated process awaiting reaping.
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    return false;
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for process state");
    }
    await realDelay(20);
  }
}
