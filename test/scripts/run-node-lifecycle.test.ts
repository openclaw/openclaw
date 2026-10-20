import type { ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { toErrorObject } from "../../scripts/lib/error-format.mts";
import {
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "../../scripts/lib/local-build-metadata.mts";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { writeUpdateCompatibilityChunks } from "../../scripts/lib/update-compat-chunks.mts";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { listCoreRuntimePostBuildOutputs } from "../../scripts/runtime-postbuild.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mts";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { formatShimResult, withShimFixture } from "./direct-run-entrypoints.test-support.js";
import { preparedScriptWrapperEnv } from "./prepared-script-wrapper.test-support.js";
import { toolingMtsEntrypoints } from "./tooling-mts-runtime.test-support.mts";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

let receipts: FixtureReceiptChannel;
const modulesDir = path.dirname(
  path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
);
const finishOutcome = `if (typeof outcome === "string") process.kill(process.pid, outcome);
else process.exit(outcome);`;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});

function runnerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PNPM_CONFIG_MODULES_DIR: modulesDir,
    TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
    ...overrides,
  };
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
}

function writeRunner(file: string, body: string, call = "runNodeMain()", capture = true) {
  writeFileSync(
    file,
    `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
${capture ? "const spawn = childProcess.spawn;" : ""}
import { registerSourceRunnerServiceFixture } from ${JSON.stringify(sourceRunnerServiceFixtureUrl)};
registerSourceRunnerServiceFixture(${JSON.stringify(process.cwd())});
const { runNodeMain } = await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/run-node.mts")).href)});
${body}
syncBuiltinESMExports();
const outcome = await ${call};
${finishOutcome}
`,
  );
}

function expectCommand(result: Awaited<ReturnType<typeof runNodeScript>>, status: number) {
  expect(result.error, formatShimResult(result)).toBeUndefined();
  expect(result.status, formatShimResult(result)).toBe(status);
}

async function fixturePid(
  pidPath: string,
  command: ReturnType<typeof runNodeScript>,
  signal: AbortSignal,
): Promise<number> {
  // The fixture commits the PID before its receipt. The command may settle first
  // on the independent process channel; its durable record decides that race.
  const settled = command.then((result) => {
    if (!existsSync(pidPath) || !(Number(readFileSync(pidPath, "utf8")) > 0)) {
      throw new Error(`Missing PID receipt ${pidPath}: ${formatShimResult(result)}`);
    }
  });
  await withinTest(Promise.race([receipts.waitFor(pidPath, "ready"), settled]), signal);
  const pid = Number(readFileSync(pidPath, "utf8"));
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  return pid;
}

const sourceRunnerServiceFixtureUrl = new URL(
  "./fixtures/source-runner-service.mjs",
  import.meta.url,
).href;

function prepareRunnerEnv(env: NodeJS.ProcessEnv, implementations: string[] = []) {
  const source = (name: string) => new URL(`../../scripts/${name}.mts`, import.meta.url);
  const modules: Array<readonly [URL, URL]> = [
    [source("run-node"), resolveRuntimeWorkerUrl(toolingMtsEntrypoints.runNode)],
    [source("watch-node"), resolveRuntimeWorkerUrl(scriptModuleEntrypoints.watchNode)],
  ];
  for (const implementation of implementations) {
    // These generated fixtures are already JavaScript; prepare their bytes before the guard.
    const prepared = `${implementation}.mjs`;
    copyFileSync(implementation, prepared);
    modules.push([pathToFileURL(implementation), pathToFileURL(prepared)]);
  }
  return preparedScriptWrapperEnv(modules, env);
}

function writePrebuiltRuntime(root: string) {
  writeUpdateCompatibilityBuildFixture(root);
  writeUpdateCompatibilityChunks({
    distDir: path.join(root, "dist"),
    sourceDir: root,
    inventory: previousReleaseInventory,
  });
  const requiredOutputs = listCoreRuntimePostBuildOutputs({ rootDir: root });
  for (const relativePath of requiredOutputs) {
    const outputPath = path.join(root, relativePath);
    if (!existsSync(outputPath)) {
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, "fixture\n");
    }
  }
  expect(listCoreRuntimePostBuildOutputs({ rootDir: root })).toEqual(requiredOutputs);
  writeBuildStamp({ cwd: root });
  writeRuntimePostBuildStamp({ cwd: root });
}

