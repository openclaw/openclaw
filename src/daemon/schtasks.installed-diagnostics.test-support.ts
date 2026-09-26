import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { z } from "zod";
import { hashFile, hashInstall } from "../../scripts/lib/gateway-bench-installed-package.ts";
import { listUpdateRunsAsync } from "../infra/update-run-reader.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { run, type CommandRecord } from "./schtasks.installed-command.test-support.js";
import {
  packageRoot,
  type parseInstalledPreview,
} from "./schtasks.installed-package.test-support.js";

export const doctorReportSchema = z.object({
  checksRun: z.number().int().positive(),
  findings: z.array(
    z.object({
      checkId: z.string(),
      severity: z.string(),
      target: z.string().optional(),
      message: z.string(),
    }),
  ),
});
export type InstalledTask = {
  profile: string;
  taskName: string;
  stateDir: string;
  configPath: string;
  scriptPath: string;
  gatewayPort: number;
  rootDir: string;
  installRoot: string;
  entry: string;
  env: NodeJS.ProcessEnv;
};

export async function inspectInstalledUpdateFailure({
  env,
  stateDir,
}: Pick<InstalledTask, "env" | "stateDir">) {
  try {
    const [record] = await listUpdateRunsAsync({ limit: 1 }, { env });
    if (!record) {
      return { unavailable: "No recorded update run" };
    }
    // The installed driver owns this ledger; retain only diagnostic progress, never its payloads.
    return {
      phase: record.phase,
      status: record.status,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
      finishedAtMs: record.finishedAtMs,
      steps: record.steps.map(({ step, status, startedAtMs, endedAtMs }) => ({
        step: redactSupportString(step, { env, stateDir }),
        status,
        startedAtMs,
        endedAtMs,
      })),
    };
  } catch {
    return { unavailable: "Recorded update progress could not be read" };
  }
}

