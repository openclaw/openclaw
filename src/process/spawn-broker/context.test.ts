import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { spawnBrokerContextEntrypoints } from "./context-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it
  .skipIf(process.platform === "win32")
  .each(["exit", "timeout", "low-memory", "small-host"] as const)(
  "keeps Gateway child spawning in-process after %s admission",
  async (failure) => {
    const lowMemory = failure === "low-memory" || failure === "small-host";
    const directory = tempDirs.make("openclaw-broker-startup-fallback-");
    const marker = path.join(directory, "attempts");
    const preload = path.join(directory, "exit-before-ready.mjs");
    await writeFile(
      preload,
      `
      import {appendFileSync} from 'node:fs';
      if (/\\/spawn-broker\\/worker\\.(?:ts|js)$/.test(process.argv[1] ?? '')) {
        appendFileSync(${JSON.stringify(marker)}, 'attempt\\n');
        ${failure === "timeout" ? "process.on('message',()=>{}); await new Promise(()=>{});" : "process.exit(73);"}
      }
    `,
    );
    const serverUrl = resolveRuntimeWorkerUrl(spawnBrokerContextEntrypoints.server);
    const execUrl = resolveRuntimeWorkerUrl(spawnBrokerContextEntrypoints.exec).href;
    const contextUrl = resolveRuntimeWorkerUrl(spawnBrokerContextEntrypoints.context).href;
    const stateKey = "openclaw.spawn-broker-startup-test";
    const coreSource = `
      import {runExec} from ${JSON.stringify(execUrl)};
      import {getSpawnBroker} from ${JSON.stringify(contextUrl)};
      const state = globalThis[Symbol.for(${JSON.stringify(stateKey)})];
      const parent = async () => state.parents.push(Number(
        (await runExec(process.execPath,['-e','console.log(String(process.ppid))'],{logOutput:false})).stdout
      ));
      export async function startGatewayServerCore() {
        state.brokers.push(getSpawnBroker()?.pid ?? null);
        await parent();
        return {startupSettled:Promise.resolve(),getTailscaleIngressEndpoint:()=>undefined,close:parent};
      }
    `;
    const loggerSource = `export const createSubsystemLogger = () => ({
        info() {}, error(message) {globalThis[Symbol.for(${JSON.stringify(stateKey)})].errors.push(message)}
      });`;
    const source = `
      import {existsSync,readFileSync,watch} from 'node:fs';
      import {registerHooks} from 'node:module';
      import os from 'node:os';
      import {mock} from 'node:test';
      const state = {parents:[],brokers:[],errors:[]};
      globalThis[Symbol.for(${JSON.stringify(stateKey)})] = state;
      Object.defineProperty(process,'platform',{value:'linux'});
      Object.defineProperty(process,'constrainedMemory',{value:()=>${failure === "low-memory" ? 768 * 1024 ** 2 : failure === "small-host" ? 2 * 1024 ** 3 : 0}});
      ${failure === "small-host" ? "mock.method(os,'totalmem',()=>1024 ** 3);" : ""}
      registerHooks({resolve(specifier,context,nextResolve) {
        if (${lowMemory} && context.parentURL === ${JSON.stringify(contextUrl)} &&
            new URL(specifier, context.parentURL).href === ${JSON.stringify(new URL("./host.js", contextUrl).href)}) {
          throw new Error('Constrained Gateway loaded the unused broker host');
        }
        if (context.parentURL === ${JSON.stringify(serverUrl.href)}) {
          const requested = specifier.startsWith('.') ? new URL(specifier, context.parentURL).href : specifier;
          if (requested === ${JSON.stringify(new URL("./server-start.js", serverUrl).href)}) return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(coreSource)}`)},shortCircuit:true};
          if (requested === ${JSON.stringify(new URL("../logging/subsystem.js", serverUrl).href)}) return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(loggerSource)}`)},shortCircuit:true};
        }
        return nextResolve(specifier,context);
      }});
      process.env.NODE_OPTIONS = ${JSON.stringify(`--import=${pathToFileURL(preload).href}`)};
      const realMonotonic = process.hrtime.bigint.bind(process.hrtime);
      let startupClockOffset = 0n;
      // The broker captures its clock at import; advance it with the startup timer below.
      const monotonic = ${failure === "timeout"}
        ? mock.method(process.hrtime, 'bigint', () => realMonotonic() + startupClockOffset)
        : undefined;
      const {startGatewayServer} = await import(${JSON.stringify(serverUrl.href)});
      // Load cleanup's native promise timers before faking the startup clock.
      if (${failure === "timeout"}) await import(${JSON.stringify(new URL("./host.js", contextUrl).href)});
      let attemptWatcher;
      try {
        const attempted = ${failure === "timeout"} ? new Promise((resolve,reject) => {
          const observe = () => {
            if (existsSync(${JSON.stringify(marker)}) && readFileSync(${JSON.stringify(marker)},'utf8').trim()) resolve();
          };
          attemptWatcher = watch(${JSON.stringify(directory)}, observe);
          attemptWatcher.on('error', reject);
          observe();
        }) : undefined;
        if (attempted) mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
        for (let count=0;count<2;count++) {
          const starting = startGatewayServer();
          if (attempted && count === 0) {
            await Promise.race([attempted, starting.then(() => {
              throw new Error('Gateway started before the broker readiness deadline');
            })]);
            attemptWatcher.close();
            startupClockOffset += 15_000_000_000n;
            mock.timers.tick(15_000);
          }
          const server = await starting;
          await server.close();
        }
        console.log(JSON.stringify({...state,hostPid:process.pid,attempts:existsSync(${JSON.stringify(marker)})?readFileSync(${JSON.stringify(marker)},'utf8').trim().split('\\n').length:0}));
      } finally {
        attemptWatcher?.close();
        mock.timers.reset();
        monotonic?.mock.restore();
      }
    `;
    const node = resolveTestNodeExecPath();
    const result = spawnSync(
      node,
      [
        ...resolveRuntimeWorkerArgv(serverUrl, node).slice(0, -1),
        "--input-type=module",
        "--eval",
        source,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed).toMatchObject({
      attempts: lowMemory ? 0 : 1,
      brokers: [null, null],
      parents: Array(4).fill(observed.hostPid),
    });
    if (lowMemory) {
      expect(observed.errors).toEqual([]);
      return;
    }
    expect(observed.errors).toHaveLength(1);
    expect(observed.errors[0]).toMatch(/before readiness|before becoming ready/);
    expect(observed.errors[0]).toContain(
      fileURLToPath(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.spawnBroker)),
    );
    if (failure === "timeout") {
      expect(observed.errors[0]).toContain("readiness deadline exceeded");
    }
    expect(observed.errors[0]).toContain("in-process spawning");
    expect(observed.errors[0]).not.toMatch(/[\r\n]/);
  },
  35_000,
);