it.runIf(process.platform !== "win32").for(["runner", "shim"] as const)(
  "preserves %s interruption while waiting for cleanup custody release",
  (mode, { signal }) =>
    withShimFixture("scripts/run-node.mjs", async (fixture) => {
      const { checkoutRoot, fixtureRoot, implementationPath, wrapperPath } = fixture;
      const interruptedReceipt = path.join(fixtureRoot, "interrupted");
      const signalPreload = path.join(fixtureRoot, "signal-receipt.mjs");
      writeFiles(fixtureRoot, {
        "signal-receipt.mjs": `${fixtureReceiptClientSource(receipts.endpoint)}
process.on("SIGTERM", () => sendReceipt(${JSON.stringify(interruptedReceipt)}, "interrupted"));
`,
        "checkout/package.json": '{"type":"module"}',
        "checkout/dist/entry.js": "export {};\n",
      });
      if (mode === "runner") {
        writeRunner(
          implementationPath,
          `import { EventEmitter } from "node:events";
childProcess.spawn = (_command, args) => {
  if (!args.includes("openclaw.mjs")) throw new Error("prebuilt fixture unexpectedly requested a build");
  const child = new EventEmitter();
  queueMicrotask(() => {
    process.stdout.write("fixture child completed successfully\\n");
    child.emit("exit", 0, null);
  });
  return child;
};
`,
          `runNodeMain({ cwd: ${JSON.stringify(checkoutRoot)}, args: ["gateway", "stop"] })`,
          false,
        );
      } else {
        writeFileSync(
          implementationPath,
          `import { writeSync } from "node:fs";
writeSync(1, "fixture implementation signaled\\n");
process.kill(process.pid, "SIGKILL");
`,
        );
      }
      const env = runnerEnv({
        OPENCLAW_RUNNER_LOG: "0",
        NODE_OPTIONS: `--import=${pathToFileURL(signalPreload).href}`,
      });
      delete env.OPENCLAW_FORCE_BUILD;
      delete env.OPENCLAW_FORCE_RUNTIME_POSTBUILD;
      const preparedEnv = prepareRunnerEnv(env, [implementationPath]);
      const releasePending = createDeferred();
      let runner: ChildProcess | undefined;
      let handoff: Socket | undefined;
      const command = runNodeScript(
        [mode === "runner" ? implementationPath : wrapperPath],
        preparedEnv,
        undefined,
        {
          cwd: checkoutRoot,
          signal,
          requireProcessTreeExit: true,
          onReady(child) {
            runner = child;
            const channel = child.stdio[3];
            if (!(channel instanceof Socket)) {
              throw new Error("Source runner did not receive a cleanup custody channel");
            }
            handoff = channel;
            let frames = "";
            let releaseObserved = false;
            channel.prependListener("data", (chunk: string) => {
              frames += chunk;
              if (!releaseObserved && /(?:^|\n)release [^\n]+\n/u.test(frames)) {
                releaseObserved = true;
                // Hold the real acknowledgement before the normal owner writes it.
                channel.cork();
                releasePending.resolve();
              }
            });
          },
        },
      );
      const waitForGate = (gate: Promise<unknown>, message: string) =>
        withinTest(awaitGateBeforeSettlement(gate, command, message), signal);
      try {
        await waitForGate(
          releasePending.promise,
          "Source runner exited before releasing cleanup custody",
        );
        expect(runner!.kill("SIGTERM")).toBe(true);
        await waitForGate(
          receipts.waitFor(interruptedReceipt, "interrupted"),
          "Source runner exited before observing interruption",
        );
        handoff!.uncork();
        const result = await withinTest(command, signal);
        expectCommand(result, 143);
        expect(result.stdout).toContain(
          mode === "runner"
            ? "fixture child completed successfully\n"
            : "fixture implementation signaled\n",
        );
      } finally {
        handoff?.uncork();
        await command;
      }
    }),
);

