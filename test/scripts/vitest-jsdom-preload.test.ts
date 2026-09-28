import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());
const preload = new URL("../vitest/vitest.jsdom-preload.mts", import.meta.url).href;

async function run(root: string, args: string[], signal: AbortSignal) {
  let stdout = "";
  let stderr = "";
  const code = await lifetime.track(
    runManagedCommand({
      bin: resolveTestNodeExecPath(),
      args: ["--no-warnings", `--import=${preload}`, ...args],
      cwd: root,
      signal,
      timeoutMs: 10_000,
      requireProcessTreeExit: true,
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        child.stdout!.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr!.on("data", (chunk) => {
          stderr += String(chunk);
        });
      },
    }),
  );
  return { code, stdout, stderr };
}

it("leaves inherited fork and thread preloads inert outside Vitest workers", ({ signal }) =>
  lifetime.run(async () => {
    const root = lifetime.createTempDir("openclaw-preload-descendants-");
    const child = path.join(root, "child.mjs");
    fs.writeFileSync(
      child,
      `
      import { parentPort } from 'node:worker_threads';
      const flags = process.execArgv.includes('--no-warnings');
      if (parentPort) parentPort.postMessage({ kind: 'thread', flags });
      else process.send({ kind: 'fork', flags }, () => process.disconnect());
    `,
    );
    const parent = path.join(root, "parent.mjs");
    fs.writeFileSync(
      parent,
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
    const entrypoint = path.join(root, "vitest/dist/workers/forks.js");
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, "throw new Error('worker must not start');");
    const result = await run(root, [entrypoint], signal);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Cannot find module 'vitest/runtime'");
    expect(result.stderr).not.toContain("worker must not start");
  }));
