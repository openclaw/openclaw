import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildLaunchAgentEnvironmentWrapper } from "./launchd-env-wrapper.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import "./test-helpers/service-audit-mocks.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import {
  resolveLaunchAgentPlistPath,
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvWrapperPath,
} from "./launchd-service-files.js";
import { resolveGatewaySupervisorLogPaths } from "./restart-logs.js";
import {
  buildTaskScript,
  buildHiddenLauncherScript,
  resolveTaskScriptPath,
  resolveTaskLauncherScriptPath,
} from "./schtasks-layout.js";
import { buildScheduledTaskXml } from "./schtasks-xml.js";
import { auditGatewayInstallPreservation } from "./service-audit-preservation.js";
import type { ServiceDefinitionDrift } from "./service-audit-types.js";
import { auditGatewayServiceConfig as inspectGatewayServiceConfig } from "./service-audit.js";
import { buildSystemdUnit } from "./systemd-unit.js";
import {
  execSystemctlUserMock,
  resetServiceAuditMocks,
} from "./test-helpers/service-audit-fixtures.js";
import { seedCompletedRuntimePinMigration } from "./test-helpers/service-audit-runtime-pin.js";

const native = vi.hoisted(() => ({ task: vi.fn() }));
// mock-isolation: Definition facts come from the synthetic scheduler, not host task mutations.
vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: native.task,
  execScheduledTaskEnabledChange: (taskName: string, enabled: boolean) =>
    native.task(["/Change", "/TN", taskName, enabled ? "/ENABLE" : "/DISABLE"]),
}));
vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runExec: vi.fn(async (_command: string, args: string[], options: { input: Uint8Array }) =>
    decodeLaunchAgentPlistFixture(options.input, args[1]),
  ),
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
let runtimePinStateDir: string;
beforeEach(() => {
  resetServiceAuditMocks();
  native.task.mockReset();
  runtimePinStateDir = dirs.make("definition-facts-runtime-pin-");
});

type AuditOptions = Parameters<typeof inspectGatewayServiceConfig>[0];
async function auditGatewayServiceConfig(
  options: Omit<AuditOptions, "platform"> & { platform?: NodeJS.Platform },
) {
  const env = {
    ...options.env,
    OPENCLAW_STATE_DIR: options.env.OPENCLAW_STATE_DIR ?? runtimePinStateDir,
  };
  await seedCompletedRuntimePinMigration(env);
  return inspectGatewayServiceConfig({ platform: "linux", ...options, env });
}

const staleServiceEnvironment = {
  OPENCLAW_SERVICE_MARKER: "openclaw",
  OPENCLAW_SERVICE_KIND: "gateway",
  OPENCLAW_SERVICE_VERSION: "2026.7.1-2",
};

const drift = (kind: string, key: string, fields = {}) =>
  expect.objectContaining({ kind, key, ...fields });
const programArguments = ["/usr/bin/node", "/opt/openclaw/index.js", "gateway"];
function launchdFixture() {
  const home = dirs.make("definition-facts-launchd-");
  const env = { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") };
  const { stdoutPath } = resolveGatewaySupervisorLogPaths(env);
  return {
    env,
    sourcePath: resolveLaunchAgentPlistPath(env),
    plist: {
      label: "ai.openclaw.gateway",
      comment: "OpenClaw Gateway",
      stdoutPath,
      stderrPath: stdoutPath,
    },
  };
}

async function systemdFixture(
  change: (unit: string) => string = (unit) => unit,
  dropIn?: string,
  environment: Record<string, string> = {},
) {
  const home = dirs.make("definition-facts-systemd-");
  const sourcePath = path.join(home, ".config/systemd/user/openclaw-gateway.service");
  const command = {
    programArguments,
    environment: {
      PATH: "/usr/bin:/bin",
      NODE_OPTIONS: "--max-old-space-size=4096",
      OPERATOR_SETTING: "operator-secret",
      ...environment,
    },
    sourcePath,
    definitionPaths: [sourcePath],
  };
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  const content = change(buildSystemdUnit(command));
  await fs.writeFile(sourcePath, content);
  if (dropIn) {
    const file = `${sourcePath}.d/operator.conf`;
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, dropIn);
    command.definitionPaths.push(file);
  }
  return {
    content,
    sourcePath,
    command,
    env: { HOME: home },
    expectedServicePath: "/usr/bin:/bin",
  };
}

