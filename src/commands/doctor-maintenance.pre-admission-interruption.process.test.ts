import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { doctorOutputEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createNodeEvalArgs, resolveTestNodeExecPath } from "../test-utils/node-process.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const registrar = resolveRuntimeWorkerUrl(doctorOutputEntrypoints.maintenance);

it.skipIf(process.platform === "win32").for([
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const)(
  "settles %s during archive preparation before entering maintenance",
  async ([signal, code], { signal: testSignal }) => {
    const home = directories.make("doctor-pre-admission-interruption-");
    // Keep command and signal owners real; interrupt the synthetic database inspection.
    const overrides = {
      "/commands/doctor-database-preflight.js": `import { once } from "node:events";
      export async function prepareDoctorDatabasePreflight() {
        // Retain the existing parent channel until OS signal delivery settles.
        process.channel.ref();
        try {
          const interrupted = once(process, ${JSON.stringify(signal)});
          const proceed = once(process, "message");
          process.send("preflight");
          await proceed;
          process.kill(process.pid, ${JSON.stringify(signal)});
          await interrupted;
        } finally {
          process.disconnect();
        }
        console.log("preflight settled");
        return { incompatible: [], indeterminate: [] };
      }`,
      "/commands/doctor-maintenance.js": `export async function beginDoctorMaintenance() {
        throw new Error("maintenance must not start after interruption");
      }`,
    };
    const child = spawn(
      resolveTestNodeExecPath(),
      createNodeEvalArgs(`
      import { registerHooks } from "node:module";
      const overrides = new Map(Object.entries(${JSON.stringify(overrides)}));
      registerHooks({ resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        if (specifier.includes("?original")) return resolved;
        const override = [...overrides].find(([suffix]) => resolved.url.endsWith(suffix))?.[1];
        return override ? { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
          "export * from " + JSON.stringify(resolved.url + "?original") + ";" + override
        ) } : resolved;
      } });
      const { withCliProcessScope, withCliCommandCleanup } = await import(${JSON.stringify(new URL("../runtime-cleanup-scope.js", registrar).href)});
      const { runCliWithExitFinalization } = await import(${JSON.stringify(new URL("../one-shot-exit.js", registrar).href)});
      const { closeCliResources } = await import(${JSON.stringify(new URL("../runtime-cleanup.js", registrar).href)});
      const { registerMaintenanceCommands } = await import(${JSON.stringify(registrar.href)});
      const { Command } = await import("commander");
      const program = new Command();
      registerMaintenanceCommands(program);
      await runCliWithExitFinalization({
        run: () => withCliProcessScope(() => withCliCommandCleanup(false, async cleanup => {
          try {
            await cleanup.pluginResources.run(() =>
              program.parseAsync(["node", "openclaw", "doctor", "--fix", "--non-interactive"]));
          } finally {
            await closeCliResources(cleanup);
            await cleanup.pluginResources.release();
          }
        })),
        onError: error => { console.error(String(error)); process.exitCode = 1; },
      });
    `),
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: path.join(home, "state"),
          OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          OPENCLAW_UPDATE_RUN_ID: undefined,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const output = { stdout: "", stderr: "" };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]!.setEncoding("utf8").on("data", (chunk) => {
        output[stream] += chunk;
      });
    }
    const closed = once(child, "close");
    try {
      const ready = await withinTest(
        awaitGateBeforeSettlement(
          once(child, "message"),
          closed,
          "Doctor exited before archive preparation",
        ),
        testSignal,
      );
      expect(ready[0], output.stderr).toBe("preflight");
      // Bound interruption settlement, without charging cold CLI imports to that deadline.
      const settlement = withinTest(
        closed,
        AbortSignal.any([testSignal, AbortSignal.timeout(10_000)]),
      );
      child.send("continue");
      expect(await settlement, output.stderr).toEqual([code, null]);
      expect(output.stdout, output.stderr).toContain("preflight settled");
      expect(output.stderr).not.toMatch(/maintenance must not start|unsettled top-level await/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  },
);
