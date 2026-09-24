import type { ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { HostedGatewayStop } from "../../daemon/hosted-stop.js";
import type { GatewayServer } from "../../gateway/server-public.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createManagedServiceBoundaryCleanup } from "../../infra/update-managed-service-handoff-process.test-support.js";
import { updateExecutorEntrypoints } from "../cli-entrypoint.test-support.js";
import type { UpdateRespawnFixtures } from "./run-loop.test-support.js";

const removeFixturePath = fs.rm;
const sourceUrl = (key: keyof typeof updateExecutorEntrypoints) =>
  JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints[key]).href);

export async function startPackageLifecycleStopFixture(params: {
  fixtures: UpdateRespawnFixtures;
  control: string;
  signal: "SIGINT" | "SIGTERM" | "hosted Gateway stop";
  close: GatewayServer["close"];
  lockPort: number;
  isReleased: () => boolean;
  isServing: () => boolean;
  captureSignal: (signal: "SIGINT" | "SIGTERM") => () => void;
}) {
  const { fixtures, control, signal, close } = params;
  const hosted = signal === "hosted Gateway stop";
  const { start, started } = fixtures.createSignaledStart(close);
  const { runtime, exited } = fixtures.createRuntimeWithExitSignal();
  let earlyExit = false;
  let helperClosed = false;
  const hostedExecute = vi.fn<HostedGatewayStop["execute"]>();
  const hostedDispose = vi.fn<HostedGatewayStop["dispose"]>();
  if (hosted) {
    const native = await vi.importActual<typeof import("../../daemon/hosted-stop.js")>(
      "../../daemon/hosted-stop.js",
    );
    const assertHostedSettlement = () => {
      expect(params.isReleased()).toBe(true);
      expect(helperClosed).toBe(true);
      expect(fsSync.existsSync(path.join(control, "script-settled"))).toBe(true);
    };
    fixtures.hostedStopPrepare.mockImplementationOnce(async (...args) => {
      expect(args[0]).toEqual({ ownsProcessLifecycle: true, supervisor: null });
      const prepared = await native.prepareHostedGatewayStop(...args);
      const execute = prepared.execute.bind(prepared);
      const dispose = prepared.dispose.bind(prepared);
      hostedExecute.mockImplementation((assertCurrent) => {
        assertHostedSettlement();
        return execute(assertCurrent);
      });
      hostedDispose.mockImplementation(() => {
        assertHostedSettlement();
        return dispose();
      });
      prepared.execute = hostedExecute;
      prepared.dispose = hostedDispose;
      return prepared;
    });
  }
  const originalExit = runtime.exit.getMockImplementation()!;
  runtime.exit.mockImplementation((code) => {
    earlyExit ||= !params.isReleased();
    originalExit(code);
  });
  const waitingStop = createDeferred();
  fixtures.gatewayLog.info.mockImplementation((message) => {
    if (String(message).includes("stopping after foreground update settlement")) {
      waitingStop.resolve();
    }
  });
  await fixtures.runLoopWithStart({
    start,
    runtime,
    lockPort: params.lockPort,
    ownsProcessLifecycle: hosted,
  });
  await fixtures.waitForStart(started);
  const host = start.mock.calls[0]?.[0]?.hostLifecycle;
  if (!host) {
    throw new Error("missing registered host lifecycle");
  }
  return {
    runtime,
    exited,
    get earlyExit() {
      return earlyExit;
    },
    requestStop: async () => {
      if (signal === "hosted Gateway stop") {
        await expect(host.request("stop", () => {})).resolves.toEqual({
          ok: true,
          value: { outcome: "scheduled" },
        });
      } else {
        params.captureSignal(signal)();
      }
      await Promise.race([waitingStop.promise, exited]);
    },
    observeHelper(pid: number | undefined) {
      const spawned = fixtures.spawnProcess.mock.results.find(
        (result) => result.type === "return" && result.value.pid === pid,
      );
      if (!spawned || spawned.type !== "return") {
        throw new Error("missing hosted Stop helper process");
      }
      spawned.value.once("close", () => {
        helperClosed = true;
      });
    },
    async expectHostedPending() {
      expect(fixtures.captureForegroundUpdateHandoffStop).toHaveBeenCalledOnce();
      await expect(host.request("stop", () => {})).resolves.toMatchObject({ ok: false });
      expect(fixtures.hostedStopPrepare).toHaveBeenCalledOnce();
      expect(fixtures.captureForegroundUpdateHandoffStop).toHaveBeenCalledOnce();
      expect(params.isServing()).toBe(true);
      expect(close).not.toHaveBeenCalled();
      expect(hostedExecute).not.toHaveBeenCalled();
      expect(hostedDispose).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
    expectHostedCompleted() {
      expect(hostedExecute).toHaveBeenCalledOnce();
      expect(hostedDispose).toHaveBeenCalledOnce();
      expect(hostedExecute).toHaveBeenCalledBefore(hostedDispose);
      expect(hostedDispose).toHaveBeenCalledBefore(runtime.exit);
    },
  };
}

/** Pause the real preparation flight after its owner exists, before helper spawn. */
export async function gateFixtureHandoffPublication(root: string, handoffId: string) {
  const runtimeFs = (await import("node:fs/promises")).default;
  const write = runtimeFs.writeFile;
  const entered = createDeferred();
  const release = createDeferred();
  const publication = vi
    .spyOn(runtimeFs, "writeFile")
    .mockImplementation(async (target, data, options) => {
      if (
        typeof target === "string" &&
        path.basename(target) === "handoff.json" &&
        typeof data === "string"
      ) {
        const params = JSON.parse(data);
        if (params.updateLeaseKey === root && params.handoffId === handoffId) {
          entered.resolve();
          await release.promise;
        }
      }
      return write(target, data, options);
    });
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore: () => publication.mockRestore(),
  };
}