export async function inspectDisabledDiscoveryTasks(params: {
  selected: InstalledTask;
  preview: (task: InstalledTask) => Promise<ReturnType<typeof parseInstalledPreview>>;
  doctor: (task: InstalledTask) => Promise<z.infer<typeof doctorReportSchema>>;
  cleanupTask: (
    task: Pick<InstalledTask, "rootDir" | "stateDir" | "scriptPath" | "taskName">,
    probePath: string,
    eventsPath: string,
  ) => Promise<void>;
  owners: {
    reserveLoopbackPort: () => Promise<number>;
    canBindLoopbackPort: (port: number) => Promise<boolean>;
  };
  id: string;
  cellIndex: number;
  key: string;
  rootDir: string;
  installRoot: string;
  admissions: Array<Record<string, unknown>>;
  admissionPath: string;
  recordProgress: (phase: string, error?: Error) => Promise<void>;
}) {
  const {
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
  } = params;
  const { resolveGatewayWindowsTaskName } = await import("./constants.js");
  const { execSchtasks } = await import("./schtasks-exec.js");
  const { resolveTaskScriptPath } = await import("./schtasks.js");
  const { quoteCmdScriptArg } = await import("./cmd-argv.js");
  const { buildTaskScript } = await import("./schtasks-layout.js");
  const { encodeWindowsLauncherScript } = await import("../infra/windows-launcher-encoding.js");
  const { probeScheduledTaskExists } = await import("./schtasks-state-probe.js");
  const { disableScheduledTaskXmlForFixture, readTaskXml, readTaskPrincipal } =
    await import("./schtasks.integration-observation.test-support.js");
  const { readGatewayServiceState, resolveGatewayService } = await import("./service.js");
  const selectedXml = await readTaskXml(selected.taskName);
  assert.ok(selectedXml);
  const selectedConfig = await fs.readFile(selected.configPath);
  const command = /<Command>([^<]+)<\/Command>/u.exec(selectedXml);
  assert.ok(command);
  assert.equal(selectedXml.match(/<Command>/gu)?.length, 1);
  const fixtures: Array<
    Pick<InstalledTask, "profile" | "taskName" | "stateDir" | "rootDir" | "scriptPath"> & {
      role: "non-gateway" | "missing" | "direct" | "extra";
      gateway?: InstalledTask;
      configBefore?: Buffer;
      scriptHash?: string;
      observedXml?: string;
    }
  > = [];
  let inspectionFailure: Error | undefined;
  let report: z.infer<typeof doctorReportSchema> | undefined;
  let nonGatewayScriptHash: string | undefined;
  let directInspection: Record<string, unknown> | undefined;
  try {
    for (const role of ["non-gateway", "missing", "direct", "extra"] as const) {
      await recordProgress(`disabled-discovery:${role}`);
      const profile: string = ["schtasks-int", id, cellIndex, role].join("-");
      const taskName: string =
        role === "non-gateway"
          ? `OpenClaw Helper (${profile})`
          : role === "extra"
            ? `NativeExtra-${id}-${cellIndex}`
            : resolveGatewayWindowsTaskName(profile);
      const stateDir = path.join(os.userInfo().homedir, `.openclaw-${profile}`);
      const fixtureRoot = path.join(rootDir, role);
      const scriptPath = path.join(fixtureRoot, `${role}.cmd`);
      assert.equal(probeScheduledTaskExists(taskName), false);
      await fs.mkdir(stateDir);
      await fs.mkdir(fixtureRoot);
      if (role === "non-gateway") {
        await fs.writeFile(
          scriptPath,
          encodeWindowsLauncherScript({
            format: "cmd",
            content: `@echo off\r\n${quoteCmdScriptArg(process.execPath)} --version\r\n`,
          }),
        );
        nonGatewayScriptHash = await hashFile(scriptPath);
      } else {
        await assert.rejects(fs.access(scriptPath), { code: "ENOENT" });
      }
      const fixture: (typeof fixtures)[number] = {
        role,
        profile,
        taskName,
        stateDir,
        rootDir: fixtureRoot,
        scriptPath,
      };
      if (role === "direct" || role === "extra") {
        const gatewayPort = await owners.reserveLoopbackPort();
        const configPath = path.join(stateDir, "openclaw.json");
        const env = {
          ...selected.env,
          OPENCLAW_PROFILE: profile,
          OPENCLAW_WINDOWS_TASK_NAME: taskName,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_PORT: String(gatewayPort),
        };
        fixture.gateway = { ...selected, ...fixture, configPath, gatewayPort, env };
        const config = JSON.parse(selectedConfig.toString());
        config.gateway.port = gatewayPort;
        await fs.writeFile(configPath, JSON.stringify(config));
        fixture.configBefore = await fs.readFile(configPath);
        await assert.rejects(fs.access(resolveTaskScriptPath(env)), { code: "ENOENT" });
      }
      fixtures.push(fixture);
      admissions.push({
        taskInitiallyAbsent: true,
        cell: key,
        role,
        profile,
        taskName,
        stateDir,
        rootDir: fixtureRoot,
        installRoot,
        entry: selected.entry,
        scriptPath,
        ...(fixture.gateway ? { cleanupNeedle: profile } : {}),
      });
      await fs.writeFile(admissionPath, JSON.stringify(admissions, null, 2));
      const escapeXml = (value: string) =>
        value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const argv = fixture.gateway
        ? [
            process.execPath,
            selected.entry,
            "--profile",
            profile,
            "gateway",
            "--port",
            String(fixture.gateway.gatewayPort),
          ]
        : undefined;
      if (role === "extra" && fixture.gateway && argv) {
        await fs.writeFile(
          scriptPath,
          encodeWindowsLauncherScript({
            format: "cmd",
            content: buildTaskScript({
              programArguments: argv,
              workingDirectory: fixtureRoot,
              environment: fixture.gateway.env,
            }),
          }),
        );
        fixture.scriptHash = await hashFile(scriptPath);
      }
      const argumentsText = argv
        ?.slice(1)
        .map((arg) => `"${arg}"`)
        .join(" ");
      const action =
        role === "direct" && argv
          ? `<Command>${escapeXml(process.execPath)}</Command><Arguments>${escapeXml(argumentsText ?? "")}</Arguments><WorkingDirectory>${escapeXml(fixtureRoot)}</WorkingDirectory>`
          : `<Command>${escapeXml(scriptPath)}</Command>`;
      const definition: string = disableScheduledTaskXmlForFixture(selectedXml)
        .replace(/<Arguments>[\s\S]*?<\/Arguments>/u, "")
        .replace(/<WorkingDirectory>[\s\S]*?<\/WorkingDirectory>/u, argv ? "" : "$&")
        .replace(command[0], action)
        .replace(/<Triggers>[\s\S]*?<\/Triggers>/u, "<Triggers />")
        .replace(/<URI>[^<]*<\/URI>/u, `<URI>\\${taskName}</URI>`);
      assert.ok(definition.includes("<Triggers />"));
      assert.ok(definition.includes("<AllowStartOnDemand>false</AllowStartOnDemand>"));
      const definitionPath = path.join(fixtureRoot, "task.xml");
      await fs.writeFile(definitionPath, `\uFEFF${definition}`, "utf16le");
      // No trigger or on-demand launch is admitted for these diagnostic definitions.
      assert.equal(
        (await execSchtasks(["/Create", "/TN", taskName, "/XML", definitionPath])).code,
        0,
      );
      assert.equal(readTaskPrincipal(taskName).enabled, false);
      fixture.observedXml = (await readTaskXml(taskName)) ?? undefined;
      assert.ok(fixture.observedXml);
      if (role === "direct" && fixture.gateway && argv) {
        const direct = fixture.gateway;
        const configBefore = await fs.readFile(direct.configPath);
        assert.equal(await owners.canBindLoopbackPort(direct.gatewayPort), true);
        await recordProgress("disabled-discovery:direct-state");
        const state = await readGatewayServiceState(resolveGatewayService(), {
          env: direct.env,
          requireEffective: true,
          requireLoadedCommand: true,
        });
        assert.deepEqual(state.command, {
          programArguments: argv,
          workingDirectory: fixtureRoot,
        });
        assert.equal(state.installed, true);
        assert.equal(state.runtime?.status, "stopped");
        assert.equal(state.runtime?.pid, undefined);
        assert.equal(await owners.canBindLoopbackPort(direct.gatewayPort), true);
        await recordProgress("disabled-discovery:direct-preview");
        const directPreview = await preview(direct);
        assert.ok(
          directPreview.notes.some((note) =>
            note.includes("Gateway service inspection is unavailable"),
          ),
        );
        assert.deepEqual(await fs.readFile(direct.configPath), configBefore);
        assert.equal(await owners.canBindLoopbackPort(direct.gatewayPort), true);
        directInspection = {
          command: state.command,
          runtime: state.runtime,
          preview: directPreview,
        };
      }
    }
    report = await doctor(selected);
    assert.equal(report.checksRun, 1);
    const nonGateway = fixtures.find((fixture) => fixture.role === "non-gateway");
    assert.ok(nonGateway);
    const missing = fixtures.find((fixture) => fixture.role === "missing");
    assert.ok(missing);
    assert.equal(
      report.findings.some((finding) => finding.target === "\\" + nonGateway.taskName),
      false,
    );
    const missingFindings = report.findings.filter(
      (finding) => finding.target === "\\" + missing.taskName,
    );
    assert.equal(missingFindings.length, 1);
    const missingFinding = missingFindings[0];
    assert.ok(missingFinding);
    assert.equal(missingFinding.checkId, "core/doctor/gateway-services/extra");
    assert.equal(missingFinding.severity, "warning");
    assert.match(missingFinding.message, /inspection incomplete/i);
    assert.equal(
      report.findings.some((finding) => finding.target === "\\" + selected.taskName),
      false,
    );
    const extra = fixtures.find((fixture) => fixture.role === "extra");
    assert.ok(extra);
    assert.ok(
      report.findings.some(
        (finding) =>
          finding.target === "\\" + extra.taskName &&
          finding.severity === "info" &&
          finding.checkId === "core/doctor/gateway-services/extra",
      ),
    );
    assert.equal(await hashFile(nonGateway.scriptPath), nonGatewayScriptHash);
    await assert.rejects(fs.access(missing.scriptPath), { code: "ENOENT" });
    for (const fixture of fixtures) {
      if (fixture.gateway) {
        assert.deepEqual(await fs.readFile(fixture.gateway.configPath), fixture.configBefore);
        assert.equal(await owners.canBindLoopbackPort(fixture.gateway.gatewayPort), true);
      }
      if (fixture.scriptHash) {
        assert.equal(await hashFile(fixture.scriptPath), fixture.scriptHash);
      }
      assert.equal(readTaskPrincipal(fixture.taskName).enabled, false);
      assert.equal(await readTaskXml(fixture.taskName), fixture.observedXml);
    }
    assert.equal(await readTaskXml(selected.taskName), selectedXml);
    assert.deepEqual(await fs.readFile(selected.configPath), selectedConfig);
  } catch (error) {
    inspectionFailure = toErrorObject(error, "Installed Scheduled Task fixture failed");
    try {
      await recordProgress("disabled-discovery:before-cleanup", inspectionFailure);
    } catch (recordError) {
      inspectionFailure = new AggregateError(
        [inspectionFailure, recordError],
        "Disabled discovery proof recording failed",
      );
    }
  }
  for (const fixture of fixtures.toReversed()) {
    try {
      await cleanupTask(
        fixture,
        fixture.gateway ? fixture.profile : fixture.scriptPath,
        path.join(fixture.rootDir, "unused-events"),
      );
    } catch (error) {
      inspectionFailure = new AggregateError(
        inspectionFailure ? [inspectionFailure, error] : [error],
        "Disabled discovery task cleanup failed",
      );
    }
  }
  if (inspectionFailure) {
    throw inspectionFailure;
  }
  assert.ok(report);
  assert.ok(directInspection);
  return {
    report,
    directInspection,
    nonGatewayScriptHash,
    definitionsUnchanged: true,
    tasksDisabledThroughoutInspection: true,
    launcherExecutionRequested: false,
    missingDefinitionScope:
      "ENOENT for an owned registered CMD path; no access-denied or ACL claim",
  };
}

