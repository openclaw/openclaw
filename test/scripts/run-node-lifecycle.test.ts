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
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
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
import { isProcessAlive, waitForDead, waitForPidFile } from "../helpers/process-wait.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { formatShimResult, withShimFixture } from "./direct-run-entrypoints.test-support.js";
import { preparedScriptWrapperEnv } from "./prepared-script-wrapper.test-support.js";
import { toolingMtsEntrypoints } from "./tooling-mts-runtime.test-support.mts";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

const sourceRunnerServiceFixtureUrl = new URL(
  "./fixtures/source-runner-service.mjs",
  import.meta.url,
).href;

const preparedRunnerModules = [
  [
    new URL("../../scripts/run-node.mts", import.meta.url),
    resolveRuntimeWorkerUrl(toolingMtsEntrypoints.runNode),
  ],
  [
    new URL("../../scripts/watch-node.mts", import.meta.url),
    resolveRuntimeWorkerUrl(scriptModuleEntrypoints.watchNode),
  ],
] as const;

function prepareRunnerEnv(env: NodeJS.ProcessEnv, implementations: string[] = []) {
  const modules: Array<readonly [URL, URL]> = [...preparedRunnerModules];
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

it.runIf(process.platform !== "win32")(
  "stops gateway watch when a compile-cache respawn child dies from a signal",
  async () => {
    const nodeArgs = resolveVitestNodeArgs();
    await withShimFixture("scripts/run-node.mjs", async (fixture) => {
      const { checkoutRoot, fixtureRoot, implementationPath } = fixture;
      const childPidPath = path.join(fixtureRoot, "child.pid");
      const childArgsPath = path.join(fixtureRoot, "child-args.json");
      const launcherPidPath = path.join(fixtureRoot, "launcher.pid");
      const invocationsPath = path.join(fixtureRoot, "invocations.jsonl");
      const releasePath = path.join(fixtureRoot, "release");
      for (const filename of [
        "openclaw.mjs",
        "node-host-launcher.mjs",
        "node-compile-cache.mjs",
        "node-version.mjs",
        "node-runtime-update.mjs",
        "node-runtime-recovery.mjs",
        "cli-root-options.mjs",
        "gateway-run-argv.mjs",
        "gateway-shutdown-budget.mjs",
        "node-sqlite.mjs",
      ]) {
        copyFileSync(filename, path.join(checkoutRoot, filename));
      }
      mkdirSync(path.join(checkoutRoot, "src"));
      mkdirSync(path.join(checkoutRoot, "dist"));
      mkdirSync(path.join(fixtureRoot, "home"));
      writeFileSync(path.join(checkoutRoot, "package.json"), '{"type":"module"}');
      writeFileSync(path.join(checkoutRoot, "src/entry.ts"), "export {};\n");
      writeFileSync(
        path.join(checkoutRoot, "dist/entry.js"),
        `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(childArgsPath)}, JSON.stringify(process.execArgv));
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(0);
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(0);
}, 20);
`,
      );
      const sourceRoot = process.cwd();
      const runnerUrl = pathToFileURL(path.join(sourceRoot, "scripts/run-node.mts")).href;
      writeFileSync(
        implementationPath,
        `import fs from "node:fs";
import { spawn } from "node:child_process";
import { registerSourceRunnerServiceFixture } from ${JSON.stringify(sourceRunnerServiceFixtureUrl)};
registerSourceRunnerServiceFixture(${JSON.stringify(sourceRoot)});
const { runNodeMain } = await import(${JSON.stringify(runnerUrl)});
fs.appendFileSync(${JSON.stringify(invocationsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
// Let a regressed watcher finish after recording its doctor or restart invocation.
if (fs.existsSync(${JSON.stringify(childPidPath)})) process.exit(0);
const outcome = await runNodeMain({
  spawn: (command, args, options) => {
    if (!args.includes("openclaw.mjs")) throw new Error("prebuilt fixture unexpectedly requested a build");
    const child = spawn(command, [...${JSON.stringify(nodeArgs)}, ...args], options);
    fs.writeFileSync(${JSON.stringify(launcherPidPath)}, String(child.pid));
    return child;
  },
});
if (typeof outcome === "string") process.kill(process.pid, outcome);
else process.exit(outcome);
`,
      );
      const watchWrapper = path.join(checkoutRoot, "scripts/watch-node.mjs");
      copyFileSync("scripts/watch-node.mjs", watchWrapper);
      const watcherUrl = pathToFileURL(path.resolve("scripts/watch-node.mts")).href;
      writeFileSync(
        path.join(checkoutRoot, "scripts/watch-node.mts"),
        `import { spawn } from "node:child_process";
import { runWatchMain } from ${JSON.stringify(watcherUrl)};
const outcome = await runWatchMain({
  spawn: (command, args, options) => spawn(command, [...${JSON.stringify(nodeArgs)}, ...args], options),
  createWatcher: () => ({ on() {}, close() {} }),
});
if (typeof outcome === "string") process.kill(process.pid, outcome);
else process.exit(outcome);
`,
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: path.join(fixtureRoot, "home"),
        OPENCLAW_HOME: path.join(fixtureRoot, "home"),
        OPENCLAW_STATE_DIR: path.join(fixtureRoot, "state"),
        OPENCLAW_CONFIG_PATH: path.join(fixtureRoot, "state/openclaw.json"),
        OPENCLAW_RUNNER_LOG: "0",
        OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR: "1",
        NODE_COMPILE_CACHE: path.join(fixtureRoot, "compile-cache"),
        PNPM_CONFIG_MODULES_DIR: path.dirname(
          path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
        ),
        // The copied shim runs from a fixture cwd with no tsconfig; pin this
        // checkout so run-node.mts's profile graph resolves workspace imports.
        TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
      };
      delete env.NODE_OPTIONS;
      delete env.NODE_DISABLE_COMPILE_CACHE;
      delete env.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED;
      delete env.OPENCLAW_FORCE_BUILD;
      delete env.OPENCLAW_FORCE_RUNTIME_POSTBUILD;
      const runnerEnv = prepareRunnerEnv(env, [
        implementationPath,
        path.join(checkoutRoot, "scripts/watch-node.mts"),
      ]);
      writePrebuiltRuntime(checkoutRoot);
      Object.assign(env, runnerEnv);
      let observedExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const command = runNodeScript([...nodeArgs, watchWrapper, "gateway"], env, 10_000, {
        cwd: checkoutRoot,
        requireProcessTreeExit: true,
        onReady(child) {
          child.once("exit", (code, signal) => {
            observedExit = { code, signal };
          });
        },
      });
      await runQaGatewayFixture(
        async () => {
          const exitedBeforeReady = command.then((result) => {
            throw new Error(
              `Gateway watch exited before the compile-cache child was ready: ${formatShimResult(result)}`,
            );
          });
          const childPid = await Promise.race([
            waitForPidFile(childPidPath, 5_000),
            exitedBeforeReady,
          ]);
          const launcherPid = await Promise.race([
            waitForPidFile(launcherPidPath, 5_000),
            exitedBeforeReady,
          ]);
          expect(childPid, "the launcher must respawn before the signal is sent").not.toBe(
            launcherPid,
          );
          expect(
            JSON.parse(readFileSync(childArgsPath, "utf8")),
            "the respawned fixture child retains the Node shutdown policy",
          ).toContain("--no-concurrent-sparkplug");
          process.kill(childPid, "SIGKILL");
          const result = await command;
          expect(result.error, formatShimResult(result)).toBeUndefined();
          expect(observedExit, formatShimResult(result)).toEqual({ code: null, signal: "SIGKILL" });
          expect(result.status).toBe(137);
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
    });
  },
);

it.runIf(process.platform !== "win32").each(["runner", "watch"] as const)(
  "preserves native %s signal loss while a private-pipe worker survives",
  async (mode) => {
    const root = mkdtempSync(path.join(path.dirname(tmpdir()), "openclaw-native-signal-"));
    const checkout = path.join(root, "checkout");
    const sourceRoot = process.cwd();
    const hook = fileURLToPath(new URL("./fixtures/native-runner-signals.mjs", import.meta.url));
    mkdirSync(path.join(checkout, "src"), { recursive: true });
    mkdirSync(path.join(root, "home"));
    writeFileSync(path.join(checkout, "package.json"), '{"name":"openclaw-signal-fixture"}');
    writeFileSync(path.join(checkout, "src/index.ts"), "export {};\n");
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
      PNPM_CONFIG_MODULES_DIR: path.dirname(
        path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
      ),
    };
    const entrypoint = path.join(
      sourceRoot,
      "scripts",
      mode === "watch" ? "watch-node.mjs" : "run-node.mjs",
    );
    let observedExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const command = runNodeScript([entrypoint, "gateway"], prepareRunnerEnv(env), 10_000, {
      cwd: checkout,
      onReady(child) {
        child.once("exit", (code, signal) => {
          observedExit = { code, signal };
        });
      },
    });
    const pidPaths = ["implementation", "build", "worker"].map((role) =>
      path.join(root, `${role}.pid`),
    );
    await runQaGatewayFixture(
      async () => {
        const worker = await Promise.race([
          waitForPidFile(path.join(root, "worker.pid"), 5_000),
          command.then((result) => {
            throw new Error(
              `Native ${mode} exited before its worker started: ${formatShimResult(result)}`,
            );
          }),
        ]);
        expect(isProcessAlive(worker)).toBe(true);
        writeFileSync(path.join(root, "terminate"), "terminate");
        const result = await command;
        expect(result.error, formatShimResult(result)).toBeUndefined();
        // The managed test command converts the actual OS signal to its shell
        // status. The old runner returns1; the old watch/doctor path returns0.
        expect(result.status, formatShimResult(result)).toBe(137);
        expect(observedExit).toEqual({ code: null, signal: "SIGKILL" });
        expect(existsSync(path.join(root, "doctor-started"))).toBe(false);
        expect(
          isProcessAlive(worker),
          "the fixture must retain the escaped worker until rescue",
        ).toBe(true);
      },
      async () => {
        // This private release is independent of the native cleanup under test.
        // It also stops fixtures created while an early failure is unwinding.
        writeFileSync(path.join(root, "release"), "release");
        await command;
      },
      ...pidPaths.map((pidPath) => async () => {
        if (existsSync(pidPath)) {
          await waitForDead(Number(readFileSync(pidPath, "utf8")), 5_000);
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

it.runIf(process.platform !== "win32").each(["SIGTERM", "SIGHUP"] as const)(
  "joins the dev runner's resistant child before returning from %s",
  async (signal) => {
    await withShimFixture("scripts/run-node.mjs", async (fixture) => {
      const { checkoutRoot, fixtureRoot, implementationPath, wrapperPath, runNode } = fixture;
      const childPidPath = path.join(fixtureRoot, "child.pid");
      const wrapperPidPath = path.join(fixtureRoot, "wrapper.pid");
      const childPath = path.join(fixtureRoot, "resistant-child.mjs");
      writeFileSync(
        childPath,
        `import fs from "node:fs";
process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      const sourceRoot = process.cwd();
      const implementationUrl = pathToFileURL(path.join(sourceRoot, "scripts/run-node.mts")).href;
      writeFileSync(
        implementationPath,
        `import fs from "node:fs";
import { spawn } from "node:child_process";
import { registerSourceRunnerServiceFixture } from ${JSON.stringify(sourceRunnerServiceFixtureUrl)};
registerSourceRunnerServiceFixture(${JSON.stringify(sourceRoot)});
const { runNodeMain } = await import(${JSON.stringify(implementationUrl)});
fs.writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.ppid));
const outcome = await runNodeMain({
  cwd: ${JSON.stringify(checkoutRoot)},
  env: { ...process.env, OPENCLAW_FORCE_BUILD: "1", OPENCLAW_RUNNER_LOG: "0" },
  spawn: (_command, _args, options) => spawn(process.execPath, [${JSON.stringify(childPath)}], {
    ...options, stdio: "ignore",
  }),
});
if (typeof outcome === "string") process.kill(process.pid, outcome);
else process.exit(outcome);
`,
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PNPM_CONFIG_MODULES_DIR: path.dirname(
          path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
        ),
        // The copied shim runs from a fixture cwd with no tsconfig; pin this
        // checkout so run-node.mts's profile graph resolves workspace imports.
        TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
      };
      delete env.NODE_OPTIONS;
      const command = runNode(
        [wrapperPath],
        prepareRunnerEnv(env, [implementationPath]),
        checkoutRoot,
      );
      try {
        const childPid = await Promise.race([
          waitForPidFile(childPidPath, 5_000),
          command.then((result) => {
            throw new Error(
              `Dev runner exited before its child started: ${formatShimResult(result)}`,
            );
          }),
        ]);
        const wrapperPid = await waitForPidFile(wrapperPidPath, 5_000);
        process.kill(wrapperPid, signal);
        const result = await command;
        expect(result.error, formatShimResult(result)).toBeUndefined();
        expect(isProcessAlive(childPid), "the stopped runner still owns a live child").toBe(false);
        expect(result.status).not.toBe(0);
      } finally {
        // Negative controls can orphan a separate process group; the test owns its cleanup.
        if (existsSync(childPidPath)) {
          const childPid = Number(readFileSync(childPidPath, "utf8"));
          if (isProcessAlive(childPid)) {
            process.kill(-childPid, "SIGKILL");
          }
          await waitForDead(childPid, 5_000);
        }
        await command;
      }
    });
  },
);