/** Observe only this fixture's helper; startup refusal remains the production decision. */
export async function observeFixtureHelper(
  root: string,
  handoffId: string,
  control: string,
  spawnProcess: UpdateRespawnFixtures["spawnProcess"],
) {
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const runtimeFs = (await import("node:fs/promises")).default;
  let helper: ChildProcess | undefined;
  let helperDirectory: string | undefined;
  let closed: Promise<void> | undefined;
  let stderr = "";
  const capture = async () => {
    if (helperDirectory) {
      const log = await fs
        .readFile(path.join(helperDirectory, "handoff.log"), "utf8")
        .catch(() => undefined);
      if (log !== undefined) {
        await fs.writeFile(path.join(control, "handoff.log"), log, { mode: 0o600 });
      }
    }
    if (stderr) {
      await fs.writeFile(path.join(control, "handoff.stderr.log"), stderr, { mode: 0o600 });
    }
  };
  spawnProcess.mockImplementation((command, args, options) => {
    const script = Array.isArray(args) ? args[0] : undefined;
    let matched = false;
    if (typeof script === "string" && path.basename(script) === "handoff.cjs") {
      const params = JSON.parse(
        fsSync.readFileSync(path.join(path.dirname(script), "handoff.json"), "utf8"),
      );
      matched = params.updateLeaseKey === root && params.handoffId === handoffId;
    }
    if (!matched) {
      return spawn(command, args, options);
    }
    helperDirectory = path.dirname(script!);
    // Only stderr visibility changes; argv, environment, IPC and ownership stay real.
    helper = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    helper.stderr?.on("data", (bytes) => {
      stderr = (stderr + String(bytes)).slice(-32768);
    });
    closed = new Promise((resolve) => {
      helper!.once("close", () => resolve());
    });
    return helper;
  });
  const removeSpy = vi.spyOn(runtimeFs, "rm").mockImplementation(async (target, options) => {
    if (helperDirectory && target === helperDirectory) {
      await capture().catch(() => undefined);
    }
    return removeFixturePath(target, options);
  });
  const cleanup = createManagedServiceBoundaryCleanup(() => [helper]);
  return {
    async waitForClose() {
      if (!closed) {
        throw new Error("fixture helper did not launch");
      }
      await withTimeout(closed, 15000);
    },
    async close() {
      const outcomes = await Promise.allSettled([
        cleanup(),
        ...(closed ? [withTimeout(closed, 15000)] : []),
      ]);
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      try {
        await capture();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, "Fixture helper cleanup did not settle");
      }
    },
    restore() {
      spawnProcess.mockImplementation(spawn);
      removeSpy.mockRestore();
    },
  };
}