/** Native installed-peer build admission; no source-checkout compile or successful build claim. */
export async function assertInstalledSiblingBuildRefusal(params: {
  toolingEntry: string;
  startupEntry?: string;
  selected: InstalledTask;
  peer: InstalledTask;
  commands: CommandRecord[];
  signal: AbortSignal;
  verifyContinuity: () => Promise<void>;
  recordProgress: (phase: string, error?: Error) => Promise<void>;
}) {
  const { toolingEntry, selected, peer, commands, signal, verifyContinuity, recordProgress } =
    params;
  const phase = params.startupEntry ? "startup-alias-refusal" : "task-sibling-refusal";
  const buildRoot = await fs.realpath(packageRoot(peer.installRoot));
  const dist = path.join(buildRoot, "dist");
  assert.equal((await fs.lstat(dist)).isDirectory(), true);
  assert.notEqual(await fs.realpath(packageRoot(selected.installRoot)), buildRoot);
  const before = await hashInstall(peer.installRoot);
  await recordProgress(`${phase}:initial-hash`);
  const toolingEntrySha256 = await hashFile(toolingEntry);
  await run(
    [toolingEntry, "models", "status"],
    { ...selected.env, OPENCLAW_FORCE_BUILD: "1" },
    buildRoot,
    commands,
    1,
    signal,
    {
      expectedStderr: [
        `Refusing to rebuild dist while a managed Gateway (profile ${peer.profile})`,
        params.startupEntry
          ? `stop the process launched by Startup entry ${JSON.stringify(params.startupEntry)}`
          : `openclaw gateway stop --profile ${peer.profile}`,
      ],
    },
  );
  await recordProgress(`${phase}:command-result`);
  await verifyContinuity();
  await recordProgress(`${phase}:continuity-verified`);
  assert.deepEqual(await hashInstall(peer.installRoot), before);
  await recordProgress(`${phase}:final-hash`);
  return {
    kind: "native-installed-peer-build-admission",
    toolingEntry,
    toolingEntrySha256,
    buildRoot,
    dist,
    peerProfile: peer.profile,
    exactSiblingRefusal: true,
    installedFilesUnchanged: true,
    liveRpcAndPidContinuity: true,
    successfulBuildObserved: false,
  };
}
