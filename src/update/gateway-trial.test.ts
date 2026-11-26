import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import type * as PluginLifecycleClient from "../cli/plugins-lifecycle-client.js";
import { resolvePluginBatchReload } from "../cli/plugins-lifecycle-client.js";
import type * as InspectionOwner from "../cli/update-cli/update-command-post-activation-inspections.js";
import { runPostActivationInspections } from "../cli/update-cli/update-command-post-activation-inspections.js";
import type * as DoctorContributions from "../flows/doctor-health-contributions.js";
import type * as UpdateNotices from "../gateway/update-run-notice.runtime.js";
import * as watcherModule from "../gateway/update-run-watcher.js";
import * as rootModule from "../infra/openclaw-root.js";
import { createGatewayUpdateLifecycle } from "../infra/update-check-lifecycle.js";
import type * as UpdateInstallStatus from "../infra/update-install-status.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { renderUpdateRunReport } from "../infra/update-run-report.js";
import { createUpdateRunAsync, recordUpdateRunStepAsync } from "../infra/update-run-write.async.js";
import type * as ProcessExec from "../process/exec.js";
import type { SpawnResult } from "../process/exec.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { killProcessTree } from "../process/kill-tree.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { VERSION } from "../version.js";
import { announceReady, settleRunFromTrial } from "./gateway-trial.js";
import {
  acquireUpdateLock,
  readTrial,
  readUpdateLock,
  resolvePrefix,
  writeTrial,
  type Trial,
} from "./store.js";