it.runIf(process.platform !== "win32")(
  "preserves gateway watch signal loss across compile-cache process replacement",
  ({ signal }) =>
    withShimFixture("scripts/run-node.mjs", async (fixture) => {
      const nodeArgs = resolveVitestNodeArgs();
      const { checkoutRoot, fixtureRoot, implementationPath } = fixture;
      const childPidPath = path.join(fixtureRoot, "child.pid");
      const childArgsPath = path.join(fixtureRoot, "child-args.json");
      const launcherPidPath = path.join(fixtureRoot, "launcher.pid");
      const invocationsPath = path.join(fixtureRoot, "invocations.jsonl");
      const releasePath = path.join(fixtureRoot, "release");
      for (const filename of [
        "openclaw.mjs",
        "cli-invocation.mjs",
        "node-host-launcher.mjs",
        "node-compile-cache.mjs",
        "node-version.mjs",
        "node-runtime-update.mjs",
        "node-runtime-recovery.mjs",
        "cli-parent-lifetime.mjs",
        "node-runtime-env.mjs",
        "cli-root-options.mjs",
        "gateway-run-argv.mjs",
        "gateway-shutdown-budget.mjs",
        "node-sqlite.mjs",
      ]) {
        copyFileSync(filename, path.join(checkoutRoot, filename));
      }
      mkdirSync(path.join(fixtureRoot, "home"));
      writeFiles(checkoutRoot, {
        "package.json": '{"type":"module"}',
        "src/entry.ts": "export {};\n",
        "dist/entry.js": `import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
fs.writeFileSync(${JSON.stringify(childArgsPath)}, JSON.stringify(process.execArgv));
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
sendReceipt(${JSON.stringify(childPidPath)}, "ready");
if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(0);
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(0);
}, 20);
`,
      });
      writeRunner(
        implementationPath,
        `import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
fs.appendFileSync(${JSON.stringify(invocationsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
// Let a regressed watcher finish after recording its doctor or restart invocation.
if (fs.existsSync(${JSON.stringify(childPidPath)})) process.exit(0);
childProcess.spawn = (command, args, options) => {
    if (!args.includes("openclaw.mjs")) throw new Error("prebuilt fixture unexpectedly requested a build");
    const child = spawn(command, [...${JSON.stringify(nodeArgs)}, ...args], options);
    fs.writeFileSync(${JSON.stringify(launcherPidPath)}, String(child.pid));
    sendReceipt(${JSON.stringify(launcherPidPath)}, "ready");
    return child;
};
`,
      );
      const watchWrapper = path.join(checkoutRoot, "scripts/watch-node.mjs");
      copyFileSync("scripts/watch-node.mjs", watchWrapper);
      const watcherUrl = pathToFileURL(path.resolve("scripts/watch-node.mts")).href;
      writeFileSync(
        path.join(checkoutRoot, "scripts/watch-node.mts"),
        `import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => spawn(command, [...${JSON.stringify(nodeArgs)}, ...args], options);
syncBuiltinESMExports();
registerHooks({
  load(url, context, nextLoad) {
    return url.includes("/watch-node-observation.")
      ? { format: "module", source: "export function createSourceObserver() { return { async close() {} }; }", shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { runWatchMain } = await import(${JSON.stringify(watcherUrl)});
const outcome = await runWatchMain();
${finishOutcome}
`,
      );
      const env = runnerEnv({
        HOME: path.join(fixtureRoot, "home"),
        OPENCLAW_HOME: path.join(fixtureRoot, "home"),
        OPENCLAW_STATE_DIR: path.join(fixtureRoot, "state"),
        OPENCLAW_CONFIG_PATH: path.join(fixtureRoot, "state/openclaw.json"),
        OPENCLAW_RUNNER_LOG: "0",
        OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR: "1",
        NODE_COMPILE_CACHE: path.join(fixtureRoot, "compile-cache"),
      });
      delete env.NODE_OPTIONS;
      delete env.NODE_DISABLE_COMPILE_CACHE;
      delete env.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED;
      delete env.OPENCLAW_FORCE_BUILD;
      delete env.OPENCLAW_FORCE_RUNTIME_POSTBUILD;
      const preparedEnv = prepareRunnerEnv(env, [
        implementationPath,
        path.join(checkoutRoot, "scripts/watch-node.mts"),
      ]);
      writePrebuiltRuntime(checkoutRoot);
      Object.assign(env, preparedEnv);
      let child: ChildProcess | undefined;
      const command = runNodeScript([...nodeArgs, watchWrapper, "gateway"], env, 10_000, {
        cwd: checkoutRoot,
        requireProcessTreeExit: true,
        onReady(runner) {
          child = runner;
        },
      });
      await runQaGatewayFixture(
        async () => {
          const [childPid, launcherPid] = await Promise.all(
            [childPidPath, launcherPidPath].map((pidPath) => fixturePid(pidPath, command, signal)),
          );
          expect(childPid, "process replacement preserves the supervised Gateway PID").toBe(
            launcherPid,
          );
          expect(
            JSON.parse(readFileSync(childArgsPath, "utf8")),
            "the respawned fixture child retains the Node shutdown policy",
          ).toContain("--no-concurrent-sparkplug");
          process.kill(childPid, "SIGKILL");
          const result = await withinTest(command, signal);
          expectCommand(result, 137);
          expect(child, formatShimResult(result)).toMatchObject({
            exitCode: null,
            signalCode: "SIGKILL",
          });
          expect(readFileSync(invocationsPath, "utf8")).toBe('["gateway"]\n');
        },
        async () => {
          // Release even a late-starting child, then join the inherited pipes and outer group.
          writeFileSync(releasePath, "release");
          const result = await command;
          if (result.error) {
            throw toErrorObject(result.error, "Gateway watch command failed");
          }
        },
      ).catch(async (error: unknown) => {
        const result = await command;
        const failure = toErrorObject(error, "Gateway watch fixture failed");
        failure.message += `\nGateway watch command:\n${formatShimResult(result)}`;
        if (hasUnjoinedWork(failure)) {
          // The shim fixture needs this marker at the top level to retain unjoined inputs.
          Object.assign(failure, { processTreeState: "indeterminate" });
        }
        throw failure;
      });
    }),
);

