import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it("reaps the source compiler before disposing its worker or reporting clean completion", () => {
  const directory = temp.make("plugin-compiler-exit-");
  fs.writeFileSync(path.join(directory, "entry.mts"), "export const value: number = 42;");
  const owner = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.sourceBuild).href;
  const compile = `
    const { buildPluginTypeScriptSource } = await import(${JSON.stringify(owner)});
    const { createRequire } = await import('node:module');
    const build = buildPluginTypeScriptSource(${JSON.stringify(directory)});
    const output = build.resolve(${JSON.stringify(path.join(directory, "entry.mts"))}, 'native', 'module');
    if (createRequire(output)(output).value !== 42) throw new Error('Wrong source output');
    await build.dispose();
  `;
  const result = spawnNodeEvalSync(
    `
    import { Worker } from 'node:worker_threads';
    import { execFileSync } from 'node:child_process';
    import { once } from 'node:events';
    ${compile}
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(
      ${JSON.stringify(compile)} + "const {parentPort}=await import('node:worker_threads'); parentPort.postMessage('closed');"
    )));
    await once(worker, 'message');
    await worker.terminate();
    if (process.platform !== 'win32') {
      const children = execFileSync('ps', ['-axo', 'ppid=,comm='], {encoding: 'utf8'})
        .split('\\n').filter(line => {
          const [parent, ...command] = line.trim().split(/\\s+/);
          return Number(parent) === process.pid && !command.join(' ').endsWith('ps');
        });
      if (children.length) throw new Error('Compiler children survived disposal: ' + children.join('; '));
    }
    console.log('completed cleanly');
  `,
    { timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "" } },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("completed cleanly");
});
