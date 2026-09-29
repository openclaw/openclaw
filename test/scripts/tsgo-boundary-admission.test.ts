import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireFileLock } from "@openclaw/fs-safe/file-lock";
import { root as openLockRoot } from "@openclaw/fs-safe/root";
import { afterEach, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { waitForPidFile } from "../helpers/process-wait.js";
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

function fixture() {
  const root = fs.realpathSync(lifetime.createTempDir("tsgo-admission-lifecycle-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  installDistArtifactScripts(root, ["check-tsgo-core-boundary.mts"], {
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

it.runIf(hasSemanticTestBackend())(
  "joins the boundary scheduler's compiler scope before releasing admission on cancellation",
  async ({ signal }) =>
    lifetime.run(async () => {
      const { root, env } = fixture();
      const compilerPidFile = path.join(root, "compiler.pid");
      const descendantPidFile = path.join(root, "descendant.pid");
      const descendant = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid));
`;
      fs.writeFileSync(
        path.join(root, "compiler.cjs"),
        `
#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { detached: true, stdio: "ignore" });
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(compilerPidFile)}, String(process.pid));
`.trimStart(),
      );
      const scheduler = path.join(root, "scheduler.mjs");
      fs.writeFileSync(
        scheduler,
        `
import { BOUNDARY_CHECKS, runChecks } from ${JSON.stringify(new URL("../../scripts/run-additional-boundary-checks.mts", import.meta.url).href)};
const check = BOUNDARY_CHECKS.find(check => check.label === "lint:tmp:tsgo-core-boundary");
process.exitCode = await runChecks([{
  ...check,
  args: [${JSON.stringify(path.join(root, "scripts/check-tsgo-core-boundary.mts"))}],
}], { concurrency: 1, checkTimeoutMs: 30000 }) ? 1 : 0;
`,
      );
      const running = start(root, env, [scheduler], signal);
      try {
        const pids = await Promise.all(
          [compilerPidFile, descendantPidFile].map((file) => waitForPidFile(file, 5000)),
        );
        const directory = path.join(root, ".cache/openclaw/semantic-checks");
        const receipt = fs.readdirSync(directory).find((file) => file.endsWith(".scope-owner"))!;
        const unit = fs.readFileSync(path.join(directory, receipt), "utf8").trim();
        expect(unit).toMatch(/^openclaw-check-[a-f0-9-]+\.scope$/u);
        running.cancel();
        expect(await running.completion, running.output()).toBe(143);
        expect(fs.readdirSync(directory)).toEqual([]);
        for (const pid of pids) {
          const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
          expect(state.stdout.trim() === "" || state.stdout.trim().startsWith("Z")).toBe(true);
        }
        const scope = spawnSync(
          "systemctl",
          ["--user", "show", "--property=LoadState", "--property=ControlGroup", unit],
          { encoding: "utf8", timeout: 5000 },
        );
        expect(scope.error).toBeUndefined();
        const fields = Object.fromEntries(
          scope.stdout
            .trim()
            .split("\n")
            .map((line) => line.split("=")),
        );
        if (fields.LoadState !== "not-found") {
          expect(fields.ControlGroup).toMatch(new RegExp("/" + unit.replaceAll(".", "\\.") + "$"));
          expect(
            fs.readFileSync(
              path.join("/sys/fs/cgroup", fields.ControlGroup!, "cgroup.events"),
              "utf8",
            ),
          ).toMatch(/^populated 0$/mu);
        }
      } finally {
        running.cancel();
        await Promise.allSettled([running.completion]);
        await lifetime.verifyCleanup(async () => stopSemanticFixtureScopes(root));
      }
    }),
);

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
