import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hashFile } from "../../scripts/lib/gateway-bench-installed-package.ts";
import type { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { hasErrnoCode } from "../infra/errno.js";
import { normalizeWindowsTaskIdentity } from "./constants.js";
import {
  assertFields,
  run,
  settleCleanup,
  withInstalledRestoration,
  type CommandRecord,
} from "./schtasks.installed-command.test-support.js";
import {
  assertInstalledSiblingBuildRefusal,
  type doctorReportSchema,
  type InstalledTask,
} from "./schtasks.installed-diagnostics.test-support.js";
import { installedStatusSchema, packageRoot } from "./schtasks.installed-package.test-support.js";

type InstalledStartupInspectionArgs = {
  selected: InstalledTask;
  launcher: InstalledTask;
  doctor: (task: InstalledTask) => Promise<z.infer<typeof doctorReportSchema>>;
  deepStatus: (task: InstalledTask) => Promise<unknown>;
  lifetime: Pick<ReturnType<typeof createFixtureLifetime>, "verifyCleanup">;
  admissions: Array<Record<string, unknown>>;
  admissionPath: string;
};

const startupStatusExtrasSchema = z.object({
  extraServices: z.array(
    z.object({
      platform: z.string(),
      label: z.string(),
      detail: z.string(),
      scope: z.string(),
      windowsStartupEntry: z.string().optional(),
    }),
  ),
});

async function withInstalledStartupEntries(
  params: Pick<
    InstalledStartupInspectionArgs,
    "selected" | "launcher" | "lifetime" | "admissions" | "admissionPath"
  >,
  entries: "canonical" | "canonical-and-alias" | "alias-only",
  inspect: (startupPaths: string[]) => Promise<Record<string, unknown>>,
  settleBeforeRemoval?: () => Promise<void>,
) {
  const { selected, launcher, lifetime, admissions, admissionPath } = params;
  const {
    buildHiddenLauncherScript,
    buildStartupLauncherScript,
    resolveStartupEntryPath,
    resolveTaskLauncherScriptPath,
  } = await import("./schtasks-layout.js");
  const { encodeWindowsLauncherScript } = await import("../infra/windows-launcher-encoding.js");
  const { probeScheduledTaskExists } = await import("./schtasks-state-probe.js");
  const { readTaskXml } = await import("./schtasks.integration-observation.test-support.js");
  const launcherPath = resolveTaskLauncherScriptPath(launcher.env, launcher.scriptPath);
  assert.notEqual(launcherPath, launcher.scriptPath);
  const installedHiddenLauncher = await fs.readFile(launcherPath).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  const sourcePaths = [launcher.scriptPath, ...(installedHiddenLauncher ? [launcherPath] : [])];
  const sourceHashes = await Promise.all(sourcePaths.map((pathname) => hashFile(pathname)));
  const snapshots = await Promise.all(
    [...new Set([selected, launcher])].map(async (task) => {
      assert.equal(probeScheduledTaskExists(task.taskName), true);
      const xml = await readTaskXml(task.taskName);
      assert.ok(xml);
      return { task, xml, config: await fs.readFile(task.configPath) };
    }),
  );
  const canonicalPaths = [
    resolveStartupEntryPath(launcher.env, "cmd"),
    resolveStartupEntryPath(launcher.env, "vbs"),
  ];
  const canonicalBytes = [
    encodeWindowsLauncherScript({
      format: "cmd",
      content: buildStartupLauncherScript({ scriptPath: launcher.scriptPath }),
    }),
    installedHiddenLauncher ??
      encodeWindowsLauncherScript({
        format: "vbs",
        content: buildHiddenLauncherScript({
          scriptPath: launcher.scriptPath,
          taskSupervisor: true,
        }),
      }),
  ];
  const aliasPath = canonicalPaths[1]!.replace(/\.vbs$/u, ".sibling.vbs");
  const admittedPaths = entries === "canonical" ? canonicalPaths : [...canonicalPaths, aliasPath];
  const startupPaths = entries === "alias-only" ? [aliasPath] : admittedPaths;
  const startupBytes =
    entries === "alias-only"
      ? [canonicalBytes[1]!]
      : entries === "canonical-and-alias"
        ? [...canonicalBytes, canonicalBytes[1]!]
        : canonicalBytes;
  for (const pathname of admittedPaths) {
    await assert.rejects(fs.lstat(pathname), { code: "ENOENT" });
  }
  const matches = admissions.filter((record) => record.taskName === launcher.taskName);
  assert.equal(matches.length, 1);
  const admission = matches[0];
  assert.ok(admission);
  assert.ok(admission.role === "selected" || admission.role === "peer");
  if (admission.startupEntryPaths !== undefined) {
    assert.equal(admission.startupEntriesInitiallyAbsent, true);
    assert.deepEqual(admission.startupEntryPaths, canonicalPaths);
  }
  // Admission precedes creation; the workflow removes only these exact owned files.
  admission.startupEntriesInitiallyAbsent = true;
  admission.startupEntryPaths = admittedPaths;
  await fs.writeFile(admissionPath, JSON.stringify(admissions, null, 2));
  const createdPaths: string[] = [];
  const observation = await withInstalledRestoration(
    async () => {
      await fs.mkdir(path.dirname(startupPaths[0]!), { recursive: true });
      for (const [index, pathname] of startupPaths.entries()) {
        const handle = await fs.open(pathname, "wx");
        createdPaths.push(pathname);
        try {
          await handle.writeFile(startupBytes[index]!);
        } finally {
          await handle.close();
        }
      }
      return inspect(startupPaths);
    },
    async () => {
      await lifetime.verifyCleanup(async () => {
        // A live alias fixture must restore and join its Gateway before removing its definition.
        await settleBeforeRemoval?.();
        await settleCleanup(
          [
            async () => {
              for (const snapshot of snapshots) {
                assert.equal(probeScheduledTaskExists(snapshot.task.taskName), true);
                assert.equal(await readTaskXml(snapshot.task.taskName), snapshot.xml);
                assert.deepEqual(await fs.readFile(snapshot.task.configPath), snapshot.config);
              }
              assert.deepEqual(
                await Promise.all(sourcePaths.map((pathname) => hashFile(pathname))),
                sourceHashes,
              );
              for (const [index, pathname] of startupPaths.entries()) {
                assert.deepEqual(await fs.readFile(pathname), startupBytes[index]);
              }
              if (entries === "alias-only") {
                for (const pathname of canonicalPaths) {
                  await assert.rejects(fs.lstat(pathname), { code: "ENOENT" });
                }
              }
            },
            ...createdPaths.map((pathname) => async () => {
              await fs.rm(pathname);
              await assert.rejects(fs.lstat(pathname), { code: "ENOENT" });
            }),
          ],
          "Startup sibling cleanup failed",
        );
      });
    },
    "Installed Startup diagnostics failed",
    "Startup fixture failed",
  );
  return {
    ...observation,
    sourcePaths,
    sourceSha256: sourceHashes,
    startupEntryPaths: startupPaths,
    taskDefinitionsRestored: true,
    startupEntriesRemoved: true,
    launcherExecutionRequested: false,
    launcherScope: installedHiddenLauncher
      ? "CMD wrapper uses the maintained renderer; gateway CMD and VBS bytes come from the installed fixture."
      : "CMD and VBS Startup wrappers use the maintained renderers; gateway CMD bytes come from the unattended installed fixture.",
  };
}

export async function inspectInstalledStartupSiblings(
  params: InstalledStartupInspectionArgs & {
    expectedStatus: z.infer<typeof installedStatusSchema>;
  },
) {
  const { selected, launcher, expectedStatus, doctor, deepStatus } = params;
  const isLauncher = (name: string) =>
    normalizeWindowsTaskIdentity(name) === normalizeWindowsTaskIdentity(launcher.taskName);
  return withInstalledStartupEntries(params, "canonical", async (startupPaths) => {
    const report = await doctor(selected);
    assert.equal(report.checksRun, 1);
    const findings = report.findings.filter(
      (finding) => finding.target && isLauncher(finding.target),
    );
    assert.equal(findings.length, 2);
    for (const pathname of startupPaths) {
      const found = findings.filter((finding) => finding.message.includes(`startup: ${pathname}`));
      assert.equal(found.length, 1);
      assertFields(found[0]!, { checkId: "core/doctor/gateway-services/extra", severity: "info" });
    }
    const value = await deepStatus(selected);
    const status = installedStatusSchema.parse(value);
    assertFields(status, { service: expectedStatus.service, gateway: expectedStatus.gateway });
    assert.deepEqual(status.rpc.server, expectedStatus.rpc.server);
    const { extraServices } = startupStatusExtrasSchema.parse(value);
    const siblings = extraServices.filter((service) => isLauncher(service.label));
    assert.equal(siblings.length, 2);
    for (const pathname of startupPaths) {
      const found = siblings.filter((service) => service.windowsStartupEntry === pathname);
      assert.equal(found.length, 1);
      assertFields(found[0]!, { platform: "win32", scope: "user", detail: `startup: ${pathname}` });
    }
    return { report, status, siblings, scope: "Task-present same-label Startup diagnostics" };
  });
}

export async function inspectInstalledSelectedStartupFallback(
  params: Omit<InstalledStartupInspectionArgs, "launcher"> & {
    expectedCommand: string[];
    canBindLoopbackPort: (port: number) => Promise<boolean>;
    observeFingerprint?: () => Promise<unknown>;
  },
) {
  const { selected, doctor, deepStatus, lifetime, expectedCommand, canBindLoopbackPort } = params;
  const { execSchtasks } = await import("./schtasks-exec.js");
  const { probeScheduledTaskState } = await import("./schtasks-state-probe.js");
  const { readScheduledTaskRuntime } = await import("./schtasks-runtime.js");
  const { captureTaskDefinition, readRelatedProcessDiagnostics } =
    await import("./schtasks.integration-observation.test-support.js");
  const assertStopped = async () => {
    const runtime = await readScheduledTaskRuntime(selected.env, { requireLoaded: true });
    assertFields(runtime, { status: "stopped", pid: undefined });
    assert.equal(await canBindLoopbackPort(selected.gatewayPort), true);
    const processes = readRelatedProcessDiagnostics([selected.profile]);
    assertFields(processes, { ok: true, truncated: false, processes: [] });
  };
  await assertStopped();
  return withInstalledStartupEntries(
    { ...params, launcher: selected },
    "canonical-and-alias",
    async (startupPaths) => {
      const saved = await captureTaskDefinition(
        selected.taskName,
        path.join(selected.rootDir, "startup-restore-task.xml"),
      );
      return withInstalledRestoration(
        async () => {
          assert.equal((await execSchtasks(["/Delete", "/F", "/TN", selected.taskName])).code, 0);
          assert.equal(probeScheduledTaskState(selected.taskName).status, "missing");
          await assertStopped();
          const aliasPath = startupPaths[2];
          assert.ok(aliasPath);
          const report = await doctor(selected);
          assert.equal(report.checksRun, 1);
          assert.equal(report.findings.length, 1);
          assertFields(report.findings[0]!, {
            target: selected.taskName,
            checkId: "core/doctor/gateway-services/extra",
            severity: "info",
          });
          assert.ok(report.findings[0]?.message.includes(`startup: ${aliasPath}`));
          const value = await deepStatus(selected);
          const status = z
            .object({
              service: z.object({
                loaded: z.literal(true),
                runtime: z.object({
                  status: z.literal("stopped"),
                  pid: z.undefined().optional(),
                  detail: z.string(),
                }),
                command: z.object({ programArguments: z.array(z.string()) }),
              }),
              rpc: z.object({ ok: z.literal(false) }),
              gateway: z.object({ port: z.number().int().positive() }),
            })
            .parse(value);
          assert.match(status.service.runtime.detail, /^Startup-folder login item installed;/u);
          assert.deepEqual(status.service.command.programArguments, expectedCommand);
          assert.equal(status.gateway.port, selected.gatewayPort);
          const { extraServices } = startupStatusExtrasSchema.parse(value);
          assert.deepEqual(extraServices, [
            {
              platform: "win32",
              label: selected.taskName,
              detail: `startup: ${aliasPath}`,
              scope: "user",
              windowsStartupEntry: aliasPath,
            },
          ]);
          assert.equal(probeScheduledTaskState(selected.taskName).status, "missing");
          await assertStopped();
          return {
            report,
            status,
            extraServices,
            selectedStartupEntryPaths: startupPaths.slice(0, 2),
            ...(params.observeFingerprint
              ? { fingerprint: await params.observeFingerprint() }
              : {}),
            aliasPath,
            scope:
              "Read-only selected Startup fallback classification with a positive same-label alias; no fallback update or protected-authority claim.",
          };
        },
        async () => {
          await lifetime.verifyCleanup(async () => {
            await saved.restore();
            assert.equal(probeScheduledTaskState(selected.taskName).status, "found");
            await assertStopped();
          });
        },
        "Selected Startup fallback inspection failed",
        "Selected Startup Task restoration failed",
      );
    },
  );
}

/** The alias must be the only discovered binding capable of naming the peer's live dist. */
export async function inspectInstalledStartupAliasBuildRefusal(params: {
  toolingEntry: string;
  selected: InstalledTask;
  peer: InstalledTask;
  expectedSelected: z.infer<typeof installedStatusSchema>;
  expectedPeer: z.infer<typeof installedStatusSchema>;
  readStatus: (task: InstalledTask) => Promise<unknown>;
  commands: CommandRecord[];
  signal: AbortSignal;
  lifetime: Pick<ReturnType<typeof createFixtureLifetime>, "verifyCleanup">;
  admissions: Array<Record<string, unknown>>;
  admissionPath: string;
  waitForLoopbackPortRelease: (port: number) => Promise<void>;
  recordProgress: (phase: string, error?: Error) => Promise<void>;
}) {
  const { selected, peer, expectedPeer, readStatus } = params;
  const { execSchtasks } = await import("./schtasks-exec.js");
  const { readStartupEntryCommand, resolveStartupEntryPaths } =
    await import("./schtasks-layout.js");
  const { resolveFallbackRuntime } = await import("./schtasks-runtime.js");
  const { probeScheduledTaskState } = await import("./schtasks-state-probe.js");
  const { captureTaskDefinition, readRelatedProcessDiagnostics } =
    await import("./schtasks.integration-observation.test-support.js");
  const { mergeGatewayServiceEnv } = await import("./service-env-merge.js");
  const saved = await captureTaskDefinition(
    peer.taskName,
    path.join(peer.rootDir, "startup-alias-restore-task.xml"),
  );
  assert.equal(probeScheduledTaskState(peer.taskName).status, "found");
  const canonicalPaths = resolveStartupEntryPaths(peer.env);
  const peerRpcSchema = installedStatusSchema.pick({ rpc: true, gateway: true });
  let deletionAttempted = false;
  return withInstalledStartupEntries(
    { ...params, launcher: peer },
    "alias-only",
    async (startupPaths) => {
      const aliasPath = startupPaths[0];
      assert.ok(aliasPath);
      assert.equal(startupPaths.length, 1);
      const assertAliasOnly = async () => {
        assert.equal(probeScheduledTaskState(peer.taskName).status, "missing");
        for (const pathname of canonicalPaths) {
          await assert.rejects(fs.lstat(pathname), { code: "ENOENT" });
        }
      };
      const verifyContinuity = async () => {
        await assertAliasOnly();
        const selectedStatus = installedStatusSchema.parse(await readStatus(selected));
        assert.deepEqual(selectedStatus, params.expectedSelected);
        // A missing Task and noncanonical alias cannot supply the ordinary service status PID.
        const peerStatus = peerRpcSchema.parse(await readStatus(peer));
        assert.deepEqual(peerStatus, peerRpcSchema.parse(expectedPeer));
        const command = await readStartupEntryCommand(aliasPath);
        assert.deepEqual(command.programArguments, expectedPeer.service.command.programArguments);
        const runtime = await resolveFallbackRuntime(
          mergeGatewayServiceEnv(peer.env, command),
          command,
          "control",
        );
        assertFields(runtime, { status: "running", pid: expectedPeer.service.runtime.pid });
        await assertAliasOnly();
      };
      // No /End or replacement process: deletion must preserve the already-proven live peer.
      deletionAttempted = true;
      assert.equal((await execSchtasks(["/Delete", "/F", "/TN", peer.taskName])).code, 0);
      await verifyContinuity();
      const refusal = await assertInstalledSiblingBuildRefusal({
        toolingEntry: params.toolingEntry,
        startupEntry: aliasPath,
        selected,
        peer,
        commands: params.commands,
        signal: params.signal,
        verifyContinuity,
        recordProgress: params.recordProgress,
      });
      return {
        ...refusal,
        aliasPath,
        canonicalStartupEntriesAbsent: true,
        peerTaskAbsentDuringRefusal: true,
        peerPid: expectedPeer.service.runtime.pid,
        scope:
          "Alias-only Startup live-dist refusal using the existing peer process; no logon launch, replacement process, successful build, or protected-update claim.",
      };
    },
    async () => {
      if (!deletionAttempted) {
        return;
      }
      await settleCleanup(
        [
          async () => {
            await saved.restore();
            assert.equal(probeScheduledTaskState(peer.taskName).status, "found");
          },
          async () => {
            // Run the guarded owner in the installed profile, outside Vitest's synthetic account.
            await run(
              [peer.entry, "--profile", peer.profile, "gateway", "stop", "--force", "--json"],
              peer.env,
              peer.rootDir,
              params.commands,
            );
            await params.recordProgress("startup-alias-cleanup:command-result");
          },
          () => params.waitForLoopbackPortRelease(peer.gatewayPort),
          async () => {
            const remaining = readRelatedProcessDiagnostics([
              packageRoot(peer.installRoot),
              peer.profile,
              peer.scriptPath,
            ]);
            assertFields(remaining, { ok: true, truncated: false, processes: [] });
          },
        ],
        "Startup alias peer restoration or settlement failed",
      );
    },
  );
}
