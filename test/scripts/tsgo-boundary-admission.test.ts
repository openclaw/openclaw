import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireFileLock } from "@openclaw/fs-safe/file-lock";
import { root as openLockRoot } from "@openclaw/fs-safe/root";
import { afterEach, expect, it } from "vitest";
import { withDistArtifactOwnership } from "../../scripts/lib/dist-artifact-ownership.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { createDeferred } from "../helpers/promise.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";
import {
  hasSemanticTestBackend,
  overrideNativeFixtureExecutable,
  semanticFixtureEnv,
  stopSemanticFixtureScopes,
} from "./native-boundary-fixture.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());

function fixture(script = "check-tsgo-core-boundary.mts") {
  const root = fs.realpathSync(lifetime.createTempDir("tsgo-admission-lifecycle-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  installDistArtifactScripts(root, [script], {
    compiler: false,
    dependencies: ["@openclaw/fs-safe"],
  });
  const compiler = path.join(root, "compiler.cjs");
  fs.writeFileSync(
    compiler,
    [
      "#!/usr/bin/env node",
      "require('node:fs').appendFileSync('compiler-calls', 'called\\n');",
      "if(process.argv.includes('--showConfig')) console.log(JSON.stringify({files:[]}));",
    ].join("\n"),
  );
  fs.chmodSync(compiler, 0o755);
  overrideNativeFixtureExecutable(root, compiler);
  return { root, env: semanticFixtureEnv(root) };
}

function start(root: string, env: NodeJS.ProcessEnv, args: string[], signal: AbortSignal) {
  const ready = createDeferred();
  const observed = createDeferred();
  let child: ChildProcess | undefined;
  let output = "";
  const completion = lifetime.track(
    runManagedCommand({
      bin: process.execPath,
      args,
      cwd: root,
      env,
      signal,
      timeoutMs: 20_000,
      stdio: ["pipe", "pipe", "pipe"],
      requireProcessTreeExit: true,
      onReady(started) {
        child = started;
        for (const stream of [started.stdout!, started.stderr!]) {
          stream.on("data", (chunk) => {
            output = (output + String(chunk)).slice(-65536);
            if (output.includes("fixture-ready") || output.includes("[memory] waiting")) {
              ready.resolve();
            }
            if (output.includes("fixture-signal")) {
              observed.resolve();
            }
          });
        }
      },
    }),
  );
  const event = (promise: Promise<void>) =>
    Promise.race([
      promise,
      completion.then((code) => {
        throw new Error("Fixture exited before barrier: " + code + "\n" + output);
      }),
    ]);
  return {
    completion,
    ready: () => event(ready.promise),
    observed: () => event(observed.promise),
    cancel: () => child!.kill("SIGTERM"),
    release: () => child?.stdin?.end("release"),
    output: () => output,
  };
}

function installHook(
  root: string,
  env: NodeJS.ProcessEnv,
  parent: string,
  specifier: string,
  replacement: string,
) {
  const hook = path.join(root, "hook.mjs");
  fs.writeFileSync(
    hook,
    [
      "import {registerHooks} from 'node:module';",
      "registerHooks({resolve(specifier,context,next){",
      "if(context.parentURL===" +
        JSON.stringify(pathToFileURL(path.join(root, parent)).href) +
        " && specifier===" +
        JSON.stringify(specifier) +
        ")",
      "return {url:'data:text/javascript,'+encodeURIComponent(" +
        JSON.stringify(replacement) +
        "),shortCircuit:true};",
      "return next(specifier,context);}});",
    ].join("\n"),
  );
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, "--import=" + pathToFileURL(hook).href].join(" "),
  };
}

const barrier = [
  "await new Promise(resolve=>{",
  "process.once('SIGTERM',()=>console.error('fixture-signal'));",
  "process.stdin.once('data',()=>{process.stdin.pause();resolve()});",
  "console.error('fixture-ready');",
  "});",
].join("\n");

