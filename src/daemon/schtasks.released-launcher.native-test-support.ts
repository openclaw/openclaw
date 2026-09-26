import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { z } from "zod";
import { hashFile } from "../../scripts/lib/gateway-bench-installed-package.js";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { verifyPackageMember } from "../../scripts/lib/windows-repair-package.mts";
import type { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { hasErrnoCode } from "../infra/errno.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { resolveDiagnosticProcessEnv } from "../infra/process-env.js";
import { resolveWindowsOemCodePage } from "../infra/windows-encoding.js";
import { readWindowsProcessStartTimeSync } from "../infra/windows-process-start.js";
import { readScheduledTaskCommand, resolveStartupEntryPaths } from "./schtasks-layout.js";
import { readScheduledTaskRuntime } from "./schtasks-runtime.js";
import { probeScheduledTaskExists } from "./schtasks-state-probe.js";
import {
  assertInteractiveLeastPrivilegeTask,
  DIAGNOSTIC_TEXT_LIMIT,
  readRelatedProcessDiagnostics,
  readTaskPrincipal,
  readTaskXml,
  waitForRuntimeStatus,
} from "./schtasks.integration-observation.test-support.js";
import { waitForExactProbeRun } from "./schtasks.integration.test-helpers.js";
import {
  expectScheduledTaskProbeOrigin,
  waitForProcessExit,
  type GatewayTaskSupervisorProbe,
} from "./schtasks.task-supervisor.native-test-support.js";
import type { GatewayServiceEnv } from "./service-types.js";

const packageContract = z.object({
  version: z.literal("2026.9.6"),
  tarball: z.string(),
  integrity: z.string(),
  members: z.record(z.string(), z.string()),
});
const installedBinding = z.object({
  version: z.string(),
  integrity: z.string(),
  tarball: z.string(),
  packageRoot: z.string(),
  candidateHead: z.string().regex(/^[0-9a-f]{40}$/u),
});
const memberEvidence = z.array(
  z.object({
    file: z.string(),
    sha256: z.string(),
    exports: z.record(z.string(), z.string()).optional(),
  }),
);

function fixtureEnvironment(env: GatewayServiceEnv): NodeJS.ProcessEnv {
  const projected = resolveDiagnosticProcessEnv(env);
  for (const key of [
    "OPENCLAW_PROFILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_SERVICE_KIND",
    "OPENCLAW_SERVICE_MARKER",
    "OPENCLAW_WINDOWS_TASK_NAME",
    "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER",
  ]) {
    const value = env[key];
    if (value !== undefined) {
      projected[key] = value;
    }
  }
  return projected;
}

async function command(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const collect = (value: string, chunk: string) => {
    truncated ||= value.length + chunk.length > DIAGNOSTIC_TEXT_LIMIT;
    return (value + chunk).slice(0, DIAGNOSTIC_TEXT_LIMIT);
  };
  const code = await runManagedCommand({
    bin: process.execPath,
    args,
    cwd,
    env,
    signal,
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: 30_000,
    onReady: (child) => {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = collect(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = collect(stderr, chunk);
      });
    },
  });
  expect(truncated, "Native command output exceeded its diagnostic bound").toBe(false);
  return { code, stdout, stderr };
}

function processIdentity(pid: number, probePath: string) {
  const birth = readWindowsProcessStartTimeSync(pid);
  if (birth === null) {
    throw new Error("Native process birth is unavailable");
  }
  const capture = readRelatedProcessDiagnostics([probePath]);
  expect(capture.ok).toBe(true);
  expect(capture.truncated).toBe(false);
  const entry = capture.processes.find((candidate) => candidate.ProcessId === pid);
  expect(entry?.CommandLine?.includes(probePath), "Native PID no longer owns the probe").toBe(true);
  expect(readWindowsProcessStartTimeSync(pid)).toBe(birth);
  return { pid, birth };
}

