import { pathToFileURL } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it } from "vitest";
import { resolveTsxImport } from "../../scripts/lib/tsx-cli-shim.mjs";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());
const preload = new URL("../vitest/vitest.jsdom-preload.mts", import.meta.url).href;

async function run(root: string, args: string[], signal: AbortSignal) {
  const result = await lifetime.track(
    runNodeScript(
      [
        "--no-warnings",
        "--import",
        resolveTsxImport(process.cwd()),
        `--import=${preload}`,
        ...args,
      ],
      process.env,
      10_000,
      { cwd: root, signal, maxBuffer: 128 * 1024, requireProcessTreeExit: true },
    ),
  );
  if (result.error !== undefined) {
    throw toErrorObject(result.error, "Node preload command failed");
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

it("leaves inherited fork and thread preloads inert outside Vitest workers", ({ signal }) =>
  lifetime.run(async () => {
    const root = lifetime.createTempDir("openclaw-preload-descendants-");
    const { write } = fixtureFiles(root);
    const child = write(
      "child.mjs",
      `
      import { parentPort } from 'node:worker_threads';
      const flags = process.execArgv.includes('--no-warnings');
      if (parentPort) parentPort.postMessage({ kind: 'thread', flags });
      else process.send({ kind: 'fork', flags }, () => process.disconnect());
    `,
    );
    const parent = write(
      "parent.mjs",
      `
      import { fork } from 'node:child_process';
      import { Worker } from 'node:worker_threads';
      const wait = child => new Promise((resolve, reject) => {
        let message;
        child.once('message', value => { message = value; });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve(message) : reject(new Error('exit ' + code)));
      });
      const forked = fork(${JSON.stringify(child)}, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      const thread = new Worker(new URL(${JSON.stringify(pathToFileURL(child).href)}));
      console.log(JSON.stringify(await Promise.all([wait(forked), wait(thread)])));
    `,
    );
    const result = await run(root, [parent], signal);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { kind: "fork", flags: true },
      { kind: "thread", flags: true },
    ]);
  }));

it("does not require an entrypoint for ordinary eval commands", ({ signal }) =>
  lifetime.run(async () => {
    const result = await run(
      lifetime.createTempDir("openclaw-preload-eval-"),
      ["--eval", "process.stdout.write('ok')"],
      signal,
    );
    expect(result).toEqual({ code: 0, stdout: "ok", stderr: "" });
  }));

it("keeps runtime resolution failures fatal for recognized Vitest workers", ({ signal }) =>
  lifetime.run(async () => {
    const root = lifetime.createTempDir("openclaw-preload-invalid-worker-");
    const entrypoint = fixtureFiles(root).write(
      "vitest/dist/workers/forks.js",
      "throw new Error('worker must not start');",
    );
    const result = await run(root, [entrypoint], signal);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Cannot find module 'vitest/runtime'");
    expect(result.stderr).not.toContain("worker must not start");
  }));