it.runIf(hasSemanticTestBackend()).for(["admission", "between queries"] as const)(
  "preserves boundary cancellation during %s without a later compiler",
  async (phase, { signal }) =>
    lifetime.run(async () => {
      const { root, env } = fixture();
      let lock: Awaited<ReturnType<typeof acquireFileLock>> | undefined;
      let commandEnv = env;
      if (phase === "admission") {
        const directory = path.join(root, ".cache/openclaw/semantic-checks");
        fs.mkdirSync(directory, { recursive: true });
        const lockPath = path.join(directory, os.hostname() + ".lock");
        lock = await acquireFileLock(lockPath, {
          lockPath,
          lockRoot: await openLockRoot(directory),
          payload: () => ({ pid: process.pid, startedAt: Date.now(), scopeReceipt: "fixture" }),
        });
      } else {
        const admission = pathToFileURL(
          path.join(root, "scripts/lib/semantic-check-admission.mts"),
        ).href;
        commandEnv = installHook(
          root,
          env,
          "scripts/check-tsgo-core-boundary.mts",
          "./lib/semantic-check-admission.mts",
          [
            "import {runSemanticCheck as run} from " + JSON.stringify(admission) + ";",
            "export async function runSemanticCheck(options){const code=await run(options);",
            barrier,
            "return code;}",
          ].join("\n"),
        );
      }
      const running = start(
        root,
        commandEnv,
        [path.join(root, "scripts/check-tsgo-core-boundary.mts")],
        signal,
      );
      try {
        await running.ready();
        running.cancel();
        if (phase === "between queries") {
          await running.observed();
          running.release();
        }
        expect(await running.completion, running.output()).toBe(143);
        expect(running.output()).toContain("interrupted by SIGTERM");
        expect(running.output().trimEnd()).toMatch(/\[tsgo-boundary\] FAILED \(exit 143\)$/u);
        const calls = path.join(root, "compiler-calls");
        expect(fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "").toBe(
          phase === "admission" ? "" : "called\n",
        );
      } finally {
        running.release();
        await Promise.allSettled([running.completion]);
        await lifetime.verifyCleanup(async () => {
          const results = await Promise.allSettled([
            lock?.release(),
            Promise.resolve().then(() => stopSemanticFixtureScopes(root)),
          ]);
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length) {
            throw new AggregateError(failures, "Fixture cleanup failed");
          }
        });
      }
    }),
);

it.runIf(hasSemanticTestBackend())(
  "does not certify compiler completion when canceled during artifact release",
  async ({ signal }) =>
    lifetime.run(async () => {
      const { root, env } = fixture("run-tsgo.mts");
      const lockModule = pathToFileURL(
        createRequire(import.meta.url).resolve("@openclaw/fs-safe/file-lock"),
      ).href;
      const hooked = installHook(
        root,
        env,
        "scripts/lib/dist-artifact-lock.mts",
        "@openclaw/fs-safe/file-lock",
        [
          "import {acquireFileLock as acquire} from " + JSON.stringify(lockModule) + ";",
          "export async function acquireFileLock(...args){",
          "const lock=await acquire(...args);return {...lock,async release(){",
          barrier,
          "return await lock.release();}};}",
        ].join("\n"),
      );
      const args = [path.join(root, "scripts/run-tsgo.mts"), "-p", "fixture.json"];
      const running = start(root, { ...hooked, OPENCLAW_CI_STATIC_EVIDENCE: "1" }, args, signal);
      try {
        await running.ready();
        running.cancel();
        await running.observed();
        running.release();
        expect(await running.completion, running.output()).toBe(143);
        expect(running.output()).toContain("[ci-static:tsgo:leaf]");
        expect(running.output()).not.toContain("[ci-static:tsgo:completion]");
        expect(fs.existsSync(path.join(root, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(
          false,
        );
        await withDistArtifactOwnership(root, async () => {});
      } finally {
        running.release();
        await Promise.allSettled([running.completion]);
        await lifetime.verifyCleanup(async () => stopSemanticFixtureScopes(root));
      }
    }),
);
