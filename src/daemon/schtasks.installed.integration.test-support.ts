import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { z } from "zod";
import {
  hashFile,
  hashInstall,
  prepareInstalledPackage,
} from "../../scripts/lib/gateway-bench-installed-package.ts";
import type { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { waitForGatewayHttpReadiness } from "../cli/daemon-cli/restart-health-probe.js";
import { DEFAULT_RESTART_HEALTH_DELAY_MS } from "../cli/daemon-cli/restart-health.constants.js";
import { resolveGatewayStartupTiming } from "../commands/gateway-startup-timing.js";
import { run, type CommandRecord } from "./schtasks.installed-command.test-support.js";
import * as diagnostics from "./schtasks.installed-diagnostics.test-support.js";
import type { InstalledTask as Task } from "./schtasks.installed-diagnostics.test-support.js";
import * as installed from "./schtasks.installed-package.test-support.js";
import * as startup from "./schtasks.installed-startup.test-support.js";

type Lifetime = ReturnType<typeof createFixtureLifetime>;
function combineFailure(
  previous: Error | undefined,
  error: unknown,
  message: string,
  options?: ErrorOptions,
) {
  return new AggregateError(previous ? [previous, error] : [error], message, options);
}
async function withFinalizer<T>(
  action: () => Promise<T>,
  finalize: (failure?: Error) => Promise<unknown>,
  actionMessage: string,
  finalizerMessage: string,
  finalizerOptions?: (error: unknown) => ErrorOptions,
) {
  const outcome = await Promise.resolve()
    .then(action)
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: toErrorObject(error, actionMessage) }),
    );
  const failure = outcome.ok ? undefined : outcome.error;
  try {
    await finalize(failure);
  } catch (error) {
    throw combineFailure(failure, error, finalizerMessage, finalizerOptions?.(error));
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
type Owners = {
  reserveLoopbackPort: () => Promise<number>;
  canBindLoopbackPort: (port: number) => Promise<boolean>;
  waitForLoopbackPortRelease: (port: number) => Promise<void>;
  readTaskDefinitionSnapshot: (taskName: string) => Promise<unknown>;
  cleanupNativeTask: (params: {
    activePidPath: string;
    eventsPath: string;
    preserveEvidence: boolean;
    probePath: string;
    rootDir: string;
    scriptPath: string;
    serviceOutput: string;
    stateDir: string;
    taskName: string;
  }) => Promise<void>;
};
export async function runInstalledLifecycle(
  inputPath: string,
  lifetime: Lifetime,
  owners: Owners,
  signal: AbortSignal,
) {
  const { resolveGatewayWindowsTaskName } = await import("./constants.js");
  const { execSchtasks } = await import("./schtasks-exec.js");
  const { setScheduledTaskXmlEnabled } = await import("./schtasks-control.js");
  const { resolveTaskScriptPath } = await import("./schtasks.js");
  const { probeScheduledTaskExists, probeScheduledTaskState, ScheduledTaskInspectionError } =
    await import("./schtasks-state-probe.js");
  const { readTaskPrincipal, readTaskXml, readRelatedProcessDiagnostics } =
    await import("./schtasks.integration-observation.test-support.js");
  const { waitForProcessExit } = await import("./schtasks.task-supervisor.native-test-support.js");
  const key = z.enum(installed.keys).parse(process.env.CI_WINDOWS_SCHTASKS_INSTALLED_CELL);
  const cellIndex = installed.keys.indexOf(key);
  const input = await installed.readInput(inputPath);
  assert.equal(input.toolingSha, process.env.CI_WINDOWS_SCHTASKS_HEAD);
  const prepared = await installed.readPreparedCell(inputPath, input, key);
  const id = process.env.CI_WINDOWS_SCHTASKS_TEST_ID;
  assert.ok(id && /^[a-z0-9-]{1,48}$/u.test(id));
  installed.samePath(path.join(input.stateRoot, key), process.env.CI_WINDOWS_SCHTASKS_ROOT ?? "");
  const proofPath = process.env.CI_WINDOWS_SCHTASKS_PROOF_PATH;
  assert.ok(proofPath);
  installed.samePath(path.dirname(proofPath), installed.cellEvidence(inputPath, key));
  await fs.mkdir(path.dirname(proofPath), { recursive: true });
  const admissions: Array<Record<string, unknown>> = [];
  const defaultBefore = await owners.readTaskDefinitionSnapshot("OpenClaw Gateway");
  const admissionPath = path.join(path.dirname(proofPath), "installed-cleanup.json");
  const rootDir = path.join(input.stateRoot, key);
  await fs.mkdir(rootDir);
  const installRoot = installed.prefix(input, key);
  const initial = await installed.verifyPreparedInstall(prepared, key, installRoot);
  const commands: CommandRecord[] = [];
  const tasks: Task[] = [];
  let authorityPeerRoot: string | undefined;
  const observations: Record<string, unknown> = {};
  let cellFailure: Error | undefined;
  const recordProgress = installed.createInstalledProgressRecorder({
    input,
    key,
    rootDir,
    proofPath,
    commands,
    observations,
  });
  await recordProgress("selected:hash-verified");
  const cli = (task: Task, args: string[], expectedExit = 0) =>
    withFinalizer(
      () =>
        run(
          [task.entry, "--profile", task.profile, ...args],
          task.env,
          rootDir,
          commands,
          expectedExit,
          signal,
          {
            observeService:
              args[0] === "gateway" && (args[1] === "install" || args[1] === "status")
                ? args[1]
                : undefined,
          },
        ),
      (failure) => recordProgress(`command:${args.slice(0, 2).join(" ")}`, failure),
      "Installed Scheduled Task command failed",
      "Installed command recording failed",
      (cause) => ({ cause }),
    );
  const jsonCli = async (task: Task, args: string[], expectedExit = 0) =>
    JSON.parse(await cli(task, args, expectedExit));
  const gateway = (task: Task, ...args: string[]) => cli(task, ["gateway", ...args, "--json"]);
  const readStatus = (task: Task) => jsonCli(task, ["gateway", "status", "--json"]);
  const inspection = {
    doctor: async (task: Task, expectedExit = 1) =>
      diagnostics.doctorReportSchema
        .extend({ ok: z.literal(expectedExit === 0) })
        .parse(
          await jsonCli(
            task,
            [
              "doctor",
              "--lint",
              "--deep",
              "--only",
              "core/doctor/gateway-services/extra",
              "--severity-min",
              "info",
              "--json",
            ],
            expectedExit,
          ),
        ),
    deepStatus: (task: Task) => jsonCli(task, ["gateway", "status", "--deep", "--json"]),
    lifetime,
    admissions,
    admissionPath,
  };
  const { doctor } = inspection;
  const context = {
    ...inspection,
    input,
    inputPath,
    key,
    commands,
    signal,
    observations,
    recordProgress,
  };
  const awaitReadiness = async (task: Task, phase: string) => {
    const { deadlineMs } = resolveGatewayStartupTiming();
    const started = performance.now();
    await recordProgress(`${phase}:waiting`);
    const readiness = await waitForGatewayHttpReadiness({
      port: task.gatewayPort,
      attempts: Math.ceil(deadlineMs / DEFAULT_RESTART_HEALTH_DELAY_MS),
      deadlineAt: started + deadlineMs,
      delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
      signal,
      onObservation: (value) => {
        observations[phase] = { ...value, elapsedMs: performance.now() - started };
      },
    });
    assert.deepEqual(readiness, { healthz: 200, readyz: 200 });
    await recordProgress(`${phase}:ready`);
  };
  const cleanupTask = (
    task: Pick<Task, "rootDir" | "stateDir" | "scriptPath" | "taskName">,
    probePath: string,
    eventsPath: string,
  ) =>
    lifetime.verifyCleanup(() =>
      owners.cleanupNativeTask({
        activePidPath: path.join(task.rootDir, "unused-active-pid"),
        eventsPath,
        preserveEvidence: true,
        probePath,
        rootDir: task.rootDir,
        scriptPath: task.scriptPath,
        serviceOutput: "",
        stateDir: task.stateDir,
        taskName: task.taskName,
      }),
    );
  const createTask = async (role: "selected" | "peer") => {
    const profile = `schtasks-int-${id}-${cellIndex}-${role}`;
    const stateDir = path.join(os.userInfo().homedir, `.openclaw-${profile}`);
    const configPath = path.join(stateDir, "openclaw.json");
    const taskName = resolveGatewayWindowsTaskName(profile);
    const gatewayPort = await owners.reserveLoopbackPort();
    const taskInstallRoot = role === "peer" ? installed.prefix(input, `${key}-peer`) : installRoot;
    if (role === "peer") {
      await installed.verifyPreparedInstall(prepared, `${key}-peer`, taskInstallRoot);
      await recordProgress("peer:hash-verified");
    }
    const env = {
      ...installed.boundedEnv(rootDir, taskInstallRoot),
      OPENCLAW_PROFILE: profile,
      OPENCLAW_WINDOWS_TASK_NAME: taskName,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_PORT: String(gatewayPort),
      OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
    };
    assert.equal(probeScheduledTaskExists(taskName), false);
    await fs.mkdir(stateDir);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "local",
          bind: "loopback",
          port: gatewayPort,
          auth: { mode: "token", token: randomUUID() },
        },
      }),
    );
    const admission = {
      profile,
      taskName,
      stateDir,
      rootDir,
      installRoot: taskInstallRoot,
      entry: installed.entry(taskInstallRoot),
      scriptPath: resolveTaskScriptPath(env),
    };
    const task = { ...admission, configPath, gatewayPort, env };
    tasks.push(task);
    admissions.push({ ...admission, taskInitiallyAbsent: true, cell: key, role });
    await installed.writeJson(admissionPath, admissions);
    // Both published CLIs support these options; 9.3 has no --runtime-path.
    await gateway(task, "install", "--runtime", "node", "--port", String(gatewayPort));
    // Installation acknowledges activation; the service owner has not checked readiness yet.
    await awaitReadiness(task, `${role}-startup`);
    return task;
  };
  const status = async (
    task: Task,
    expected: Awaited<ReturnType<typeof installed.readInstalledBuildIdentity>>,
    definition: "published" | "candidate",
  ) => {
    const value = installed.installedStatusSchema.parse(await readStatus(task));
    assert.deepEqual(value.rpc.server, expected);
    assert.deepEqual(value.gateway, { version: expected.version, port: task.gatewayPort });
    assert.equal(value.rpc.url, `ws://127.0.0.1:${task.gatewayPort}`);
    assert.equal(await owners.canBindLoopbackPort(task.gatewayPort), false);
    assert.equal(readTaskPrincipal(task.taskName).taskState, 4);
    installed.samePath(value.service.command.programArguments[0] ?? "", process.execPath);
    assert.ok(
      value.service.command.programArguments.some(
        (arg) =>
          path.isAbsolute(arg) &&
          arg
            .toLowerCase()
            .startsWith((installed.packageRoot(task.installRoot) + path.sep).toLowerCase()),
      ),
    );
    await diagnostics.assertInstalledTaskDefinition(task, definition);
    return value;
  };
  try {
    for (const name of ["appdata", "local-appdata", "tmp", "npm-cache"]) {
      await fs.mkdir(path.join(rootDir, name));
    }
    await fs.writeFile(path.join(rootDir, "npmrc"), "");
    await fs.writeFile(path.join(rootDir, "global-npmrc"), "");
    const selected = await createTask("selected");
    const beforeIdentity = await installed.readInstalledBuildIdentity(
      installRoot,
      key === "fresh" ? input.candidate.version : key,
    );
    const before = await status(
      selected,
      beforeIdentity,
      key === "fresh" ? "candidate" : "published",
    );
    observations.before = before;
    await recordProgress("selected-status-verified");
    let candidateStatus = before;
    const configBefore = await fs.readFile(selected.configPath);
    if (key !== "fresh") {
      const peer = await createTask("peer");
      authorityPeerRoot = peer.installRoot;
      const peerIdentity = await installed.readInstalledBuildIdentity(peer.installRoot, key);
      const peerBefore = await status(peer, peerIdentity, "published");
      const peerXml = await readTaskXml(peer.taskName);
      const peerConfig = await fs.readFile(peer.configPath);
      const peerInstallBefore = await hashInstall(peer.installRoot);
      await recordProgress("peer-before-update:hash-verified");
      if (key === "2026.9.4") {
        observations.siblingBuildRefusal = await diagnostics.assertInstalledSiblingBuildRefusal({
          ...context,
          toolingEntry: path.resolve("scripts/run-node.mjs"),
          selected,
          peer,
          verifyContinuity: async () => {
            assert.equal(
              (await status(selected, beforeIdentity, "published")).service.runtime.pid,
              before.service.runtime.pid,
            );
            assert.equal(
              (await status(peer, peerIdentity, "published")).service.runtime.pid,
              peerBefore.service.runtime.pid,
            );
          },
        });
      }
      const driverBefore = await hashFile(selected.entry);
      observations.driver = {
        version: key,
        entrySha256: driverBefore,
        installed: await hashInstall(installRoot),
      };
      await recordProgress("published-driver:hash-verified");
      observations.update = await diagnostics.runInstalledPublishedUpdate({
        ...context,
        task: selected,
      });
      await prepareInstalledPackage({ ...input, installRoot });
      await recordProgress("updated-candidate:hash-verified");
      const candidateIdentity = await installed.readInstalledBuildIdentity(
        installRoot,
        input.candidate.version,
      );
      await awaitReadiness(selected, "candidate-startup");
      const after = await status(selected, candidateIdentity, "candidate");
      assert.notEqual(after.service.runtime.pid, before.service.runtime.pid);
      observations.after = after;
      candidateStatus = after;
      assert.deepEqual(
        JSON.parse(await fs.readFile(selected.configPath, "utf8")).gateway,
        JSON.parse(configBefore.toString()).gateway,
      );
      assert.equal(await readTaskXml(peer.taskName), peerXml);
      assert.deepEqual(await fs.readFile(peer.configPath), peerConfig);
      const peerAfter = await status(peer, peerIdentity, "published");
      assert.equal(peerAfter.service.runtime.pid, peerBefore.service.runtime.pid);
      observations.peer = { before: peerBefore, after: peerAfter };
      const extras = await doctor(selected, 0);
      for (const task of [peer, selected]) {
        assert.equal(
          extras.findings.some((finding) => finding.target === "\\" + task.taskName),
          false,
        );
      }
      assert.equal(await readTaskXml(peer.taskName), peerXml);
      assert.deepEqual(await fs.readFile(peer.configPath), peerConfig);
      observations.extraServices = extras;
      assert.deepEqual(await hashInstall(peer.installRoot), peerInstallBefore);
      await recordProgress("peer-after-update:hash-verified");
      observations.peerPreserved = true;
      observations.startupSiblings = await startup.inspectInstalledStartupSiblings({
        ...inspection,
        selected,
        launcher: peer,
        expectedStatus: after,
      });
      if (key === "2026.9.4") {
        observations.startupAliasBuildRefusal =
          await startup.inspectInstalledStartupAliasBuildRefusal({
            ...context,
            toolingEntry: path.resolve("scripts/run-node.mjs"),
            selected,
            peer,
            expectedSelected: after,
            expectedPeer: peerAfter,
            readStatus,
            waitForLoopbackPortRelease: owners.waitForLoopbackPortRelease,
          });
      }
      await gateway(peer, "stop", "--force");
      await owners.waitForLoopbackPortRelease(peer.gatewayPort);
      await gateway(peer, "uninstall");
    }
    // The packaged candidate must reach its real strict inspection preview, not exit-zero skip.
    const preview = async (task: Task = selected) =>
      installed.parseInstalledPreview(
        await cli(task, ["update", "--dry-run", "--tag", input.tarball, "--json"]),
        task.installRoot,
      );
    if (key === "fresh") {
      observations.discovery = await diagnostics.inspectDisabledDiscoveryTasks({
        ...context,
        selected,
        preview,
        cleanupTask,
        owners,
        id,
        cellIndex,
        rootDir,
        installRoot,
      });
      observations.startupSiblings = await startup.inspectInstalledStartupSiblings({
        ...inspection,
        selected,
        launcher: selected,
        expectedStatus: before,
      });
    }
    const beforeRestartPid = candidateStatus.service.runtime.pid;
    const beforeRestartXml = await readTaskXml(selected.taskName);
    assert.ok(beforeRestartXml);
    const restartIdentity = await installed.readInstalledBuildIdentity(
      installRoot,
      input.candidate.version,
    );
    await gateway(selected, "restart");
    await waitForProcessExit(beforeRestartPid);
    await awaitReadiness(selected, "candidate-restart");
    const restarted = await status(selected, restartIdentity, "candidate");
    assert.notEqual(restarted.service.runtime.pid, beforeRestartPid);
    assert.equal(await readTaskXml(selected.taskName), beforeRestartXml);
    observations.restart = {
      beforePid: beforeRestartPid,
      after: restarted,
      oldProcessExited: true,
      taskDefinitionUnchanged: true,
    };
    candidateStatus = restarted;
    await recordProgress("candidate-restart-verified");
    const configBeforePreview = await fs.readFile(selected.configPath);
    const healthy = await preview();
    assert.equal(
      healthy.notes.some((note) => note.includes("Gateway service inspection is unavailable")),
      false,
    );
    await gateway(selected, "stop", "--force");
    await owners.waitForLoopbackPortRelease(selected.gatewayPort);
    observations.selectedStartupFallback = await startup.inspectInstalledSelectedStartupFallback({
      ...inspection,
      observeFingerprint:
        key === "2026.9.4"
          ? async () => {
              const observation = JSON.parse(
                await run(
                  [
                    "--import",
                    pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
                    path.resolve(
                      "src/daemon/schtasks.installed-fingerprint-observer.test-support.mts",
                    ),
                    inputPath,
                  ],
                  selected.env,
                  process.cwd(),
                  commands,
                  0,
                  signal,
                ),
              );
              await recordProgress("fingerprint-result");
              return observation;
            }
          : undefined,
      selected,
      expectedCommand: candidateStatus.service.command.programArguments,
      canBindLoopbackPort: owners.canBindLoopbackPort,
    });
    if (key === "2026.9.3") {
      assert.ok(authorityPeerRoot);
      const { inspectInstalledTaskAuthority } =
        await import("./schtasks.installed-authority.test-support.js");
      observations.nativeAuthority = await inspectInstalledTaskAuthority({
        task: selected,
        foreignInstallRoot: authorityPeerRoot,
        canBindLoopbackPort: owners.canBindLoopbackPort,
        recordProgress,
      });
    }
    const xml = await readTaskXml(selected.taskName);
    assert.ok(xml);
    const canonicalScriptHash = await hashFile(selected.scriptPath);
    const match = /<Command>([^<]+)<\/Command>/u.exec(xml);
    assert.ok(match);
    const empty = path.join(rootDir, "empty-registered-launcher.cmd");
    await fs.writeFile(empty, "@echo off\r\n", "ascii");
    const restoreXml = path.join(rootDir, "restore-task.xml");
    const malformedXml = path.join(rootDir, "empty-task.xml");
    const registerXml = async (file: string) =>
      assert.equal(
        (await execSchtasks(["/Create", "/TN", selected.taskName, "/XML", file, "/F"])).code,
        0,
      );
    const escaped = empty.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    await fs.writeFile(restoreXml, `\uFEFF${xml}`, "utf16le");
    await fs.writeFile(
      malformedXml,
      `\uFEFF${setScheduledTaskXmlEnabled(xml, false)
        .replace(match[0], `<Command>${escaped}</Command>`)
        .replace(/<Arguments>[\s\S]*?<\/Arguments>/u, "")}`,
      "utf16le",
    );
    await withFinalizer(
      async () => {
        await registerXml(malformedXml);
        const registeredEmpty = await readTaskXml(selected.taskName);
        assert.equal(readTaskPrincipal(selected.taskName).enabled, false);
        const malformed = await preview();
        assert.equal(await readTaskXml(selected.taskName), registeredEmpty);
        assert.ok(
          malformed.notes.some((note) =>
            note.includes("Gateway service inspection is unavailable"),
          ),
        );
        assert.equal(await hashFile(selected.scriptPath), canonicalScriptHash);
        observations.strictPreview = {
          healthy,
          malformed,
          canonicalScriptHash,
          malformedLauncherExecuted: false,
        };
      },
      () => registerXml(restoreXml),
      "Installed Scheduled Task fixture failed",
      "Registered launcher restoration failed",
    );
    assert.deepEqual(await fs.readFile(selected.configPath), configBeforePreview);
    await gateway(selected, "uninstall");
    assert.equal(probeScheduledTaskExists(selected.taskName), false);
    if (key === "fresh") {
      assert.deepEqual(await hashInstall(installRoot), initial.installed);
      await recordProgress("fresh-final:hash-verified");
    }
  } catch (error) {
    cellFailure = toErrorObject(error, "Installed Scheduled Task fixture failed");
    if (key !== "fresh" && tasks[0]) {
      try {
        await diagnostics.inspectInstalledUpdateFailure({
          task: tasks[0],
          commands,
          signal,
          observations,
        });
      } catch (inspectionError) {
        cellFailure = combineFailure(
          cellFailure,
          inspectionError,
          "Installed update failure inspection failed",
          { cause: cellFailure },
        );
      }
    }
    try {
      await recordProgress("before-native-cleanup", cellFailure);
    } catch (recordError) {
      cellFailure = combineFailure(cellFailure, recordError, "Installed proof recording failed");
    }
  }
  for (const task of tasks.toReversed()) {
    try {
      await lifetime.verifyCleanup(async () => {
        const registration = probeScheduledTaskState(task.taskName);
        if (registration.status === "unknown") {
          throw new ScheduledTaskInspectionError(registration);
        }
        // Successful uninstall or failed registration leaves no definition to stop.
        if (registration.status === "missing") {
          return;
        }
        // The installed CLI owns the admitted profile, unlike Vitest's synthetic ambient state.
        // Cleanup has its own bounded command lifetime even when the test body was aborted.
        await run(
          [task.entry, "--profile", task.profile, "gateway", "stop", "--force", "--json"],
          task.env,
          rootDir,
          commands,
        );
        await recordProgress("native-cleanup:command-result");
      });
      await cleanupTask(
        task,
        installed.packageRoot(task.installRoot),
        path.join(rootDir, "commands.json"),
      );
      await owners.waitForLoopbackPortRelease(task.gatewayPort);
    } catch (error) {
      cellFailure = combineFailure(cellFailure, error, "Native cleanup failed");
    }
  }
  try {
    const remaining = readRelatedProcessDiagnostics(
      tasks.map((task) => installed.packageRoot(task.installRoot)),
    );
    assert.equal(remaining.ok, true);
    assert.equal(remaining.truncated, false);
    assert.deepEqual(remaining.processes, []);
    assert.deepEqual(await owners.readTaskDefinitionSnapshot("OpenClaw Gateway"), defaultBefore);
    await installed.recordCapacityBoundary(inputPath, input, key, "after-native-cleanup");
  } catch (error) {
    cellFailure = combineFailure(cellFailure, error, "Native residue remains");
  }
  await installed.writeJson(path.join(rootDir, "commands.json"), commands);
  const result = {
    key,
    result: cellFailure ? "failed" : "passed",
    commands,
    observations,
    failure: cellFailure ? installed.describeFailure(cellFailure) : undefined,
  };
  await installed.writeJson(proofPath, {
    result: cellFailure ? "failed" : "pass",
    head: input.toolingSha,
    candidate: input.candidate,
    published: input.published,
    cell: key,
    cells: [result],
  });
  if (cellFailure) {
    throw cellFailure;
  }
}
