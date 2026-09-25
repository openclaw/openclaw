import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { spawnBrokerContextEntrypoints } from "./context-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("Gateway spawn transport initialization", () => {
  it.each(["exit", "timeout"] as const)(
    "logs first-start %s and keeps subsequent Gateway starts in-process",
    async (failure) => {
      const directory = tempDirs.make("openclaw-broker-startup-fallback-");
      const marker = path.join(directory, "attempts");
      const preload = path.join(directory, "exit-before-ready.mjs");
      await writeFile(
        preload,
        `
      import {appendFileSync} from 'node:fs';
      if (/\\/spawn-broker\\/worker\\.(?:ts|js)$/.test(process.argv[1] ?? '')) {
        appendFileSync(${JSON.stringify(marker)}, 'attempt\\n');
        ${failure === "exit" ? "process.exit(73);" : "process.on('message',()=>{}); await new Promise(()=>{});"}
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
      async function parent() {
        const result = await runExec(process.execPath,['-e','console.log(process.ppid)'],{logOutput:false});
        state.parents.push(Number(result.stdout));
      }
      export async function startGatewayServerCore() {
        state.brokers.push(getSpawnBroker()?.pid ?? null);
        await parent();
        return {startupSettled:Promise.resolve(),getTailscaleIngressEndpoint:()=>undefined,close:parent};
      }
    `;
      const loggerSource = `
      const state = globalThis[Symbol.for(${JSON.stringify(stateKey)})];
      export function createSubsystemLogger() {
        return {info() {},error(message) {state.errors.push(message)}};
      }
    `;
      const source = `
      import {readFileSync} from 'node:fs';
      import {registerHooks} from 'node:module';
      const state = {parents:[],brokers:[],errors:[]};
      globalThis[Symbol.for(${JSON.stringify(stateKey)})] = state;
      Object.defineProperty(process,'platform',{value:'linux'});
      registerHooks({resolve(specifier,context,nextResolve) {
        if (context.parentURL === ${JSON.stringify(serverUrl.href)}) {
          const requested = specifier.startsWith('.') ? new URL(specifier, context.parentURL).href : specifier;
          if (requested === ${JSON.stringify(new URL("./server-start.js", serverUrl).href)}) return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(coreSource)}`)},shortCircuit:true};
          if (requested === ${JSON.stringify(new URL("../logging/subsystem.js", serverUrl).href)}) return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(loggerSource)}`)},shortCircuit:true};
        }
        return nextResolve(specifier,context);
      }});
      process.env.NODE_OPTIONS = ${JSON.stringify(`--import=${pathToFileURL(preload).href}`)};
      const {startGatewayServer} = await import(${JSON.stringify(serverUrl.href)});
      for (let count=0;count<2;count++) {
        const server = await startGatewayServer();
        await server.close();
      }
      console.log(JSON.stringify({...state,hostPid:process.pid,attempts:readFileSync(${JSON.stringify(marker)},'utf8').trim().split('\\n').length}));
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
      expect(observed.attempts).toBe(1);
      expect(observed.brokers).toEqual([null, null]);
      expect(observed.parents).toEqual(Array(4).fill(observed.hostPid));
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
});