it.runIf(process.platform !== "win32").for(["runner", "watch"] as const)(
  "preserves native %s signal loss while a private-pipe worker survives",
  async (mode, { signal }) => {
    const root = mkdtempSync(path.join(path.dirname(tmpdir()), "openclaw-native-signal-"));
    const checkout = path.join(root, "checkout");
    const sourceRoot = process.cwd();
    const hook = fileURLToPath(new URL("./fixtures/native-runner-signals.mjs", import.meta.url));
    mkdirSync(path.join(checkout, ".git"));
    mkdirSync(path.join(root, "home"));
    writeFiles(root, {
      "receipts.mjs": `${fixtureReceiptClientSource(receipts.endpoint)}\nexport { sendReceipt };\n`,
      "checkout/package.json": '{"name":"openclaw-signal-fixture"}',
      "checkout/src/index.ts": "export {};\n",
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "state/openclaw.json"),
      OPENCLAW_FORCE_BUILD: "1",
      OPENCLAW_RUNNER_LOG: "0",
      OPENCLAW_TEST_NATIVE_RUNNER_ROOT: root,
      OPENCLAW_TEST_NATIVE_RUNNER_SOURCE: sourceRoot,
      OPENCLAW_TEST_NATIVE_RUNNER_MODE: mode,
      NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
      PNPM_CONFIG_MODULES_DIR: modulesDir,
    };
    const entrypoint = path.join(
      sourceRoot,
      "scripts",
      mode === "watch" ? "watch-node.mjs" : "run-node.mjs",
    );
    let child: ChildProcess | undefined;
    const command = runNodeScript([entrypoint, "gateway"], prepareRunnerEnv(env), 10_000, {
      cwd: checkout,
      onReady(runner) {
        child = runner;
      },
    });
    const pidPaths = ["implementation", "build", "worker"].map((role) =>
      path.join(root, `${role}.pid`),
    );
    await runQaGatewayFixture(
      async () => {
        const worker = await fixturePid(path.join(root, "worker.pid"), command, signal);
        expect(isProcessAlive(worker)).toBe(true);
        writeFileSync(path.join(root, "terminate"), "terminate");
        const result = await withinTest(command, signal);
        // The managed test command converts the actual OS signal to its shell
        // status. The old runner returns1; the old watch/doctor path returns0.
        expectCommand(result, 137);
        expect(child).toMatchObject({ exitCode: null, signalCode: "SIGKILL" });
        expect(existsSync(path.join(root, "doctor-started"))).toBe(false);
        expect(
          isProcessAlive(worker),
          "the fixture must retain the escaped worker until rescue",
        ).toBe(true);
        expect(result.stderr, formatShimResult(result)).not.toContain(
          "Native runner fixture received an unexpected spawn:",
        );
      },
      async () => {
        // This private release is independent of the native cleanup under test.
        // It also stops fixtures created while an early failure is unwinding.
        writeFileSync(path.join(root, "release"), "release");
        await command;
      },
      ...pidPaths.map((pidPath) => async () => {
        if (existsSync(pidPath)) {
          await waitForDead(Number(readFileSync(pidPath, "utf8")), signal);
        }
      }),
      () => {
        if (
          pidPaths.some(
            (pidPath) =>
              existsSync(pidPath) && isProcessAlive(Number(readFileSync(pidPath, "utf8"))),
          )
        ) {
          throw new Error(`Native signal fixture still owns processes; retained ${root}`);
        }
        rmSync(root, { recursive: true, force: true });
      },
    );
  },
);