const notices = vi.hoisted(() => [] as Array<{ runId: string; kind: string; status: string }>);
const backgroundWork = vi.hoisted(() => {
  const jobs: Promise<void>[] = [];
  return jobs;
});
vi.mock("../gateway/update-run-notice.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateNotices>()),
  createUpdateRunNotifier:
    async () => async (run: { runId: string; status: string }, kind: string) => {
      notices.push({ runId: run.runId, kind, status: run.status });
      return { delivered: true, owned: true };
    },
}));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessExec>()),
  runCommandWithTimeout: vi.fn(async () => ({
    stdout: JSON.stringify({
      status: "ok",
      changed: false,
      sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
      npm: { changed: false, outcomes: [] },
      integrityDrifts: [],
    }),
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
  })),
}));
vi.mock("../cli/plugins-lifecycle-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginLifecycleClient>()),
  resolvePluginBatchReload: vi.fn(async () => undefined),
}));
vi.mock("../infra/update-install-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateInstallStatus>()),
  resolveStartupInstallStatus: vi.fn(async () => ({ status: { installKind: "package" } })),
}));
vi.mock(
  "../cli/update-cli/update-command-post-activation-inspections.js",
  async (importOriginal) => ({
    ...(await importOriginal<typeof InspectionOwner>()),
    runPostActivationInspections: vi.fn<typeof InspectionOwner.runPostActivationInspections>(
      async ({ result }) => result,
    ),
  }),
);
vi.mock("../flows/doctor-health-contributions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DoctorContributions>()),
  resolvePostActivationInspectionCheckIds: async () => ["core/doctor/secrets"],
}));
vi.mock("../gateway/update-run-watcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof watcherModule>()),
  wakeUpdateRunWatcher: (_runId?: string, advisoryWork?: () => Promise<void>) => {
    if (advisoryWork) {
      backgroundWork.push(trackAsyncWork(advisoryWork));
    }
    return true;
  },
}));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(backgroundWork.splice(0));
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  notices.length = 0;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const dir of directories.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("lets a launcher child exit naturally while its IPC peer remains connected", async ({
  signal,
}) => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import ${JSON.stringify(new URL("./gateway-trial.ts", import.meta.url).href)};
       process.send("loaded");`,
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCLAW_")),
        ),
        NODE_OPTIONS: "",
        OPENCLAW_LAUNCHER_IPC: "1",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  // No wall-clock deadline: a child the IPC channel keeps alive fails at the test timeout,
  // and the tsx import of the module graph on a loaded runner cannot lose a race.
  const exited = once(child, "exit");
  try {
    const [message] = await withinTest(once(child, "message"), signal);
    expect(message).toBe("loaded");
    expect(await withinTest(exited, signal), stderr).toEqual([0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGKILL");
      await stopped;
    }
  }
}, 15_000);

it.each(["succeeded", "rolled-back"] as const)(
  "settles a %s trial at ready without letting its expired preparation lock win",
  async (status) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trial-"));
    directories.push(state);
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    vi.stubEnv("OPENCLAW_LAUNCHER_IPC", "");
    const options = { env: process.env };
    openOpenClawStateDatabase(options);
    const releaseAdmission: NonNullable<UpdateRunRecord["origin"]["releaseAdmission"]> = {
      owner: "candidate",
      candidateVersion: VERSION,
      verdict: "admit",
      warnings: [{ code: "configured-plugin-path-unavailable", message: "Plugin path is absent" }],
    };
    const run = await createUpdateRunAsync(
      { trigger: "cli", origin: { releaseAdmission } },
      options,
    );
    const trial: Trial = {
      v: 2,
      runId: run.runId,
      phase: status === "succeeded" ? "committed" : "rolled-back",
      target: "releases/new/openclaw",
      previous: "releases/old/openclaw",
      version: VERSION,
      attempts: 1,
      createdAt: Date.now(),
      outcome: {
        status,
        reason: status === "rolled-back" ? "new build failed to start" : undefined,
        stderrTail:
          status === "rolled-back"
            ? "failed with token sk-abcdefghijklmnopqrstuvwxyz123456"
            : undefined,
        at: Date.now(),
      },
    };
    await writeTrial(trial);
    await acquireUpdateLock({ runId: run.runId, pid: process.pid, deadlineMs: 0 });
    const work = new AsyncWorkScope();
    await work.run(() => announceReady(null));
    await work.drain();
    const finished = await getUpdateRunAsync(run.runId, options);
    expect(finished).toMatchObject({
      status: status === "succeeded" ? "succeeded" : "failed",
      phase: "finished",
      origin: { releaseAdmission },
    });
    if (status === "succeeded") {
      expect(finished).toMatchObject({
        after: { version: VERSION },
        verification: {
          runningVersion: VERSION,
          booted: true,
          serviceRunning: true,
          coreReady: true,
          versionMatch: true,
        },
      });
    } else {
      expect(finished?.reason).toBe(`new build failed to start; v${VERSION} is still running`);
      expect(finished?.verification).toMatchObject({
        runningVersion: VERSION,
        booted: true,
        serviceRunning: true,
        coreReady: true,
        rollbackOutcome: { status: "succeeded", reason: "new build failed to start" },
      });
      expect(finished?.steps.some((step) => step.step === "outcome")).toBe(false);
      const startup = finished?.steps.find((step) => step.step === "diagnostic:startup");
      expect(startup).toMatchObject({ status: "completed" });
      expect(startup?.detail).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
      expect(startup?.detail).toContain("failed with token");
      expect(startup?.stderrTail).toContain("failed with token");
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
      expect(resolvePluginBatchReload).not.toHaveBeenCalled();
    }
    expect(await readTrial(resolvePrefix())).toMatchObject({ reported: true });
    await settleRunFromTrial((await readTrial())!);
    expect((await getUpdateRunAsync(run.runId, options))?.finishedAtMs).toBe(
      finished?.finishedAtMs,
    );
  },
);

it.each(["pending", "trial", "restoring"] as const)(
  "leaves a %s trial running when its preparation lock expires",
  async (phase) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trial-"));
    directories.push(state);
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    vi.stubEnv("OPENCLAW_LAUNCHER_IPC", "");
    openOpenClawStateDatabase({ env: process.env });
    const run = await createUpdateRunAsync({ trigger: "cli" });
    await writeTrial({
      v: 2,
      runId: run.runId,
      phase,
      target: "releases/new/openclaw",
      previous: "releases/old/openclaw",
      version: VERSION,
      attempts: 1,
      createdAt: Date.now(),
    });
    await acquireUpdateLock({ runId: run.runId, pid: process.pid, deadlineMs: 0 });
    await announceReady(null);
    expect(await getUpdateRunAsync(run.runId)).toMatchObject({ status: "running" });
    expect(await readTrial()).toMatchObject({ runId: run.runId, phase });
  },
);

it.each([true, false])(
  "sends the outcome to a requester that received the start notice (acknowledged=%s)",
  async (acknowledged) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trial-"));
    directories.push(state);
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    const options = { env: process.env };
    openOpenClawStateDatabase(options);
    const run = await createUpdateRunAsync(
      { trigger: "chat", origin: { sessionKey: "agent:main:telegram:dm:1" } },
      options,
    );
    if (acknowledged) {
      await recordUpdateRunStepAsync(
        run.runId,
        { step: "notice:ack", status: "completed", endedAtMs: Date.now() },
        options,
      );
    }
    await settleRunFromTrial({
      v: 2,
      runId: run.runId,
      phase: "rolled-back",
      target: "releases/new/openclaw",
      previous: "releases/old/openclaw",
      version: VERSION,
      attempts: 2,
      createdAt: Date.now(),
      outcome: { status: "rolled-back", reason: "new build failed to start", at: Date.now() },
    });
    expect(notices).toEqual(
      acknowledged ? [{ runId: run.runId, kind: "finished", status: "failed" }] : [],
    );
  },
);

it.each(["dead", "same-pid", "own-live", "live"] as const)(
  "settles interrupted preparation at Gateway start without taking a live lock (%s)",
  async (ownerState) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trial-"));
    directories.push(state);
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    vi.stubEnv("OPENCLAW_LAUNCHER_IPC", "");
    const options = { env: process.env };
    openOpenClawStateDatabase(options);
    const run = await createUpdateRunAsync(
      { trigger: ownerState === "live" ? "cli" : "control-ui" },
      options,
    );
    await recordUpdateRunStepAsync(
      run.runId,
      { step: "prepare:install", status: "in_progress", startedAtMs: Date.now() },
      options,
    );
    const owner = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await once(owner, "spawn");
    try {
      if (ownerState === "dead") {
        const exited = once(owner, "exit");
        owner.kill("SIGKILL");
        await exited;
      }
      await acquireUpdateLock({
        runId: run.runId,
        pid: ownerState === "same-pid" || ownerState === "own-live" ? process.pid : owner.pid!,
        deadlineMs: ownerState === "same-pid" ? Number.MAX_SAFE_INTEGER : 60_000,
      });
      if (ownerState === "same-pid") {
        // A previous Gateway with this PID took the lock before this process started.
        const file = path.join(resolvePrefix(), "releases", ".update.lock");
        const lock = JSON.parse(await fs.readFile(file, "utf8"));
        await fs.writeFile(
          file,
          JSON.stringify({ ...lock, startedAt: Date.now() - process.uptime() * 1000 - 1000 }),
        );
      }

      await announceReady(null);

      if (ownerState !== "dead") {
        // This Gateway's own update in progress (or a live CLI) keeps running and keeps its lock.
        expect(await getUpdateRunAsync(run.runId, options)).toMatchObject({ status: "running" });
        expect(await readUpdateLock()).toMatchObject({
          runId: run.runId,
          pid: ownerState === "live" ? owner.pid : process.pid,
        });
      } else {
        expect(await getUpdateRunAsync(run.runId, options)).toMatchObject({
          status: "failed",
          phase: "finished",
          reason: "interrupted",
        });
        expect(await readUpdateLock()).toBeNull();
      }
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        const exited = once(owner, "exit");
        owner.kill("SIGKILL");
        await exited;
      }
    }
  },
);

it.each(["warning", "error"] as const)(
  "keeps a committed update successful while background inspections report %s",
  async (finding) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trial-advice-"));
    directories.push(state);
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    const options = { env: process.env };
    openOpenClawStateDatabase(options);
    const run = await createUpdateRunAsync({ trigger: "control-ui" }, options);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    vi.mocked(runPostActivationInspections).mockImplementationOnce(async ({ result }) => {
      entered.resolve();
      await gate.promise;
      if (finding === "error") {
        throw new Error("inspection process could not start");
      }
      return {
        ...result,
        steps: [
          {
            name: "post-activation doctor inspections",
            command: "doctor --lint",
            cwd: state,
            durationMs: 1,
            exitCode: 1,
            advisory: { kind: "recoverable-maintenance", message: "Review plaintext secrets." },
            warnings: ["Plaintext secret found."],
            doctorLintFindings: [
              {
                checkId: "core/doctor/secrets",
                severity: "warning",
                message: "Plaintext secret found.",
              },
            ],
          },
        ],
      };
    });
    const trial: Trial = {
      v: 2,
      runId: run.runId,
      phase: "committed",
      target: "releases/new/openclaw",
      previous: "releases/old/openclaw",
      version: VERSION,
      attempts: 1,
      createdAt: Date.now(),
      outcome: { status: "succeeded", at: Date.now() },
    };
    const work = new AsyncWorkScope();
    try {
      await work.run(() => settleRunFromTrial(trial));
      await entered.promise;
      const committed = await getUpdateRunAsync(run.runId, options);
      expect(committed?.status).toBe("succeeded");
      expect(committed?.steps).not.toContainEqual(
        expect.objectContaining({ step: "post-activation doctor inspections" }),
      );
      expect(await readTrial()).toMatchObject({ reported: true });
    } finally {
      gate.resolve();
      await Promise.all(backgroundWork);
      await work.drain();
    }
    const inspected = await getUpdateRunAsync(run.runId, options);
    expect(inspected?.status).toBe("succeeded");
    expect(inspected?.steps).toContainEqual(
      expect.objectContaining({
        step: "post-activation doctor inspections",
        status: "completed",
      }),
    );
    if (finding === "warning") {
      expect(inspected?.steps).toContainEqual(
        expect.objectContaining({
          step: expect.stringContaining("warning:"),
          detail: "Plaintext secret found.",
        }),
      );
      const receipt = inspected?.steps.find(
        ({ step }) => step === "finalize:doctor-lint:post-activation doctor inspections",
      );
      expect(receipt?.status).toBe("completed");
      expect(JSON.parse(receipt!.detail!)).toMatchObject({
        exitCode: 1,
        counts: { error: 0, warning: 1, info: 0 },
      });
    }
    if (finding === "error") {
      const { lines } = renderUpdateRunReport(inspected!);
      expect(lines).toContainEqual(
        expect.stringContaining("Doctor inspections did not run after the update"),
      );
      expect(lines).toContainEqual(expect.stringContaining("openclaw doctor --lint --all"));
    }
    // The update stays successful; a warning finding or skipped inspections need attention.
    expect(renderUpdateRunReport(inspected!).headline).toMatch(
      /^✅ OpenClaw updated.*; 1 warning needs attention\.$/u,
    );
  },
);

it.each([undefined, true, false])(
  "finishes core before plugin maintenance, preserving late failures (consent=%s)",
  async (acceptCapabilities) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trial-plugins-"));
    directories.push(state);
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    const options = { env: process.env };
    openOpenClawStateDatabase(options);
    const run = await createUpdateRunAsync({ trigger: "control-ui" }, options);
    const entered = Promise.withResolvers<void>();
    const command = Promise.withResolvers<SpawnResult>();
    const targets = [
      { pluginId: "updated", installHash: "1".repeat(64) },
      { pluginId: "restored", installHash: "2".repeat(64) },
    ];
    const reload = vi.fn(async () => ({
      operationId: "plugin-maintenance-reload",
      generation: 2,
      pluginIds: ["updated", "restored"],
    }));
    vi.mocked(resolvePluginBatchReload).mockResolvedValueOnce(reload);
    if (acceptCapabilities === false) {
      reload.mockRejectedValueOnce(
        new Error("Plugin updated changed after the installation batch."),
      );
    }
    vi.mocked(runCommandWithTimeout).mockImplementationOnce(async () => {
      entered.resolve();
      return await command.promise;
    });
    const trial: Trial = {
      v: 2,
      runId: run.runId,
      phase: "committed",
      target: "releases/new/openclaw",
      previous: "releases/old/openclaw",
      version: VERSION,
      attempts: 1,
      createdAt: Date.now(),
      ...(acceptCapabilities === undefined ? {} : { acceptCapabilities }),
      outcome: { status: "succeeded", at: Date.now() },
    };
    const failed = acceptCapabilities === undefined;
    const result = {
      status: failed ? "warning" : "ok",
      changed: true,
      sync: {
        changed: true,
        switchedToBundled: ["bundled"],
        switchedToNpm: ["restored"],
        warnings: [],
        errors: [],
      },
      npm: {
        changed: true,
        outcomes: [
          { pluginId: "updated", status: "error", message: "Repaired by convergence." },
          { pluginId: "updated", status: "updated", message: "Updated." },
          { pluginId: "unchanged", status: "skipped", message: "Already current." },
          ...(failed
            ? [
                {
                  pluginId: "broken",
                  status: "error",
                  message: "broken: package download failed",
                },
              ]
            : []),
        ],
      },
      integrityDrifts: [],
      reloadTargets: targets,
    };
    const work = new AsyncWorkScope();
    let finishedAtMs: number | null | undefined;
    try {
      await work.run(() => settleRunFromTrial(trial));
      await entered.promise;
      const committed = await getUpdateRunAsync(run.runId, options);
      expect(committed).toMatchObject({ status: "succeeded", phase: "finished" });
      finishedAtMs = committed?.finishedAtMs;
      expect(finishedAtMs).toEqual(expect.any(Number));
      expect(committed?.steps).not.toContainEqual(expect.objectContaining({ step: "plugins" }));
      expect(await readTrial()).toMatchObject({ reported: true });
      expect(runPostActivationInspections).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      const [argv, commandOptions] = vi.mocked(runCommandWithTimeout).mock.calls[0]!;
      expect(argv).toEqual(expect.arrayContaining(["update", "plugins", "--json"]));
      expect(argv.includes("--accept-capabilities")).toBe(acceptCapabilities === true);
      expect(commandOptions).toMatchObject({ timeoutMs: 10 * 60_000, killProcessTree: true });
    } finally {
      command.resolve({
        stdout: `Plugin maintenance finished.\n${JSON.stringify(result)}`,
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });
      await Promise.all(backgroundWork);
      await work.drain();
    }
    const maintained = await getUpdateRunAsync(run.runId, options);
    expect(maintained).toMatchObject({
      status: "succeeded",
      phase: "finished",
      finishedAtMs,
    });
    expect(maintained?.steps).toContainEqual(
      expect.objectContaining({
        step: "plugins",
        status: acceptCapabilities ? "completed" : "failed",
      }),
    );
    expect(reload).toHaveBeenCalledExactlyOnceWith(targets);
    expect(runPostActivationInspections).toHaveBeenCalledOnce();
    const report = renderUpdateRunReport(maintained!);
    if (failed) {
      const pluginStep = maintained?.steps.find(({ step }) => step === "plugins");
      expect(pluginStep?.detail).toContain("broken: package download failed");
      expect(pluginStep?.detail).toContain("openclaw plugins update broken");
      expect(report.headline).toMatch(/; 1 warning needs attention\.$/u);
      expect(report.lines.join("\n")).toContain("broken: package download failed");
      expect(report.lines.join("\n")).toContain("openclaw plugins update broken");
    } else if (!acceptCapabilities) {
      const pluginStep = maintained?.steps.find(({ step }) => step === "plugins");
      expect(pluginStep?.detail).toContain("changed after the installation batch");
      expect(pluginStep?.detail).toContain("openclaw plugins reload updated restored");
      expect(report.headline).toMatch(/; 1 warning needs attention\.$/u);
    } else {
      expect(report.headline).not.toContain("needs attention");
    }
  },
);

it("stops plugin command work when the Gateway watcher closes", async ({ signal }) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trial-stop-"));
  directories.push(state);
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  const release = path.join(state, "release");
  await fs.mkdir(release);
  await fs.writeFile(
    path.join(release, "openclaw.mjs"),
    `import { spawn } from "node:child_process";
import { MessageChannel } from "node:worker_threads";
spawn(process.execPath, ["-e", "const { port1 } = new (require('node:worker_threads').MessageChannel)(); port1.on('message', () => {});"], { stdio: "ignore" });
const { port1 } = new MessageChannel();
port1.on("message", () => {});
process.stdout.write("maintenance-ready\\n");`,
  );
  const actualExec = await vi.importActual<typeof ProcessExec>("../process/exec.js");
  const actualWatcher = await vi.importActual<typeof watcherModule>(
    "../gateway/update-run-watcher.js",
  );
  vi.spyOn(rootModule, "resolveOpenClawPackageRoot").mockResolvedValue(release);
  vi.spyOn(watcherModule, "wakeUpdateRunWatcher").mockImplementation(
    actualWatcher.wakeUpdateRunWatcher,
  );
  const entered = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<SpawnResult>();
  let childPid: number | undefined;
  let commandFinished = false;
  vi.mocked(runCommandWithTimeout).mockImplementationOnce(async (argv, options) => {
    const result = await actualExec.runCommandWithTimeout(argv, {
      ...(typeof options === "number" ? { timeoutMs: options } : options),
      input: "",
      beforeInput: (pid) => {
        childPid = pid;
      },
      onOutputChunk: (chunk) => {
        if (chunk.toString().includes("maintenance-ready")) {
          entered.resolve();
        }
      },
    });
    commandFinished = true;
    stopped.resolve(result);
    return result;
  });
  const lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  const watcher = actualWatcher.startUpdateRunWatcher({
    lifecycle,
    broadcast: vi.fn(),
    log: { warn: vi.fn() },
  });
  openOpenClawStateDatabase({ env: process.env });
  const run = await createUpdateRunAsync({ trigger: "control-ui" });
  try {
    await settleRunFromTrial({
      v: 2,
      runId: run.runId,
      phase: "committed",
      target: "releases/new/openclaw",
      previous: "releases/old/openclaw",
      version: VERSION,
      attempts: 1,
      createdAt: Date.now(),
      outcome: { status: "succeeded", at: Date.now() },
    });
    await withinTest(entered.promise, signal);
    await withinTest(watcher.stop(), signal);
    expect((await stopped.promise).termination).toBe("signal");
    expect(runPostActivationInspections).not.toHaveBeenCalled();
    const finished = await getUpdateRunAsync(run.runId);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.steps).not.toContainEqual(expect.objectContaining({ step: "plugins" }));
  } finally {
    if (childPid && !commandFinished) {
      killProcessTree(childPid, { detached: true, force: true });
    }
    await watcher.stop();
    await lifecycle.stop();
  }
});