it("audits missing KillMode separately from effective manager policy", async () => {
  const fixture = await systemdFixture((unit) => unit.replace("KillMode=mixed\n", ""));
  execSystemctlUserMock.mockResolvedValue({
    code: 0,
    stderr: "",
    termination: "exit",
    stdout:
      "LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=330s\n",
  });
  const result = await auditGatewayServiceConfig(fixture);
  expect(result.ok).toBe(true);
  expect(result.issues).toEqual([]);
  expect(result.definitionDrift).toEqual([
    {
      kind: "outdated",
      key: "Service.KillMode",
      current: null,
      expected: "mixed",
      sourcePath: fixture.sourcePath,
      message: expect.stringContaining("Service.KillMode"),
    },
  ]);
  expect(await fs.readFile(fixture.sourcePath, "utf8")).toBe(fixture.content);
});

it.each(["drop-in-dependency", "description"])(
  "reports unknown %s edits without exposing their values",
  async (kind) => {
    const description = kind === "description";
    const fixture = await systemdFixture(
      (unit) =>
        description
          ? unit.replace("Description=OpenClaw Gateway", "Description=operator-secret")
          : unit,
      kind === "drop-in-dependency"
        ? "[Unit]\nAfter=network-online.target operator-secret\n"
        : undefined,
      staleServiceEnvironment,
    );
    const result = await auditGatewayServiceConfig({
      ...fixture,
      ...(description ? { expectedCommand: fixture.command } : {}),
    });
    expect(result.definitionDrift).toContainEqual(
      expect.objectContaining({
        kind: "unknown-edit",
        key: description ? "Unit.Description" : "Unit.After",
        sourcePath: expect.stringContaining(description ? ".service" : "operator.conf"),
      }),
    );
    expect(JSON.stringify(result.definitionDrift)).not.toContain("operator-secret");
  },
);

it.each(["other-source", "unreadable-drop-in"])(
  "does not report a complete definition inspection when %s",
  async (state) => {
    const fixture = await systemdFixture();
    if (state === "unreadable-drop-in") {
      fixture.command.definitionPaths.push(`${fixture.sourcePath}.d/unreadable.conf`);
    } else if (state === "other-source") {
      fixture.command.sourcePath = path.join(fixture.env.HOME, "system.service");
      fixture.command.definitionPaths = [fixture.command.sourcePath];
      await fs.unlink(fixture.sourcePath);
    }
    const result = await auditGatewayServiceConfig(fixture);
    expect(result.definitionDrift).toBeUndefined();
    expect(result.definitionDriftError).toEqual(expect.any(String));
    if (state === "unreadable-drop-in") {
      expect(result.issues).toEqual([]);
      expect(result.definitionDriftError).toContain("inspection could not be completed");
    }
  },
);

it.each(["base", "drop-in"])("recognizes standard systemd directives in %s", async (location) => {
  const custom = [
    "[Unit]",
    "OnFailure=recovery.service",
    "StartLimitBurst=10",
    "StartLimitIntervalSec=120",
    "[Service]",
    "CPUWeight=1000",
    "KillMode=control-group",
    "ManagedOOMPreference=avoid",
    "TimeoutStartSec=60",
    "ExecStartPre=/usr/bin/true",
    "RestartSteps=5",
    "RestartMaxDelaySec=60",
    "ProtectSystem=strict",
    "MemoryMax=1G",
    "[Install]",
    "Alias=custom.service",
    "Also=helper.service",
  ].join("\n");
  const fixture = await systemdFixture(
    (unit) => (location === "base" ? `${unit}\n${custom}\n` : unit),
    location === "drop-in" ? `${custom}\n` : undefined,
  );
  const result = await auditGatewayServiceConfig(fixture);
  const sourcePath =
    location === "base" ? fixture.sourcePath : `${fixture.sourcePath}.d/operator.conf`;
  expect(result.definitionDrift).toContainEqual(
    expect.objectContaining({
      kind: "unknown-edit",
      key: "Service.CPUWeight",
      sourcePath,
      message: expect.stringContaining("not changed"),
    }),
  );
  expect(JSON.stringify(result.definitionDrift)).not.toContain("unrecognized");

  await fs.appendFile(sourcePath, "\n[Service]\nRestartStpes=5\nOnFailure=wrong-section.service\n");
  const unknown = (await auditGatewayServiceConfig(fixture)).definitionDrift?.filter((fact) =>
    fact.message.includes("unrecognized"),
  );
  expect(unknown?.map((fact) => fact.key)).toEqual(["Service.RestartStpes", "Service.OnFailure"]);
});

