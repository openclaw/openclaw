import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { doctorOutputEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createNodeEvalArgs, resolveTestNodeExecPath } from "../test-utils/node-process.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const registrar = resolveRuntimeWorkerUrl(doctorOutputEntrypoints.maintenance);

// Keep the maintenance, restoration, signal, and console owners real. Native
// service and database adapters record effects only in this process's fixture.
function interruptionScript(
  eventsPath: string,
  pendingApproval: boolean,
  restoringApproval: boolean,
  progress: boolean,
) {
  return `
    import { registerHooks } from "node:module";
    import { once } from "node:events";
    import fs from "node:fs";
    const events = [];
    const record = event => { events.push(event); fs.writeFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(events)); };
    const env = { ...process.env };
    const root = process.env.HOME;
    const verdict = { kind: "owned", root, fingerprint: "fixture", refreshDefinition: false };
    const stopped = { stopped: true, inspected: true, runtimeInspected: true, running: false,
      offline: true, serviceEnv: env, serviceUpdateVerdict: verdict };
    const command = { programArguments: [process.execPath, root + "/openclaw.mjs", "gateway"] };
    const fixture = globalThis.doctorFixture = {
      record, env, root, verdict,
      async stop(params) {
        if (params.phase === "inspect") return { ...stopped, stopped: false, running: true, offline: false };
        params.onStopped(stopped);
        record("stopped");
        const proceed = once(process, "message");
        process.send("stopped");
        await proceed;
        await new Promise(setImmediate);
        return stopped;
      },
      repair: async cfg => { await fixture.approve(); return cfg; },
      service: { readCommand: async () => command, restart: async () => record("restart"), start: async () => record("restart") },
      state: { installed: true, running: false, env, command, loadState: { status: "loaded" }, runtime: { status: "stopped" } },
    };
    const overrides = new Map([
      ["/commands/doctor.js", 'export const doctorCommand = () => globalThis.doctorFixture.runDoctor();'],
      ["/config/paths.js", 'export const isDefaultInstallIdentity = () => true;'],
      ["/commands/doctor-service-repair-policy.js", 'export const shouldManageGatewayService = async () => true; export const isServiceRepairExternallyManaged = () => false; export const resolveUpdateParentGatewayActivation = () => undefined;'],
      ["/commands/doctor-maintenance-admission.js", 'export const resolveDoctorUpdateAdmission = () => ({ assertCurrent() {}, recordContinuation() {} });'],
      ["/commands/doctor-agent-lease-refusal.js", 'export const assertDoctorAgentLeaseAdmission = async () => {}; export const preflightExternalDoctorAgentLease = async () => {};'],
      ["/commands/doctor-maintenance-stale-service.js", 'export const inspectStaleDoctorGateway = async () => undefined;'],
      ["/infra/gateway-lock-legacy.js", 'export const assertLegacyGatewayStoppedForMaintenance = async () => {};'],
      ["/infra/gateway-lock.js", 'export const acquireGatewayLock = async () => { let active = true; return { assertCurrent() { if (!active) throw new Error("Fixture Gateway ownership released"); }, run(operation) { if (!active) throw new Error("Fixture Gateway ownership released"); return operation(); }, async release() { active = false; } }; };'],
      ["/state/openclaw-state-db-async-lifecycle.js", 'export const createOpenClawDatabaseMaintenanceScope = () => { let closed = false; return { run: run => run(), close: async () => { if (!closed) { globalThis.doctorFixture.record("stores-closed"); closed = true; } } }; };'],
      ["/cli/update-cli/update-command-service-maintenance.js", 'export const maybeStopManagedServiceBeforeMutableUpdate = params => globalThis.doctorFixture.stop(params); export const maybeResumeWindowsTaskAutoStartAfterPackageUpdate = async () => {}; export const revalidateManagedGatewayServiceAfterUpdate = async () => globalThis.doctorFixture.verdict;'],
      ["/commands/doctor-gateway-services.js", 'export const maybeRepairGatewayServiceConfig = cfg => globalThis.doctorFixture.repair(cfg);'],
      ["/daemon/service.js", 'export const resolveGatewayService = () => globalThis.doctorFixture.service; export const readGatewayServiceState = async () => globalThis.doctorFixture.state;'],
      ["/daemon/service-operation-lock.js", 'export const withGatewayServiceOperationLock = async (_env, run) => run(() => {});'],
      ["/cli/update-cli/update-command-service-plan.js", 'export const resolveUpdatedGatewayRestartPort = async () => 19871;'],
      ["/cli/daemon-cli/restart-health.js", 'export const waitForGatewayHealthyRestart = async () => { globalThis.doctorFixture.record("healthy"); return { healthy: true }; };'],
    ]);
    registerHooks({ resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (specifier.includes("?doctor-original")) return resolved;
      const override = [...overrides].find(([suffix]) => resolved.url.endsWith(suffix))?.[1];
      return override ? { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        "export * from " + JSON.stringify(resolved.url + "?doctor-original") + ";" + override
      ) } : resolved;
    } });
    const { enableConsoleCapture } = await import(${JSON.stringify(new URL("../../logging/console.js", registrar).href)});
    const { beginDoctorMaintenance } = await import(${JSON.stringify(new URL("../../commands/doctor-maintenance.js", registrar).href)});
    const { createNonExitingRuntime } = await import(${JSON.stringify(new URL("../../runtime.js", registrar).href)});
    enableConsoleCapture();
    fixture.runDoctor = async () => {
    if (${progress}) {
      const { spinner } = await import("@clack/prompts");
      const { PassThrough } = await import("node:stream");
      const output = new PassThrough();
      output.resume();
      spinner({ output }).start("Checking state");
    }
    const runtime = createNonExitingRuntime();
    const maintenance = await beginDoctorMaintenance({ root, options: { repair: true, nonInteractive: true },
      runtime });
    fixture.approve = async () => {
      const { PassThrough } = await import("node:stream");
      const { createDoctorPrompter } = await import(${JSON.stringify(new URL("../../commands/doctor-prompter.js", registrar).href)});
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      try {
        const prompter = createDoctorPrompter({ runtime, options: { repair: true }, signal: maintenance.signal });
        const pending = prompter.confirmRuntimeRepair({ message: "Repair fixture service?", requiresInteractiveConfirmation: true, input, output });
        process.send("approval");
        record(await pending ? "approval-accepted" : "approval-declined");
      } finally { input.destroy(); output.destroy(); }
    };
    let failure;
    try {
      try {
        await maintenance.run(async () => {
          if (${pendingApproval}) await fixture.approve();
          await new Promise(setImmediate);
          record("repair-complete");
        });
      } catch (error) { failure = error; record("repair-cancelled"); }
      finally { await maintenance.finish({}, ${restoringApproval} ? async cfg => cfg : undefined, failure); }
    } finally { await maintenance.release(); }
    };
    const { installCliSignalExitHandlers } = await import(${JSON.stringify(new URL("../signal-exit-barrier.js", registrar).href)});
    const { withCliProcessScope } = await import(${JSON.stringify(new URL("../runtime-cleanup-scope.js", registrar).href)});
    const { registerMaintenanceCommands } = await import(${JSON.stringify(registrar.href)});
    const { Command } = await import("commander");
    const { ExitError } = await import(${JSON.stringify(new URL("../../runtime.js", registrar).href)});
    installCliSignalExitHandlers();
    const program = new Command();
    registerMaintenanceCommands(program);
    // The synthetic prompt has no native input handle; retain its parent-control channel.
    process.channel.ref();
    try { await withCliProcessScope(() => program.parseAsync(["node", "openclaw", "doctor", "--fix", "--non-interactive"])); }
    catch (error) { if (!(error instanceof ExitError) || error.code !== 0) throw error; }
    finally { if (process.connected) process.disconnect(); }
  `;
}

