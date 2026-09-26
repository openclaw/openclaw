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
import {
  assertInstalledSiblingBuildRefusal,
  doctorReportSchema,
  inspectDisabledDiscoveryTasks,
  inspectInstalledUpdateFailure,
  runInstalledPublishedUpdate,
  type InstalledTask as Task,
} from "./schtasks.installed-diagnostics.test-support.js";
import {
  boundedEnv,
  cellEvidence,
  createInstalledProgressRecorder,
  describeFailure,
  entry,
  installedStatusSchema,
  keys,
  packageRoot,
  parseInstalledPreview,
  prefix,
  readInput,
  readInstalledBuildIdentity,
  readPreparedCell,
  recordCapacityBoundary,
  samePath,
  verifyPreparedInstall,
} from "./schtasks.installed-package.test-support.js";
import {
  inspectInstalledSelectedStartupFallback,
  inspectInstalledStartupAliasBuildRefusal,
  inspectInstalledStartupSiblings,
} from "./schtasks.installed-startup.test-support.js";

type Lifetime = ReturnType<typeof createFixtureLifetime>;
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
  const {
    assertInteractiveLeastPrivilegeTask,
    readTaskPrincipal,
    readTaskXml,
    readRelatedProcessDiagnostics,
  } = await import("./schtasks.integration-observation.test-support.js");
  const key = z.enum(keys).parse(process.env.CI_WINDOWS_SCHTASKS_INSTALLED_CELL);
  const cellIndex = keys.indexOf(key);
  const input = await readInput(inputPath);
  assert.equal(input.toolingSha, process.env.CI_WINDOWS_SCHTASKS_HEAD);
  const prepared = await readPreparedCell(inputPath, input, key);
  const id = process.env.CI_WINDOWS_SCHTASKS_TEST_ID;
  assert.ok(id && /^[a-z0-9-]{1,48}$/u.test(id));
  samePath(path.join(input.stateRoot, key), process.env.CI_WINDOWS_SCHTASKS_ROOT ?? "");
  const proofPath = process.env.CI_WINDOWS_SCHTASKS_PROOF_PATH;
  assert.ok(proofPath);
  samePath(path.dirname(proofPath), cellEvidence(inputPath, key));
  await fs.mkdir(path.dirname(proofPath), { recursive: true });
  const admissions: Array<Record<string, unknown>> = [];
  const results: Array<Record<string, unknown>> = [];
  const defaultBefore = await owners.readTaskDefinitionSnapshot("OpenClaw Gateway");
  const admissionPath = path.join(path.dirname(proofPath), "installed-cleanup.json");
  let failure: Error | undefined;
  const rootDir = path.join(input.stateRoot, key);
  await fs.mkdir(rootDir);
  const installRoot = prefix(input, key);
  const initial = await verifyPreparedInstall(prepared, key, installRoot);
  const commands: CommandRecord[] = [];
  const tasks: Task[] = [];
  let authorityPeerRoot: string | undefined;
  const observations: Record<string, unknown> = {};
  let cellFailure: Error | undefined;
  const recordProgress = createInstalledProgressRecorder({
    input,
    key,
    rootDir,
    proofPath,
    commands,
    observations,
  });
  await recordProgress("selected:hash-verified");
  const cli = async (task: Task, args: string[], expectedExit = 0) => {
    let commandFailure: Error | undefined;
    let output = "";
    try {
      output = await run(
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
      );
    } catch (error) {
      commandFailure = toErrorObject(error, "Installed Scheduled Task command failed");
    }
    try {
      await recordProgress(`command:${args.slice(0, 2).join(" ")}`, commandFailure);
    } catch (recordError) {
      throw new AggregateError(
        commandFailure ? [commandFailure, recordError] : [recordError],
        "Installed command recording failed",
        { cause: recordError },
      );
    }
    if (commandFailure) {
      throw commandFailure;
    }
    return output;
  };
  const awaitReadiness = async (task: Task, phase: string) => {
    const { deadlineMs } = resolveGatewayStartupTiming();
    const started = performance.now();
    await recordProgress(`${phase}:waiting`);
    const readiness = await waitForGatewayHttpReadiness({
      port: task.gatewayPort,
      attempts: Math.ceil(deadlineMs / DEFAULT_RESTART_HEALTH_DELAY_MS),
      deadlineAt: Date.now() + deadlineMs,
      delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
      signal,
      onObservation: (value) => {
        observations[phase] = { ...value, elapsedMs: performance.now() - started };
      },
    });
    assert.deepEqual(readiness, { healthz: 200, readyz: 200 });
    await recordProgress(`${phase}:ready`);
  };
  const doctor = async (task: Task, expectedExit = 1) =>
    doctorReportSchema
      .extend({ ok: z.literal(expectedExit === 0) })
      .parse(
        JSON.parse(
          await cli(
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
      );
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
    const taskInstallRoot = role === "peer" ? prefix(input, `${key}-peer`) : installRoot;
    if (role === "peer") {
      await verifyPreparedInstall(prepared, `${key}-peer`, taskInstallRoot);
      await recordProgress("peer:hash-verified");
    }
    const env = {
      ...boundedEnv(rootDir, taskInstallRoot),
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
    const task = {
      profile,
      taskName,
      stateDir,
      configPath,
      gatewayPort,
      rootDir,
      installRoot: taskInstallRoot,
      entry: entry(taskInstallRoot),
      env,
      scriptPath: resolveTaskScriptPath(env),
    };
    tasks.push(task);
    admissions.push({
      taskInitiallyAbsent: true,
      cell: key,
      role,
      profile,
      taskName,
      stateDir,
      rootDir,
      installRoot: task.installRoot,
      entry: task.entry,
      scriptPath: task.scriptPath,
    });
    await fs.writeFile(admissionPath, JSON.stringify(admissions, null, 2));
    // Both published CLIs support these options; 9.3 has no --runtime-path.
    await cli(task, [
      "gateway",
      "install",
      "--runtime",
      "node",
      "--port",
      String(gatewayPort),
      "--json",
    ]);
    // Installation acknowledges activation; the service owner has not checked readiness yet.
    await awaitReadiness(task, `${role}-startup`);
    return task;
  };
  const status = async (
    task: Task,
    expected: Awaited<ReturnType<typeof readInstalledBuildIdentity>>,
  ) => {
    const value = installedStatusSchema.parse(
      JSON.parse(await cli(task, ["gateway", "status", "--json"])),
    );
    assert.equal(value.rpc.server.version, expected.version);
    assert.equal(value.rpc.server.buildId, expected.buildId);
    assert.equal(value.gateway.version, expected.version);
    assert.equal(value.gateway.port, task.gatewayPort);
    assert.equal(value.rpc.url, `ws://127.0.0.1:${task.gatewayPort}`);
    assert.equal(await owners.canBindLoopbackPort(task.gatewayPort), false);
    assert.equal(readTaskPrincipal(task.taskName).taskState, 4);
    samePath(value.service.command.programArguments[0] ?? "", process.execPath);
    assert.ok(
      value.service.command.programArguments.some(
        (arg) =>
          path.isAbsolute(arg) &&
          arg.toLowerCase().startsWith((packageRoot(task.installRoot) + path.sep).toLowerCase()),
      ),
    );
    const xml = await readTaskXml(task.taskName);
    assert.ok(xml);
    assertInteractiveLeastPrivilegeTask({
      taskXml: xml,
      principal: readTaskPrincipal(task.taskName),
    });
    return value;
  };
  try {
    for (const name of ["appdata", "local-appdata", "tmp", "npm-cache"]) {
      await fs.mkdir(path.join(rootDir, name));
    }
    await fs.writeFile(path.join(rootDir, "npmrc"), "");
    await fs.writeFile(path.join(rootDir, "global-npmrc"), "");
    const selected = await createTask("selected");
    const beforeIdentity = await readInstalledBuildIdentity(
      installRoot,
      key === "fresh" ? input.candidate.version : key,
    );
    const before = await status(selected, beforeIdentity);
    observations.before = before;
    await recordProgress("selected-status-verified");
    let candidateStatus = before;
    const configBefore = await fs.readFile(selected.configPath);
    if (key !== "fresh") {
      const peer = await createTask("peer");
      authorityPeerRoot = peer.installRoot;
      const peerIdentity = await readInstalledBuildIdentity(peer.installRoot, key);
      const peerBefore = await status(peer, peerIdentity);
      const peerXml = await readTaskXml(peer.taskName);
      const peerConfig = await fs.readFile(peer.configPath);
      const peerInstallBefore = await hashInstall(peer.installRoot);
      await recordProgress("peer-before-update:hash-verified");
      if (key === "2026.9.4") {
        observations.siblingBuildRefusal = await assertInstalledSiblingBuildRefusal({
          toolingEntry: path.resolve("scripts/run-node.mjs"),
          selected,
          peer,
          commands,
          signal,
          recordProgress,
          verifyContinuity: async () => {
            assert.equal(
              (await status(selected, beforeIdentity)).service.runtime.pid,
              before.service.runtime.pid,
            );
            assert.equal(
              (await status(peer, peerIdentity)).service.runtime.pid,
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
      observations.update = await runInstalledPublishedUpdate({
        task: selected,
        input,
        inputPath,
        key,
        commands,
        signal,
        observations,
        recordProgress,
      });
      await prepareInstalledPackage({ ...input, installRoot });
      await recordProgress("updated-candidate:hash-verified");
      const candidateIdentity = await readInstalledBuildIdentity(
        installRoot,
        input.candidate.version,
      );
      await awaitReadiness(selected, "candidate-startup");
      const after = await status(selected, candidateIdentity);
      assert.notEqual(after.service.runtime.pid, before.service.runtime.pid);
      observations.after = after;
      candidateStatus = after;
      assert.deepEqual(
        JSON.parse(await fs.readFile(selected.configPath, "utf8")).gateway,
        JSON.parse(configBefore.toString()).gateway,
      );
      assert.equal(await readTaskXml(peer.taskName), peerXml);
      assert.deepEqual(await fs.readFile(peer.configPath), peerConfig);
      const peerAfter = await status(peer, peerIdentity);
      assert.equal(peerAfter.service.runtime.pid, peerBefore.service.runtime.pid);
      observations.peer = { before: peerBefore, after: peerAfter };
      const extras = await doctor(selected, 0);
      assert.equal(
        extras.findings.some((finding) => finding.target === "\\" + peer.taskName),
        false,
      );
      assert.equal(
        extras.findings.some((finding) => finding.target === "\\" + selected.taskName),
        false,
      );
      assert.equal(await readTaskXml(peer.taskName), peerXml);
      assert.deepEqual(await fs.readFile(peer.configPath), peerConfig);
      observations.extraServices = extras;
      assert.deepEqual(await hashInstall(peer.installRoot), peerInstallBefore);
      await recordProgress("peer-after-update:hash-verified");
      observations.peerPreserved = true;
      observations.startupSiblings = await inspectInstalledStartupSiblings({
        selected,
        launcher: peer,
        expectedStatus: after,
        doctor,
        deepStatus: async (task) =>
          JSON.parse(await cli(task, ["gateway", "status", "--deep", "--json"])),
        lifetime,
        admissions,
        admissionPath,
      });
      if (key === "2026.9.4") {
        observations.startupAliasBuildRefusal = await inspectInstalledStartupAliasBuildRefusal({
          toolingEntry: path.resolve("scripts/run-node.mjs"),
          selected,
          peer,
          expectedSelected: after,
          expectedPeer: peerAfter,
          readStatus: async (task) => JSON.parse(await cli(task, ["gateway", "status", "--json"])),
          commands,
          signal,
          lifetime,
          admissions,
          admissionPath,
          waitForLoopbackPortRelease: owners.waitForLoopbackPortRelease,
          recordProgress,
        });
      }
      await cli(peer, ["gateway", "stop", "--force", "--json"]);
      await owners.waitForLoopbackPortRelease(peer.gatewayPort);
      await cli(peer, ["gateway", "uninstall", "--json"]);
    }
    // The packaged candidate must reach its real strict inspection preview, not exit-zero skip.
    const preview = async (task: Task = selected) =>
      parseInstalledPreview(
        await cli(task, ["update", "--dry-run", "--tag", input.tarball, "--json"]),
        task.installRoot,
      );
    if (key === "fresh") {
      observations.discovery = await inspectDisabledDiscoveryTasks({
        selected,
        preview,
        doctor,
        cleanupTask,
        owners,
        id,
        cellIndex,
        key,
        rootDir,
        installRoot,
        admissions,
        admissionPath,
        recordProgress,
      });
      observations.startupSiblings = await inspectInstalledStartupSiblings({
        selected,
        launcher: selected,
        expectedStatus: before,
        doctor,
        deepStatus: async (task) =>
          JSON.parse(await cli(task, ["gateway", "status", "--deep", "--json"])),
        lifetime,
        admissions,
        admissionPath,
      });
    }
    const configBeforePreview = await fs.readFile(selected.configPath);
    const healthy = await preview();
    assert.equal(
      healthy.notes.some((note) => note.includes("Gateway service inspection is unavailable")),
      false,
    );
    await cli(selected, ["gateway", "stop", "--force", "--json"]);
    await owners.waitForLoopbackPortRelease(selected.gatewayPort);
    observations.selectedStartupFallback = await inspectInstalledSelectedStartupFallback({
      ...(key === "2026.9.4"
        ? {
            observeFingerprint: async () => {
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
            },
          }
        : {}),
      selected,
      expectedCommand: candidateStatus.service.command.programArguments,
      doctor,
      deepStatus: async (task) =>
        JSON.parse(await cli(task, ["gateway", "status", "--deep", "--json"])),
      canBindLoopbackPort: owners.canBindLoopbackPort,
      lifetime,
      admissions,
      admissionPath,
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
    const escaped = empty.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    await fs.writeFile(restoreXml, `\uFEFF${xml}`, "utf16le");
    await fs.writeFile(
      malformedXml,
      `\uFEFF${setScheduledTaskXmlEnabled(xml, false)
        .replace(match[0], `<Command>${escaped}</Command>`)
        .replace(/<Arguments>[\s\S]*?<\/Arguments>/u, "")}`,
      "utf16le",
    );
    let previewFailure: Error | undefined;
    try {
      assert.equal(
        (await execSchtasks(["/Create", "/TN", selected.taskName, "/XML", malformedXml, "/F"]))
          .code,
        0,
      );
      const registeredEmpty = await readTaskXml(selected.taskName);
      assert.equal(readTaskPrincipal(selected.taskName).enabled, false);
      const malformed = await preview();
      assert.equal(await readTaskXml(selected.taskName), registeredEmpty);
      assert.ok(
        malformed.notes.some((note) => note.includes("Gateway service inspection is unavailable")),
      );
      assert.equal(await hashFile(selected.scriptPath), canonicalScriptHash);
      observations.strictPreview = {
        healthy,
        malformed,
        canonicalScriptHash,
        malformedLauncherExecuted: false,
      };
    } catch (error) {
      previewFailure = toErrorObject(error, "Installed Scheduled Task fixture failed");
    }
    try {
      assert.equal(
        (await execSchtasks(["/Create", "/TN", selected.taskName, "/XML", restoreXml, "/F"])).code,
        0,
      );
    } catch (error) {
      previewFailure = new AggregateError(
        previewFailure ? [previewFailure, error] : [error],
        "Registered launcher restoration failed",
      );
    }
    if (previewFailure) {
      throw previewFailure;
    }
    assert.deepEqual(await fs.readFile(selected.configPath), configBeforePreview);
    await cli(selected, ["gateway", "uninstall", "--json"]);
    assert.equal(probeScheduledTaskExists(selected.taskName), false);
    if (key === "fresh") {
      assert.deepEqual(await hashInstall(installRoot), initial.installed);
      await recordProgress("fresh-final:hash-verified");
    }
  } catch (error) {
    cellFailure = toErrorObject(error, "Installed Scheduled Task fixture failed");
    if (key !== "fresh" && tasks[0]) {
      observations.updateFailure = await inspectInstalledUpdateFailure(tasks[0]);
    }
    try {
      await recordProgress("before-native-cleanup", cellFailure);
    } catch (recordError) {
      cellFailure = new AggregateError(
        [cellFailure, recordError],
        "Installed proof recording failed",
      );
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
      await cleanupTask(task, packageRoot(task.installRoot), path.join(rootDir, "commands.json"));
      await owners.waitForLoopbackPortRelease(task.gatewayPort);
    } catch (error) {
      cellFailure = new AggregateError(
        cellFailure ? [cellFailure, error] : [error],
        "Native cleanup failed",
      );
    }
  }
  try {
    const remaining = readRelatedProcessDiagnostics(
      tasks.map((task) => packageRoot(task.installRoot)),
    );
    assert.equal(remaining.ok, true);
    assert.equal(remaining.truncated, false);
    assert.deepEqual(remaining.processes, []);
    assert.deepEqual(await owners.readTaskDefinitionSnapshot("OpenClaw Gateway"), defaultBefore);
    await recordCapacityBoundary(inputPath, input, key, "after-native-cleanup");
  } catch (error) {
    cellFailure = new AggregateError(
      cellFailure ? [cellFailure, error] : [error],
      "Native residue remains",
    );
  }
  await fs.writeFile(path.join(rootDir, "commands.json"), JSON.stringify(commands, null, 2));
  results.push({
    key,
    result: cellFailure ? "failed" : "passed",
    commands,
    observations,
    failure: cellFailure ? describeFailure(cellFailure) : undefined,
  });
  if (cellFailure) {
    failure = cellFailure;
  }
  await fs.writeFile(
    proofPath,
    JSON.stringify(
      {
        result: failure ? "failed" : "pass",
        head: input.toolingSha,
        candidate: input.candidate,
        published: input.published,
        cell: key,
        cells: results,
      },
      null,
      2,
    ),
  );
  if (failure) {
    throw failure;
  }
  assert.equal(results.length, 1);
}