export async function proveReleasedScheduledTask(params: {
  bindingPath: string;
  env: GatewayServiceEnv;
  rootDir: string;
  stateDir: string;
  profile: string;
  taskName: string;
  scriptPath: string;
  launcherPath: string;
  eventsPath: string;
  activePidPath: string;
  gatewayPort: number;
  probe: GatewayTaskSupervisorProbe;
  cliUrl: URL;
  packageOwnerUrl: URL;
  lifetime: ReturnType<typeof createFixtureLifetime>;
  waitForLoopbackPortRelease: (port: number) => Promise<void>;
}) {
  const contract = packageContract.parse(
    JSON.parse(
      await fs.readFile(
        new URL("../../test/fixtures/windows-schtasks-released-package.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const binding = installedBinding.parse(JSON.parse(await fs.readFile(params.bindingPath, "utf8")));
  expect(binding.version).toBe(contract.version);
  expect(binding.integrity).toBe(contract.integrity);
  expect(binding.candidateHead).toBe(process.env.CI_WINDOWS_SCHTASKS_HEAD);
  expect(path.isAbsolute(binding.packageRoot) && path.isAbsolute(binding.tarball)).toBe(true);
  expect(
    "sha512-" + Buffer.from(await hashFile(binding.tarball, "sha512"), "hex").toString("base64"),
  ).toBe(contract.integrity);
  for (const [member, digest] of Object.entries(contract.members)) {
    const verified = await verifyPackageMember(
      binding.packageRoot,
      binding.tarball,
      path.join(binding.packageRoot, member),
    );
    expect(verified.sha256).toBe(digest);
  }
  // The released renderer cannot launch the literal-caret fixture used by the candidate.
  expect(params.rootDir).not.toMatch(/[%^!]/u);
  const codePage = resolveWindowsOemCodePage();
  expect(codePage).not.toBeNull();
  const marker = randomUUID();
  const foreignMarker = randomUUID();
  const foreignPath = path.join(params.rootDir, "foreign-probe.mts");
  const foreignEvents = path.join(params.rootDir, "foreign-runs.txt");
  const installerEvidence = path.join(params.rootDir, "released-installer.json");
  const supervisorEvidence = path.join(params.rootDir, "released-supervisor.json");
  const programArguments = [
    process.execPath,
    params.probe.probePath,
    "gateway",
    "--port",
    String(params.gatewayPort),
    params.eventsPath,
    params.activePidPath,
  ];
  const env = fixtureEnvironment({
    ...params.env,
    OPENCLAW_PROFILE: params.profile,
    OPENCLAW_SERVICE_KIND: "gateway",
    OPENCLAW_SERVICE_MARKER: "openclaw",
    OPENCLAW_WINDOWS_TASK_NAME: params.taskName,
  });
  const serviceEnvironment = {
    OPENCLAW_PROFILE: params.profile,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_GATEWAY_PORT: String(params.gatewayPort),
    OPENCLAW_WINDOWS_TASK_NAME: params.taskName,
    OPENCLAW_SERVICE_KIND: "gateway",
    OPENCLAW_SERVICE_MARKER: "openclaw",
  };
  // Released owners run separately so their SQLite handles never enter the candidate graph.
  const source = [
    'import fs from "node:fs";',
    'import { createServer } from "node:http";',
    "const allowed = new Set(" +
      JSON.stringify(
        [...Object.keys(env), ...Object.keys(serviceEnvironment)].map((key) => key.toUpperCase()),
      ) +
      ");",
    "for (const key of Object.keys(process.env)) if (!allowed.has(key.toUpperCase())) delete process.env[key];",
    "const packageRoot = " + JSON.stringify(binding.packageRoot) + ";",
    "const tarball = " + JSON.stringify(binding.tarball) + ";",
    "const packageOwnerUrl = " + JSON.stringify(params.packageOwnerUrl.href) + ";",
    "if (process.argv.includes('--install-released')) {",
    "  const { loadPackagedOwner } = await import(packageOwnerUrl);",
    "  const members = [];",
    "  const owner = await loadPackagedOwner(packageRoot, tarball, 'schtasks', ['installScheduledTask'], members);",
    "  const layout = await loadPackagedOwner(packageRoot, tarball, 'schtasks-layout', ['readScheduledTaskCommand'], members);",
    "  await owner.installScheduledTask({ env: process.env, stdout: process.stdout,",
    "    programArguments: " + JSON.stringify(programArguments) + ",",
    "    workingDirectory: " + JSON.stringify(params.rootDir) + ",",
    "    environment: " + JSON.stringify(serviceEnvironment) + " });",
    "  const command = await layout.readScheduledTaskCommand(process.env);",
    "  fs.writeFileSync(" +
      JSON.stringify(installerEvidence) +
      ", JSON.stringify({ members, command }));",
    "} else if (process.argv.includes('--task-supervisor')) {",
    "  const { loadPackagedOwner } = await import(packageOwnerUrl);",
    "  const members = [];",
    "  const owner = await loadPackagedOwner(packageRoot, tarball, 'task-supervisor', ['runWindowsGatewayTaskSupervisor'], members);",
    "  fs.writeFileSync(" +
      JSON.stringify(params.probe.supervisorPidPath) +
      ", String(process.pid));",
    "  fs.writeFileSync(" + JSON.stringify(supervisorEvidence) + ", JSON.stringify(members));",
    "  await owner.runWindowsGatewayTaskSupervisor();",
    "} else {",
    "  const foreign = process.argv.includes('--foreign');",
    "  const events = foreign ? " +
      JSON.stringify(foreignEvents) +
      " : " +
      JSON.stringify(params.eventsPath) +
      ";",
    "  const marker = foreign ? " +
      JSON.stringify(foreignMarker) +
      " : " +
      JSON.stringify(marker) +
      ";",
    "  const append = (phase) => fs.appendFileSync(events, JSON.stringify({ phase, pid: process.pid, ppid: process.ppid }) + '\\n');",
    "  append('started');",
    "  const server = createServer((_request, response) => response.end(JSON.stringify({ marker, pid: process.pid })));",
    "  server.listen(" + params.gatewayPort + ", '127.0.0.1', () => {",
    "    if (!foreign) fs.writeFileSync(" +
      JSON.stringify(params.activePidPath) +
      ", String(process.pid));",
    "    append('listening');",
    "  });",
    "}",
    "",
  ].join("\n");
  await fs.writeFile(params.probe.probePath, source, "utf8");
  await fs.writeFile(foreignPath, source, "utf8");
  expect(probeScheduledTaskExists(params.taskName)).toBe(false);
  const installed = await params.lifetime.track(
    command([params.probe.probePath, "--install-released"], params.rootDir, env),
  );
  expect(installed.code, installed.stderr || installed.stdout).toBe(0);
  const installedRecord = z
    .object({
      members: memberEvidence,
      command: z.object({ programArguments: z.array(z.string()) }),
    })
    .parse(JSON.parse(await fs.readFile(installerEvidence, "utf8")));
  expect(installedRecord.command.programArguments).toEqual(programArguments);
  const ownedRun = await waitForExactProbeRun(params.eventsPath, 1);
  expectScheduledTaskProbeOrigin({
    eventsPath: params.eventsPath,
    probePath: params.probe.probePath,
    run: ownedRun,
    scriptPath: params.scriptPath,
    readRelatedProcessDiagnostics,
  });
  const owned = processIdentity(ownedRun.pid, params.probe.probePath);
  const supervisorPid = Number(await fs.readFile(params.probe.supervisorPidPath, "utf8"));
  const supervisor = processIdentity(supervisorPid, params.probe.probePath);
  const supervisorMembers = memberEvidence.parse(
    JSON.parse(await fs.readFile(supervisorEvidence, "utf8")),
  );
  // A Gateway lease would bypass the legacy argv attribution being exercised.
  expect(readGatewayOwnerLease({ env })).toBeUndefined();
  const ownedResponse = await fetch("http://127.0.0.1:" + params.gatewayPort, {
    signal: AbortSignal.timeout(5_000),
  });
  expect(await ownedResponse.json()).toEqual({ marker, pid: owned.pid });
  const xml = await readTaskXml(params.taskName);
  expect(xml).not.toBeNull();
  if (!xml) {
    throw new Error("Released task registration is missing");
  }
  const principal = readTaskPrincipal(params.taskName);
  expect(principal.taskState).toBe(4);
  assertInteractiveLeastPrivilegeTask({ taskXml: xml, principal });
  for (const entry of resolveStartupEntryPaths(env)) {
    await expect(fs.access(entry)).rejects.toThrow();
  }
  const definition = {
    cmd: await hashFile(params.scriptPath),
    vbs: await hashFile(params.launcherPath),
    xml,
  };
  const unchanged = async () => {
    expect(await hashFile(params.scriptPath)).toBe(definition.cmd);
    expect(await hashFile(params.launcherPath)).toBe(definition.vbs);
    expect(await readTaskXml(params.taskName)).toBe(definition.xml);
    expect((await readScheduledTaskCommand(env))?.programArguments).toEqual(programArguments);
  };
  const cli = (args: string[]) =>
    params.lifetime.track(
      command(
        [fileURLToPath(params.cliUrl), "--profile", params.profile, "gateway", ...args],
        params.rootDir,
        { ...env, OPENCLAW_NO_RESPAWN: "1", NODE_DISABLE_COMPILE_CACHE: "1" },
      ),
    );
  const status = await cli(["status", "--json", "--no-probe"]);
  expect(status.code, status.stderr || status.stdout).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    service: { loadState: { status: "loaded" }, runtime: { status: "running", pid: owned.pid } },
  });
  expect(processIdentity(owned.pid, params.probe.probePath)).toEqual(owned);
  await unchanged();
  const stopped = await cli(["stop", "--force", "--json"]);
  expect(stopped.code, stopped.stderr || stopped.stdout).toBe(0);
  await Promise.all([waitForProcessExit(owned.pid), waitForProcessExit(supervisor.pid)]);
  await params.waitForLoopbackPortRelease(params.gatewayPort);
  await waitForRuntimeStatus(() => readScheduledTaskRuntime(env), "stopped");
  expect(readTaskPrincipal(params.taskName).taskState).toBe(3);
  await unchanged();

  const cancel = new AbortController();
  const foreignCommand = params.lifetime.track(
    command(
      [foreignPath, "gateway", "--port", String(params.gatewayPort), "--foreign"],
      params.rootDir,
      env,
      cancel.signal,
    )
      .then((result) => {
        expect(result.code, result.stderr || result.stdout).toBe(0);
      })
      .catch((error: unknown) => {
        // Managed cancellation reports ABORT_ERR only after its Job and output join.
        if (!cancel.signal.aborted || !hasErrnoCode(error, "ABORT_ERR")) {
          throw error;
        }
      }),
  );
  let foreignIdentity: ReturnType<typeof processIdentity> | undefined;
  try {
    const foreignRun = await waitForExactProbeRun(foreignEvents, 1);
    foreignIdentity = processIdentity(foreignRun.pid, foreignPath);
    expect(readGatewayOwnerLease({ env })).toBeUndefined();
    const rejected = await cli(["stop", "--force", "--json"]);
    expect(rejected.code).not.toBe(0);
    expect(rejected.stdout + rejected.stderr).toMatch(
      /remaining listener ownership could not be verified|still busy/iu,
    );
    expect(processIdentity(foreignRun.pid, foreignPath)).toEqual(foreignIdentity);
    const response = await fetch("http://127.0.0.1:" + params.gatewayPort, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(await response.json()).toEqual({ marker: foreignMarker, pid: foreignRun.pid });
    await unchanged();
  } finally {
    cancel.abort();
    await params.lifetime.verifyCleanup(() => foreignCommand);
  }
  await params.waitForLoopbackPortRelease(params.gatewayPort);
  return {
    version: contract.version,
    integrity: contract.integrity,
    codePage,
    runtime: process.version,
    principal,
    installerMembers: installedRecord.members,
    supervisorMembers,
    owned,
    supervisor,
    foreign: foreignIdentity,
    taggedLauncherUnchanged: true,
    registeredArgvUnchanged: true,
    noGatewayOwnerRow: true,
    candidateCliStatus: true,
    candidateCliOwnedStop: true,
    foreignListenerRejectedAndPreserved: true,
    portReleaseRebind: true,
    cmdSha256: definition.cmd,
    vbsSha256: definition.vbs,
    taskXmlSha256: createHash("sha256").update(definition.xml).digest("hex"),
    registeredArgvSha256: createHash("sha256")
      .update(JSON.stringify(programArguments))
      .digest("hex"),
  };
}