it.skipIf(process.platform === "win32")(
  "preserves the embedding process's ignored SIGPIPE after maintenance releases",
  () => {
    const result = spawnSync(
      resolveTestNodeExecPath(),
      createNodeEvalArgs(`
        const { holdDoctorMaintenanceExit } = await import(${JSON.stringify(new URL("../../commands/doctor-maintenance-exit.js", registrar).href)});
        holdDoctorMaintenanceExit().release();
        process.kill(process.pid, "SIGPIPE");
        setImmediate(() => process.stdout.write("still running"));
      `),
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("still running");
  },
);

it.skipIf(process.platform === "win32").each([
  { interruption: "closed stdout", code: 0 },
  { interruption: "SIGINT", code: 130 },
  { interruption: "SIGTERM", code: 143 },
  { interruption: "SIGPIPE", code: 141 },
  { interruption: "SIGTERM with progress", code: 143 },
  { interruption: "SIGTERM while approving", code: 143 },
  { interruption: "SIGTERM while restoring", code: 143 },
] as const)(
  "restores its stopped Gateway before $interruption exits",
  async ({ interruption, code }) => {
    const root = dirs.make("doctor-interruption-");
    const eventsPath = path.join(root, "events.json");
    const pendingApproval = interruption === "SIGTERM while approving";
    const restoringApproval = interruption === "SIGTERM while restoring";
    const child = spawn(
      resolveTestNodeExecPath(),
      createNodeEvalArgs(
        interruptionScript(
          eventsPath,
          pendingApproval,
          restoringApproval,
          interruption === "SIGTERM with progress",
        ),
      ),
      {
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          OPENCLAW_UPDATE_RUN_ID: undefined,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout!.resume();
    const closed = once(child, "close");
    try {
      const ready = await Promise.race([
        once(child, "message"),
        closed.then(() => {
          throw new Error("Doctor exited before stopping its service: " + stderr);
        }),
      ]);
      expect(ready[0]).toBe("stopped");
      if (pendingApproval || restoringApproval) {
        const approval = once(child, "message");
        child.send("continue", () => {});
        expect((await approval)[0]).toBe("approval");
        child.kill("SIGTERM");
      } else if (interruption === "closed stdout") {
        child.stdout!.destroy();
      } else {
        child.kill(interruption === "SIGTERM with progress" ? "SIGTERM" : interruption);
      }
      if (!pendingApproval && !restoringApproval) {
        child.send("continue", () => {});
      }
      const [exitCode, signal] = await closed;
      expect(fs.existsSync(eventsPath), stderr).toBe(true);
      expect(JSON.parse(fs.readFileSync(eventsPath, "utf8")), stderr).toEqual([
        "stopped",
        ...(pendingApproval ? ["approval-declined"] : []),
        "repair-complete",
        "stores-closed",
        ...(restoringApproval ? ["approval-declined"] : []),
        "restart",
        "healthy",
      ]);
      expect(signal, stderr).toBeNull();
      expect(exitCode, stderr).toBe(code);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  },
);