it.each([
  { seconds: undefined, kind: "outdated" },
  { seconds: 20, kind: "outdated" },
  { seconds: 30, kind: "preserved" },
  { seconds: 600, kind: "preserved" },
  { seconds: 0, kind: "preserved" },
  { seconds: 330, kind: undefined },
  { seconds: 600, kind: "preserved", stale: true },
  { seconds: 20, kind: "outdated", throttle: 1 },
  { seconds: 20, kind: "outdated", throttle: 60 },
  { seconds: 20, kind: "outdated", wrapped: true },
  { seconds: 20, kind: "preserved", throttle: 45 },
  { seconds: 20, kind: "preserved", customized: "ProcessType" },
  { seconds: 20, kind: "preserved", customized: "ProgramArguments" },
  { seconds: 20, kind: "preserved", customized: "Comment" },
  { seconds: 20, kind: "preserved", customized: "WorkingDirectory" },
  { seconds: 20, kind: "preserved", customized: "UnknownKey" },
])(
  "audits launchd exit timeout $seconds and preserves custom policy (throttle=$throttle, customized=$customized, wrapped=$wrapped)",
  async ({ seconds, kind, stale, throttle, customized, wrapped }) => {
    const { env, sourcePath, plist } = launchdFixture();
    const command = {
      programArguments: [
        ...programArguments,
        ...(customized === "ProgramArguments" ? ["--verbose"] : []),
      ],
      environment: { PATH: "/usr/bin:/bin", ...(stale ? staleServiceEnvironment : {}) },
    };
    const original = buildLaunchAgentPlist({
      ...plist,
      ...command,
      programArguments: wrapped
        ? [
            "/bin/sh",
            resolveLaunchAgentEnvWrapperPath(env, "ai.openclaw.gateway"),
            resolveLaunchAgentEnvFilePath(env, "ai.openclaw.gateway"),
            ...command.programArguments,
          ]
        : command.programArguments,
      ...(customized === "WorkingDirectory" ? { workingDirectory: "/operator/workspace" } : {}),
      comment: customized === "Comment" ? "Operator service" : "OpenClaw Gateway",
    })
      .replace(
        /<key>ExitTimeOut<\/key>\s*<integer>\d+<\/integer>/u,
        seconds === undefined ? "" : `<key>ExitTimeOut</key><integer>${seconds}</integer>`,
      )
      .replace(
        /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/u,
        `<key>ThrottleInterval</key><integer>${throttle ?? 10}</integer>`,
      )
      .replace(
        "<string>Interactive</string>",
        `<string>${customized === "ProcessType" ? "Background" : "Interactive"}</string>`,
      )
      .replace(
        "<key>Label</key>",
        `${customized === "UnknownKey" ? "<key>LowPriorityIO</key><true/>" : ""}<key>Label</key>`,
      );
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, original);
    const result = await auditGatewayServiceConfig({
      env,
      command,
      platform: "darwin",
      expectedServicePath: "/usr/bin:/bin",
    });
    expect(result.issues).toEqual(
      seconds === undefined || (seconds > 0 && seconds < 330)
        ? [
            expect.objectContaining({
              code: "launchd-stop-timeout",
              message: expect.stringContaining(
                seconds === 20 && kind === "preserved"
                  ? "not changed because the definition is customized"
                  : "ExitTimeOut=330",
              ),
            }),
          ]
        : [],
    );
    const expectedDrift = [
      kind &&
        drift(
          kind,
          "ExitTimeOut",
          kind === "preserved"
            ? { message: expect.stringContaining("not changed") }
            : { current: seconds ?? null, expected: 330 },
        ),
      throttle &&
        drift(
          throttle === 45 ? "preserved" : "outdated",
          "ThrottleInterval",
          throttle === 45 ? {} : { current: throttle, expected: 10 },
        ),
      customized === "ProcessType" && drift("preserved", "ProcessType"),
      customized === "UnknownKey" && drift("unknown-edit", "LowPriorityIO"),
    ].filter(Boolean);
    expect(result.definitionDrift ?? []).toEqual(expect.arrayContaining(expectedDrift));
    expect(result.definitionDrift ?? []).toHaveLength(expectedDrift.length);
    expect(await fs.readFile(sourcePath, "utf8")).toBe(original);
  },
);

