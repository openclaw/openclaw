import { pathToFileURL } from "node:url";
import { onTestFinished } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { createSpawnBrokerHost } from "./host.js";

export function brokerSpawnPreload(onSpawn: string, setup = "", afterPatch = "") {
  return `
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    if (/\\/spawn-broker\\/worker\\.(?:ts|js)$/.test(process.argv[1] ?? '')) {
      ${setup}
      const nativeSpawn = childProcess.spawn;
      childProcess.spawn = function(...args) {
        const child = nativeSpawn.apply(this,args);
        ${onSpawn}
        return child;
      };
      syncBuiltinESMExports();
      ${afterPatch}
    }
  `;
}

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