export async function writePackageLifecycleFixture(root: string, control: string) {
  const bootstrap = `
        import fs from "node:fs/promises";
        import path from "node:path";
        if (${sourceUrl("sealedRegistry")}.endsWith(".ts")) {
          const { register } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)});
          register({ tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });
        }
        const { registerSealedRuntime } = await import(${sourceUrl("sealedRegistry")});
        registerSealedRuntime({ json5: undefined, resolveSecureTempRoot: () => ${JSON.stringify(control)} });
      `;
  await fs.writeFile(
    path.join(root, "dist", "cli", "daemon-cli.js"),
    `${bootstrap}
        const ledger = await import(${sourceUrl("ledger")});
        export const { adoptUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunStep, recordUpdateRunVerification } = ledger;
        const handoff = await import(${sourceUrl("handoff")});
        export const { assertForegroundUpdateOrigin } = handoff;
        `,
  );
  const entrypoint = path.join(root, "openclaw.mjs");
  await fs.writeFile(
    entrypoint,
    `${bootstrap}
        const root = ${JSON.stringify(root)}, control = ${JSON.stringify(control)};
        if (process.argv[2] === "triage") {
          process.stdout.write(JSON.stringify({ diagnostic: "isolated lifecycle fixture" }));
        } else {
          const handoff = await import(${sourceUrl("handoff")});
          const { readControlPlaneUpdateSentinelMeta } = await import(${sourceUrl("sentinel")});
          const { runGlobalPackageUpdateSteps } = await import(${sourceUrl("packageSteps")});
          const { createNpmTarget, createRootRunner } = await import(${sourceUrl("packageFixture")});
          const { writePackageDistInventory } = await import(${sourceUrl("inventory")});
          const { runCommandWithTimeout } = await import(${sourceUrl("exec")});
          const meta = await readControlPlaneUpdateSentinelMeta();
          const run = { runId: meta.runId, env: process.env };
          let outcome;
          try {
            outcome = await runGlobalPackageUpdateSteps({
              installTarget: createNpmTarget(path.dirname(root)), installSpec: "openclaw@2.0.0",
              packageName: "openclaw", packageRoot: root, timeoutMs: 30000,
              runCommand: createRootRunner(path.dirname(root)),
              validateCandidate: async () => [],
              beforeActivate: async () => {
                await fs.writeFile(path.join(control, "before-activate"), "lifecycle settled");
                await handoff.parkForegroundUpdateHandoff({ root, run });
              },
              runStep: async (step) => {
                if (step.name === "package-install") {
                  const prefix = step.argv[step.argv.indexOf("--prefix") + 1];
                  const candidate = path.join(prefix, "lib", "node_modules", "openclaw");
                  await fs.cp(root, candidate, { recursive: true });
                  await fs.writeFile(path.join(candidate, "package.json"), JSON.stringify({name:"openclaw",version:"2.0.0",type:"module"}));
                  await fs.mkdir(path.join(candidate, "scripts"), { recursive: true });
                  await fs.writeFile(path.join(candidate, ".openclaw-lifecycle-pending"), "pending candidate lifecycle\\n");
                  await fs.writeFile(path.join(candidate, "scripts", "preinstall-package-manager-warning.mjs"), ${JSON.stringify(`
                    import fs from "node:fs/promises";
                    import path from "node:path";
                    const control = ${JSON.stringify(control)};
                    await fs.appendFile(path.join(control, "script-calls"), "preinstall\\n");
                    await fs.writeFile(path.join(control, "script-entered"), String(process.pid));
                    while (!(await fs.access(path.join(control, "release-script")).then(() => true, () => false)))
                      await new Promise(resolve => setTimeout(resolve, 10));
                    await fs.writeFile(path.join(control, "script-settled"), "writer finished");
                  `)});
                  await fs.writeFile(path.join(candidate, "scripts", "postinstall-bundled-plugins.mjs"), ${JSON.stringify(`
                    import fs from "node:fs/promises";
                    import path from "node:path";
                    await fs.appendFile(${JSON.stringify(path.join(control, "script-calls"))}, "postinstall\\n");
                    await fs.rm(path.join(process.cwd(), ".openclaw-lifecycle-pending"));
                  `)});
                  await writePackageDistInventory(candidate);
                  await fs.writeFile(path.join(control, "stage.json"), JSON.stringify({prefix, packageRoot:candidate}));
                  return { name:step.name, command:step.argv.join(" "), cwd:step.cwd, durationMs:0, exitCode:0 };
                }
                const result = await runCommandWithTimeout(step.argv, {cwd:step.cwd,timeoutMs:step.timeoutMs});
                return { name:step.name, command:step.argv.join(" "), cwd:step.cwd, durationMs:0,
                  exitCode:result.code, stderrTail:result.stderr, signal:result.signal, killed:result.killed, termination:result.termination };
              },
            });
          } catch (error) {
            outcome = {steps:[], failedStep:{name:"activation",stderrTail:String(error)}, recovery:{serviceRestartSafe:false}};
          }
          await fs.writeFile(path.join(control, "outcome.json"), JSON.stringify(outcome));
          process.stdout.write(JSON.stringify({root,mode:"npm",status:outcome.failedStep?"error":"ok",
            reason:outcome.failedStep?"package-lifecycle-fixture-failed":undefined,
            steps:outcome.steps,recovery:outcome.recovery,after:{version:outcome.afterVersion??"1.0.0"}}));
          process.exitCode = outcome.failedStep ? 1 : 0;
          process.disconnect();
        }
        `,
  );
  const { writePackageDistInventory } =
    await import("../../../scripts/lib/package-dist-inventory.ts");
  await writePackageDistInventory(root);
  return entrypoint;
}