it("preserves custom Scheduled Task retry policy despite stale service metadata", async () => {
  const home = dirs.make("definition-facts-task-");
  const env = { USERPROFILE: home, OPENCLAW_STATE_DIR: home, USERNAME: "fixture" };
  const command = {
    programArguments: ["node", "C:\\openclaw\\index.js", "gateway"],
    environment: staleServiceEnvironment,
  };
  const xml = buildScheduledTaskXml({
    taskDescription: "fixture",
    taskUser: "fixture",
    launchPath: resolveTaskScriptPath(env),
  }).replace("<Count>3</Count>", "<Count>9</Count>");
  native.task.mockResolvedValue({ code: 0, stdout: xml, stderr: "" });
  const result = await auditGatewayServiceConfig({ env, command, platform: "win32" });
  expect(result.ok).toBe(true);
  expect(result.issues).toEqual([]);
  expect(result.definitionDrift).toEqual([
    drift("preserved", "Settings.RestartOnFailure.Count", {
      message: expect.stringContaining("not changed"),
    }),
  ]);
  expect(native.task).toHaveBeenCalledExactlyOnceWith([
    "/Query",
    "/TN",
    "OpenClaw Gateway",
    "/XML",
  ]);
});

it("reports failed native task inspection independently from legacy issues", async () => {
  native.task.mockResolvedValue({ code: 1, stdout: "", stderr: "operator-secret" });
  const result = await auditGatewayServiceConfig({
    env: { USERPROFILE: dirs.make("definition-facts-task-unavailable-") },
    command: { programArguments: ["node", "C:\\openclaw\\index.js", "gateway"] },
    platform: "win32",
  });
  expect(result.issues).toEqual([]);
  expect(result.definitionDriftError).toContain("inspection could not be completed");
  expect(JSON.stringify(result)).not.toContain("operator-secret");
});

const discardedSettings: Array<[string, string[]?, string?, Record<string, string>?]> = [
  ["ProgramArguments", ["--inspect=operator-private"]],
  ["WorkingDirectory", [], "/operator-private"],
  ["Environment.PATH", [], undefined, { PATH: "/usr/bin:/operator-private" }],
  [
    "Environment.NODE_OPTIONS",
    [],
    undefined,
    {
      NODE_OPTIONS: "--max-old-space-size=4096 --require=/operator-private",
    },
  ],
];

it.each(discardedSettings)(
  "blocks a rewrite plan that discards %s with a safe environment diff",
  async (key, nativeArguments, cwd, environment = {}) => {
    const fixture = await systemdFixture();
    const command = {
      ...fixture.command,
      programArguments: ["/usr/bin/node", ...(nativeArguments ?? []), "/old/index.js", "gateway"],
      workingDirectory: cwd,
      environment: { ...fixture.command.environment, ...environment },
    };
    const before = await auditGatewayServiceConfig({ ...fixture, command });
    expect(before.definitionDrift).toBeUndefined();
    const result = await auditGatewayServiceConfig({
      ...fixture,
      command,
      expectedCommand: fixture.command,
    });
    expect(result.definitionDrift).toContainEqual(drift("unknown-edit", key));
    if (key === "Environment.PATH") {
      expect(result.definitionDrift?.[0]?.message).toContain(
        'Current: "/usr/bin:/operator-private"; installer: "/usr/bin:/bin"',
      );
    } else {
      expect(JSON.stringify(result.definitionDrift)).not.toContain("operator-private");
      if (key.startsWith("Environment.")) {
        expect(result.definitionDrift?.[0]?.message).toContain("Current: <redacted>; installer:");
      }
    }
    expect(await fs.readFile(fixture.sourcePath, "utf8")).toBe(fixture.content);
  },
);

