import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { captureRetainedNativeWorkerSource } from "../../infra/worker-native-lifecycle.js";
import { createSpawnBrokerHost } from "./host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = process.platform === "win32";

describe.skipIf(skipBrokerTests)("spawn broker startup failure", () => {
  it("starts a resource broker without the file reader and reports the missing reader for a command broker", async () => {
    const wrapper = path.join(tempDirs.make("openclaw-broker-reader-"), "broker.mts");
    writeFileSync(
      wrapper,
      `import { registerHooks } from "node:module";
       registerHooks({ resolve(specifier, context, nextResolve) {
         if (specifier === "@openclaw/fs-safe/advanced" && context.parentURL?.includes("/process/spawn-broker/")) {
           throw new Error("fixture file reader is unavailable");
         }
         return nextResolve(specifier, context);
       } });
       await import(${JSON.stringify(new URL("./worker.ts", import.meta.url).href)});`,
    );
    const workerUrl = pathToFileURL(wrapper);
    const resource = createSpawnBrokerHost({ workerUrl, nativeResources: true });
    try {
      await resource.ready();
    } finally {
      await resource.close();
    }
    const command = createSpawnBrokerHost({ workerUrl });
    try {
      await expect(command.ready()).rejects.toThrow("fixture file reader is unavailable");
    } finally {
      await command.close();
    }
  });

  it("keeps command capture mandatory only for hosts that can run commands", async () => {
    const wrapper = path.join(tempDirs.make("openclaw-attachment-broker-"), "broker.mts");
    writeFileSync(
      wrapper,
      `import { registerHooks } from "node:module";
       registerHooks({ resolve(specifier, context, nextResolve) {
         if (specifier === "./execa-worker.js" && context.parentURL?.includes("/process/spawn-broker/")) {
           throw new Error("fixture command handler is unavailable");
         }
         return nextResolve(specifier, context);
       } });
       await import(${JSON.stringify(new URL("./worker.ts", import.meta.url).href)});`,
    );
    const workerUrl = pathToFileURL(wrapper);
    const source = captureRetainedNativeWorkerSource({
      runtimeGeneration: {
        resolve: (url) => (/\/spawn-broker\/worker\.[jt]s$/u.test(url.pathname) ? workerUrl : url),
        retain() {},
      },
    });
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await source.retireIdleBroker();
    });
    const resource = await source.captureIndependentResource(
      new URL(
        "data:text/javascript,export function createNativeWorkerResource(port) { port.on('message', value => port.postMessage(value)); return { close() { port.close() } } }",
      ),
    );
    cleanup.defer(() => resource.close());
    const reply = once(resource.port, "message");
    resource.port.postMessage("captured", []);
    expect(await reply).toEqual(["captured"]);

    for (const options of [{ workerUrl }, { workerUrl, nativeResources: true as const }]) {
      const host = createSpawnBrokerHost(options);
      try {
        await expect(host.ready()).rejects.toThrow("fixture command handler is unavailable");
      } finally {
        await host.close();
      }
    }
  });

  it("imports without resolving defaults and starts an explicit captured source after Gateway fallback", () => {
    const hostUrl = new URL("./host.js", import.meta.url).href;
    const contextUrl = new URL("./context.js", import.meta.url).href;
    const registryUrl = new URL("../../infra/runtime-process-entrypoints.js", import.meta.url).href;
    const resolverUrl = new URL("../../infra/runtime-worker-url.js", import.meta.url).href;
    const unavailableDefault = `
      import {runtimeProcessEntrypoints as original} from ${JSON.stringify(registryUrl)};
      export const runtimeProcessEntrypoints = {
        ...original,
        spawnBroker: {...original.spawnBroker, currentModuleUrl: 'data:text/javascript,unavailable-default'},
      };
    `;
    const script = `
      import assert from 'node:assert/strict';
      import {fileURLToPath} from 'node:url';
      import nodeModule from 'node:module';
      const {runtimeProcessEntrypoints} = await import(${JSON.stringify(registryUrl)});
      const {resolveRuntimeWorkerUrl} = await import(${JSON.stringify(resolverUrl)});
      const captured = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.spawnBroker);
      nodeModule.registerHooks({resolve(specifier, context, nextResolve) {
        const importer = context.parentURL?.slice(0, -3);
        const requested = context.parentURL ? new URL(specifier, context.parentURL).href : specifier;
        if (importer === ${JSON.stringify(new URL("./host", import.meta.url).href)} && requested === ${JSON.stringify(registryUrl)}) {
          return {url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(unavailableDefault)}`)}, shortCircuit: true};
        }
        return nextResolve(specifier, context);
      }});
      process.stderr.write('captured broker source fixture pid=' + process.pid + '\\n');
      let host;
      const watchdog = setTimeout(() => process.exit(97), 15000);
      try {
        const context = await import(${JSON.stringify(contextUrl)});
        const {createSpawnBrokerHost} = await import(${JSON.stringify(hostUrl)});
        assert.throws(() => createSpawnBrokerHost(), {code: 'ERR_INVALID_URL_SCHEME'});
        const failures = [];
        let readyCalls = 0;
        const options = {onReady: () => readyCalls++, onStartupFailure: message => failures.push(message)};
        assert.equal(await context.startGatewaySpawnBroker(options), undefined);
        assert.equal(await context.startGatewaySpawnBroker(options), undefined);
        assert.equal(failures.length, 1);
        assert.match(failures[0], /in-process spawning/);
        assert.equal(readyCalls, 0);
        host = createSpawnBrokerHost({workerUrl: captured, nativeResources: true});
        assert.equal(host.entryPath, fileURLToPath(captured));
        await host.ready();
        assert.ok(host.pid > 0);
        await host.close();
        console.log(JSON.stringify({importsSucceeded: true, gatewayFallbackOnce: true, capturedSourceStartedAndClosed: true}));
      } finally {
        clearTimeout(watchdog);
        await host?.close();
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script],
      { cwd: process.cwd(), encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      importsSucceeded: true,
      gatewayFallbackOnce: true,
      capturedSourceStartedAndClosed: true,
    });
  }, 25_000);

  it("settles shutdown when the broker executable could not be launched", async () => {
    const executable = process.execPath;
    let host: ReturnType<typeof createSpawnBrokerHost>;
    try {
      process.execPath = path.join(tempDirs.make("openclaw-broker-missing-"), "node");
      host = createSpawnBrokerHost();
    } finally {
      process.execPath = executable;
    }
    await expect(host.ready()).rejects.toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
    await withTestTimeout(host.close(), 1_000, "broker shutdown waited for an uncreated process");
  });
});
