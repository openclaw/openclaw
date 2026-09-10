import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { isProcessAlive, waitForDead, waitForPidFile } from "../helpers/process-wait.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { formatShimResult, withShimFixture } from "./direct-run-entrypoints.test-support.js";

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
    const command = runNodeScript([entrypoint, "gateway"], env, 10_000, {
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
        const worker = await waitForPidFile(path.join(root, "worker.pid"), 5_000);
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
      const implementationUrl = pathToFileURL(path.resolve("scripts/run-node.mts")).href;
      writeFileSync(
        implementationPath,
        `import fs from "node:fs";
import { spawn } from "node:child_process";
import { runNodeMain } from ${JSON.stringify(implementationUrl)};
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
      };
      delete env.NODE_OPTIONS;
      const command = runNode([wrapperPath], env, checkoutRoot);
      try {
        const childPid = await waitForPidFile(childPidPath, 5_000);
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
