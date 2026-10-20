import { pathToFileURL } from "node:url";
import { onTestFinished } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { createSpawnBrokerHost } from "./host.js";

export async function startPreloadedBroker(preload: string) {
  return withEnvAsync(
    { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}` },
    async () => {
      const host = createSpawnBrokerHost();
      onTestFinished(() => host.close());
      await host.ready();
      return host;
    },
  );
}

export function signalFixturePid(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL") {
  if (pid) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}