it.runIf(process.platform !== "win32").for(["SIGTERM", "SIGHUP"] as const)(
  "joins the dev runner's resistant child before returning from %s",
  (stopSignal, { signal }) =>
    withShimFixture("scripts/run-node.mjs", async (fixture) => {
      const { checkoutRoot, fixtureRoot, implementationPath, wrapperPath, runNode } = fixture;
      mkdirSync(path.join(checkoutRoot, ".git"));
      const childPidPath = path.join(fixtureRoot, "child.pid");
      const wrapperPidPath = path.join(fixtureRoot, "wrapper.pid");
      const childPath = path.join(fixtureRoot, "resistant-child.mjs");
      writeFileSync(
        childPath,
        `import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
sendReceipt(${JSON.stringify(childPidPath)}, "ready");
setInterval(() => {}, 1000);
`,
      );
      writeRunner(
        implementationPath,
        `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.ppid));
childProcess.spawn = (_command, _args, options) => spawn(process.execPath, [${JSON.stringify(childPath)}], {
  ...options, stdio: "ignore",
});
`,
        `runNodeMain({ cwd: ${JSON.stringify(checkoutRoot)}, env: { ...process.env, OPENCLAW_FORCE_BUILD: "1", OPENCLAW_RUNNER_LOG: "0" } })`,
      );
      const env = runnerEnv();
      delete env.NODE_OPTIONS;
      const command = runNode(
        [wrapperPath],
        prepareRunnerEnv(env, [implementationPath]),
        checkoutRoot,
      );
      try {
        const childPid = await fixturePid(childPidPath, command, signal);
        // The implementation records its wrapper before runNodeMain can spawn the child.
        const wrapperPid = Number(readFileSync(wrapperPidPath, "utf8"));
        process.kill(wrapperPid, stopSignal);
        const result = await withinTest(command, signal);
        expect(result.error, formatShimResult(result)).toBeUndefined();
        expect(isProcessAlive(childPid), "the stopped runner still owns a live child").toBe(false);
        expect(result.status).not.toBe(0);
      } finally {
        // Negative controls can orphan a separate process group; the test owns its cleanup.
        const childPid = existsSync(childPidPath)
          ? Number(readFileSync(childPidPath, "utf8"))
          : undefined;
        if (childPid !== undefined && isProcessAlive(childPid)) {
          process.kill(-childPid, "SIGKILL");
        }
        await command;
        if (childPid !== undefined) {
          await waitForDead(childPid, signal);
        }
      }
    }),
);