it("accepts retained heap aliases, custom environment and owned environment regeneration", async () => {
  const fixture = await systemdFixture();
  const command = {
    ...fixture.command,
    programArguments: [
      "/old/node",
      "--max_old_space_size",
      "2048",
      "--max-old-space-size=4096",
      "/old/index.js",
      "gateway",
      "--port=1234",
      "--allow-unconfigured",
    ],
    environment: {
      ...fixture.command.environment,
      OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "MANAGED_SETTING",
      MANAGED_SETTING: "old",
      OPENCLAW_GATEWAY_PORT: "1234",
    },
  };
  const result = await auditGatewayServiceConfig({
    ...fixture,
    command,
    expectedCommand: {
      programArguments: [
        "/new/node",
        "--max-old-space-size=4096",
        "/new/index.js",
        "gateway",
        "--port",
        "4321",
      ],
      environment: { ...fixture.command.environment, OPENCLAW_GATEWAY_PORT: "4321" },
    },
  });
  expect(result.definitionDrift).toBeUndefined();
});

it("bounds environment diffs and redacts nonnumeric timeout values", () => {
  const command = {
    programArguments,
    environment: {
      PATH: `/usr/bin:${"/long-directory".repeat(100)}\nforged diagnostic`,
      OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS: "operator-secret",
    },
  };
  const findings: ServiceDefinitionDrift[] = [];
  auditGatewayInstallPreservation(
    command,
    { ...command, environment: { PATH: "/usr/bin" } },
    "linux",
    findings,
  );
  expect(findings).toHaveLength(2);
  expect(findings[0]?.message).toContain('…; installer: "/usr/bin"');
  expect(findings[0]!.message.length).toBeLessThan(420);
  expect(findings[1]?.message).toContain("Current: <redacted>; installer: <absent>");
  expect(JSON.stringify(findings)).not.toContain("operator-secret");
  expect(findings.some((finding) => finding.message.includes("\n"))).toBe(false);
});

it("reports a missing managed value when no drop-in supplies it", async () => {
  const key = "OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS";
  const fixture = await systemdFixture();
  const managedDefinition = {
    ...fixture.command,
    environment: { ...fixture.command.environment, OPENCLAW_SERVICE_MANAGED_ENV_KEYS: key },
  };
  const result = await auditGatewayServiceConfig({
    ...fixture,
    command: { ...managedDefinition, managedDefinition },
    expectedCommand: {
      ...managedDefinition,
      environment: { ...managedDefinition.environment, [key]: "30000" },
    },
  });
  expect(result.definitionDrift).toEqual([
    drift("outdated", `Environment.${key}`, {
      message: expect.stringContaining('Current: <absent>; installer: "30000"'),
    }),
  ]);
});

it.each(["legacy-wrapper", "malformed-args", "wrapper", "metadata"])(
  "audits launchd %s before the installer can replace it",
  async (kind) => {
    const { env, sourcePath, plist } = launchdFixture();
    const command = {
      programArguments,
      environment: { PATH: "/usr/bin:/bin", ...staleServiceEnvironment },
    };
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      buildLaunchAgentPlist({
        ...plist,
        ...command,
        programArguments:
          kind === "malformed-args"
            ? [
                "/bin/sh",
                resolveLaunchAgentEnvWrapperPath(env, "ai.openclaw.gateway"),
                command.programArguments[0]!,
                ...command.programArguments,
              ]
            : command.programArguments,
        comment: kind === "metadata" ? "operator-private" : "OpenClaw Gateway",
      }),
    );
    if (kind !== "metadata") {
      const wrapperPath = resolveLaunchAgentEnvWrapperPath(env, "ai.openclaw.gateway");
      await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
      await fs.writeFile(
        wrapperPath,
        kind === "malformed-args"
          ? buildLaunchAgentEnvironmentWrapper()
          : kind === "legacy-wrapper"
            ? '#!/bin/sh\nset -eu\nenv_file="$1"\nshift\nif [ -f "$env_file" ]; then\n  . "$env_file"\nfi\nexec "$@"\n'
            : '#!/bin/sh\necho operator-private\nexec "$@"\n',
      );
    }
    const result = await auditGatewayServiceConfig({
      env,
      command,
      platform: "darwin",
      expectedCommand: command,
    });
    if (kind === "malformed-args") {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "launchd-env-file-argument",
          message: expect.stringContaining("openclaw gateway install --force"),
        }),
      );
      return;
    }
    if (kind === "legacy-wrapper") {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "launchd-env-wrapper-outdated" }),
      );
      expect(result.definitionDrift).toEqual([drift("outdated", "EnvironmentWrapper")]);
      return;
    }
    expect(result.definitionDrift).toContainEqual(
      drift("unknown-edit", kind === "wrapper" ? "EnvironmentWrapper" : "Comment"),
    );
    expect(JSON.stringify(result.definitionDrift)).not.toContain("operator-private");
  },
);

