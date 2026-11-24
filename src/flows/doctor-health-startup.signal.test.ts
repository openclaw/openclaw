import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { doctorOutputEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const registrar = resolveRuntimeWorkerUrl(doctorOutputEntrypoints.maintenance);

it
  .skipIf(process.platform === "win32")
  .each(["package root", "source config", "Tailscale prerequisite"])(
  "naturally exits on SIGTERM during %s after releasing owned handles",
  (phase) => {
    const root = dirs.make("doctor-startup-signal-");
    const result = spawnNodeEvalSync(
      `
      import { registerHooks } from 'node:module';
      import fs from 'node:fs/promises';
      import { Worker } from 'node:worker_threads';
      import { createServer } from 'node:net';
      const closed = [];
      const interrupt = () => process.kill(process.pid, 'SIGTERM');
      const fixture = globalThis.startupFixture = {
        armed: false,
        wait(signal) {
          if (!signal) return new Promise(() => {});
          return new Promise((_, reject) => {
            const handle = setInterval(() => {}, 1000);
            signal.addEventListener('abort', () => {
              clearInterval(handle); closed.push('read'); reject(signal.reason);
            }, { once: true });
            interrupt();
          });
        },
        readPackage(file, options) {
          if (fixture.armed && ${JSON.stringify(phase)} === 'package root') {
            // Model a pending filesystem request whose owner must receive cancellation.
            if (!options?.signal) { setInterval(() => {}, 1000); interrupt(); }
            return fixture.wait(options?.signal);
          }
          return fs.readFile(file, options);
        },
        readConfig() {
          if (fixture.armed && ${JSON.stringify(phase)} === 'source config') {
            interrupt(); return new Promise(() => {});
          }
          return Promise.resolve({ gateway: { tailscale: { mode: 'serve' } } });
        },
        async command(argv, options) {
          const actual = await import(${JSON.stringify(new URL("../../process/exec.js?startup-original", registrar).href)});
          if (argv[0] !== 'tailscale') return actual.runUtf8CommandWithTimeout(argv, options);
          const result = await actual.runUtf8CommandWithTimeout(
            [process.execPath, '-e', 'setInterval(() => {}, 1000); console.log("ready");'],
            { ...options, onOutputChunk() { interrupt(); } },
          );
          closed.push('child-aborted:' + result.killIssuedByAbort);
          return result;
        },
      };
      const overrides = new Map([
        ['/infra/openclaw-root.fs.runtime.js', 'export const openClawRootFs = { ...original.openClawRootFs, readFile: (...args) => globalThis.startupFixture.readPackage(...args) };'],
        ['/config/io.runtime.js', 'export const readSourceConfigBestEffort = () => globalThis.startupFixture.readConfig();'],
        ['/process/exec.js', 'export const runUtf8CommandWithTimeout = (...args) => globalThis.startupFixture.command(...args);'],
      ]);
      registerHooks({ resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        if (specifier.includes('?startup-original')) return resolved;
        const override = [...overrides].find(([suffix]) => resolved.url.endsWith(suffix))?.[1];
        return override ? { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
          'import * as original from ' + JSON.stringify(resolved.url + '?startup-original') + '; export * from ' + JSON.stringify(resolved.url + '?startup-original') + ';' + override
        ) } : resolved;
      } });
      const { prepareDoctorHealthFlow, withDoctorProgress } = await import(${JSON.stringify(new URL("../../flows/doctor-health-startup.js", registrar).href)});
      const { withCliProcessScope, withCliCommandCleanup } = await import(${JSON.stringify(new URL("../runtime-cleanup-scope.js", registrar).href)});
      const { installCliDoctorSignalExitHandlers, waitForCliSignalExit } = await import(${JSON.stringify(new URL("../signal-exit-barrier.js", registrar).href)});
      const { createNonExitingRuntime } = await import(${JSON.stringify(new URL("../../runtime.js", registrar).href)});
      process.exit = process.reallyExit = () => { throw new Error('Forced exit is forbidden'); };
      process.once('beforeExit', () => console.log('natural:' + closed.sort().join(',')));
      try {
        await withCliProcessScope(() => withCliCommandCleanup(false, async cleanup => {
          const resources = cleanup.pluginResources;
          installCliDoctorSignalExitHandlers();
          const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
          resources.adopt({ release: async () => { await worker.terminate(); closed.push('worker'); } });
          const timer = setInterval(() => {}, 1000);
          resources.adopt({ release: async () => { clearInterval(timer); closed.push('timer'); } });
          const socket = createServer();
          await new Promise((resolve, reject) => socket.once('error', reject).listen('doctor.sock', resolve));
          resources.adopt({ release: () => new Promise((resolve, reject) => socket.close(error => {
            if (error) reject(error); else { closed.push('socket'); resolve(); }
          })) });
          try {
            await resources.run(() => {
              fixture.armed = true;
              return withDoctorProgress('startup', () => prepareDoctorHealthFlow(createNonExitingRuntime(), {}, () => {}), true);
            });
          } finally { await resources.release(); }
        }));
        throw new Error('Doctor ignored SIGTERM');
      } catch (error) {
        if (await waitForCliSignalExit() !== 143) throw error;
      }
    `,
      {
        cwd: root,
        timeout: 10_000,
        env: { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result, result.stderr).toMatchObject({ status: 143, signal: null });
    const prefix =
      phase === "package root"
        ? "read,"
        : phase === "Tailscale prerequisite"
          ? "child-aborted:true,"
          : "";
    expect(result.stdout).toContain(`natural:${prefix}socket,timer,worker`);
  },
);