it.each([
  "released-waiting",
  "released-waiting-custom",
  "script",
  "metadata",
  "inactive-launcher",
  "missing-launcher",
  "path",
])("checks generated Scheduled Task %s before a rewrite", async (kind) => {
  const releasedWaiting = kind.startsWith("released-waiting");
  const home = dirs.make("rewrite-task-preservation-");
  const env = {
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: home,
    USERNAME: "fixture",
  };
  const environment: Record<string, string> = { ...staleServiceEnvironment };
  if (releasedWaiting) {
    environment.OPENCLAW_SERVICE_VERSION = "2026.9.3";
  }
  if (kind === "path") {
    environment.PATH = "C:\\operator-private";
  }
  const command = {
    programArguments: ["node", "C:\\openclaw\\index.js", "gateway"],
    environment,
  };
  const scriptPath = resolveTaskScriptPath(env);
  const hiddenPath = resolveTaskLauncherScriptPath(
    { OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" },
    scriptPath,
  );
  const script =
    (kind === "path" ? 'set "PATH=C:\\operator-private"\r\n' : "") +
    buildTaskScript(command) +
    (kind === "script" ? "echo operator-private\r\n" : "");
  const launcher =
    (releasedWaiting
      ? `' OpenClaw Gateway (v2026.9.3)\r\nWScript.Quit CreateObject("WScript.Shell").Run("""${scriptPath.replaceAll('"', '""')}""", 0, True)\r\n`
      : buildHiddenLauncherScript({ scriptPath, taskSupervisor: true })) +
    (kind === "inactive-launcher" || kind === "released-waiting-custom"
      ? 'WScript.Echo "operator-private"\r\n'
      : "");
  await fs.writeFile(scriptPath, script);
  if (kind !== "missing-launcher") {
    await fs.writeFile(hiddenPath, launcher);
  }
  native.task.mockResolvedValue({
    code: 0,
    stderr: "",
    stdout: buildScheduledTaskXml({
      taskDescription: kind === "metadata" ? "operator-private" : "OpenClaw Gateway",
      taskUser: "fixture",
      interactive: true,
      launchPath:
        kind === "inactive-launcher" || kind === "missing-launcher" ? scriptPath : hiddenPath,
    }),
  });
  const result = await auditGatewayServiceConfig({
    env,
    command,
    platform: "win32",
    expectedCommand: {
      ...command,
      environment: { ...environment, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" },
    },
  });
  if (["released-waiting", "missing-launcher", "inactive-launcher", "script"].includes(kind)) {
    expect(result.definitionDrift).toContainEqual(
      drift("outdated", "Principals.Principal.LogonType"),
    );
    if (kind === "script") {
      expect(result.definitionDriftError).toBe(
        "Service definition inspection could not be completed.",
      );
    } else {
      expect(result.definitionDrift?.every((finding) => finding.kind === "outdated")).toBe(true);
    }
  } else {
    expect(result.definitionDrift).toContainEqual(
      drift(
        "unknown-edit",
        kind === "released-waiting-custom"
          ? "TaskLauncher"
          : kind === "path"
            ? "Environment.PATH"
            : "RegistrationInfo.Description",
      ),
    );
    expect(JSON.stringify(result.definitionDrift)).not.toContain("operator-private");
  }
  if (kind !== "script") {
    expect(result.definitionDriftError).toBeUndefined();
  }
  expect(await fs.readFile(scriptPath, "utf8")).toBe(script);
  if (kind === "missing-launcher") {
    await expect(fs.stat(hiddenPath)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    expect(await fs.readFile(hiddenPath, "utf8")).toBe(launcher);
  }
});
