import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { VERSION } from "../version.js";
import "./test-helpers/service-audit-mocks.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import {
  buildLaunchAgentEnvironmentWrapper,
  resolveLaunchAgentPlistPath,
  resolveLaunchAgentEnvWrapperPath,
} from "./launchd-service-files.js";
import { resolveGatewaySupervisorLogPaths } from "./restart-logs.js";
import {
  buildScheduledTaskXml,
  buildTaskScript,
  buildHiddenLauncherScript,
  resolveTaskScriptPath,
  resolveTaskLauncherScriptPath,
} from "./schtasks-layout.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";
import { buildSystemdUnit } from "./systemd-unit.js";
import {
  execSystemctlUserMock,
  resetServiceAuditMocks,
} from "./test-helpers/service-audit-fixtures.js";

const native = vi.hoisted(() => ({ task: vi.fn() }));
vi.mock("./schtasks-exec.js", () => ({ execSchtasks: native.task }));
vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runExec: vi.fn(async (_command: string, args: string[], options: { input: Uint8Array }) =>
    decodeLaunchAgentPlistFixture(options.input, args[1]),
  ),
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  resetServiceAuditMocks();
  native.task.mockReset();
});

const staleServiceEnvironment = {
  OPENCLAW_SERVICE_MARKER: "openclaw",
  OPENCLAW_SERVICE_KIND: "gateway",
  OPENCLAW_SERVICE_VERSION: "2026.7.1-2",
};

async function systemdFixture(
  change: (unit: string) => string,
  dropIn?: string,
  environment: Record<string, string> = {},
) {
  const home = dirs.make("definition-facts-systemd-");
  const sourcePath = path.join(home, ".config/systemd/user/openclaw-gateway.service");
  const command = {
    programArguments: ["/usr/bin/node", "/opt/openclaw/index.js", "gateway"],
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

it("keeps current policy clean with recognized heap and arbitrary environment settings", async () => {
  const fixture = await systemdFixture((unit) => unit);
  const result = await auditGatewayServiceConfig({ ...fixture, platform: "linux" });
  expect(result).toEqual({ ok: true, issues: [] });
});

it.each([
  "stale",
  "current",
  "future",
  "invalid",
  "missing-marker",
  "node",
  "ambient",
  "effective",
  "managed-base",
])("preserves custom systemd policy regardless of installation marker: %s", async (kind) => {
  const environment: Record<string, string> = { ...staleServiceEnvironment };
  if (kind === "current") {
    environment.OPENCLAW_SERVICE_VERSION = VERSION;
  } else if (kind === "future") {
    environment.OPENCLAW_SERVICE_VERSION = "9999.1.1";
  } else if (kind === "invalid") {
    environment.OPENCLAW_SERVICE_VERSION = "invalid";
  } else if (kind === "missing-marker") {
    delete environment.OPENCLAW_SERVICE_MARKER;
  } else if (kind === "node") {
    environment.OPENCLAW_SERVICE_KIND = "node";
  }
  const fixture = await systemdFixture(
    (unit) =>
      unit
        .replace("TimeoutStartSec=30", "TimeoutStartSec=45")
        .replace("TimeoutStopSec=330", "TimeoutStopSec=600"),
    undefined,
    kind === "ambient" ? {} : environment,
  );
  const command: GatewayServiceCommandConfig = fixture.command;
  if (kind === "effective" || kind === "managed-base") {
    command.managedDefinition = {
      ...command,
      environment: {
        ...command.environment,
        OPENCLAW_SERVICE_VERSION: kind === "effective" ? VERSION : "2026.7.1-2",
      },
    };
    if (kind === "managed-base") {
      command.environment = { ...command.environment, OPENCLAW_SERVICE_VERSION: VERSION };
    }
  }
  const result = await auditGatewayServiceConfig({
    ...fixture,
    command,
    env: { ...fixture.env, ...staleServiceEnvironment },
    platform: "linux",
  });
  expect(result.definitionDrift).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "preserved",
        key: "Service.TimeoutStartSec",
      }),
      expect.objectContaining({ kind: "preserved", key: "Service.TimeoutStopSec" }),
    ]),
  );
  expect(result.definitionDrift).toHaveLength(2);
});

it("reports missing systemd policy separately from unchanged legacy repair issues", async () => {
  const fixture = await systemdFixture((unit) => unit.replace("Restart=always\n", ""));
  const result = await auditGatewayServiceConfig({ ...fixture, platform: "linux" });
  expect(result.ok).toBe(true);
  expect(result.issues).toEqual([]);
  expect(result.definitionDrift).toEqual([
    {
      kind: "outdated",
      key: "Service.Restart",
      current: null,
      expected: "always",
      sourcePath: fixture.sourcePath,
      message: expect.stringContaining("Service.Restart"),
    },
  ]);
  expect(await fs.readFile(fixture.sourcePath, "utf8")).toBe(fixture.content);
});

it("reports the missing base KillMode while legacy audit retains effective manager settings", async () => {
  const fixture = await systemdFixture((unit) => unit.replace("KillMode=mixed\n", ""));
  execSystemctlUserMock.mockResolvedValue({
    code: 0,
    stderr: "",
    termination: "exit",
    stdout:
      "LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=330s\n",
  });
  const result = await auditGatewayServiceConfig({ ...fixture, platform: "linux" });
  expect(result.issues).toEqual([]);
  expect(result.definitionDrift).toContainEqual(
    expect.objectContaining({
      kind: "outdated",
      key: "Service.KillMode",
      current: null,
      expected: "mixed",
    }),
  );
});

it.each(["base", "drop-in", "drop-in-unknown", "drop-in-dependency"])(
  "reports unknown %s edits without exposing their values",
  async (kind) => {
    const fixture = await systemdFixture(
      (unit) =>
        kind === "base"
          ? unit.replace("[Service]", "[Service]\nExecStartPre=/private/operator-secret")
          : unit,
      kind === "drop-in"
        ? "[Service]\nRestart=operator-secret\n"
        : kind === "drop-in-unknown"
          ? "[Service]\nExecStartPre=operator-secret\n"
          : kind === "drop-in-dependency"
            ? "[Unit]\nAfter=network-online.target operator-secret\n"
            : undefined,
      staleServiceEnvironment,
    );
    const result = await auditGatewayServiceConfig({ ...fixture, platform: "linux" });
    expect(result.definitionDrift).toContainEqual(
      expect.objectContaining({
        kind: "unknown-edit",
        key:
          kind === "drop-in"
            ? "Service.Restart"
            : kind === "drop-in-dependency"
              ? "Unit.After"
              : "Service.ExecStartPre",
        sourcePath: expect.stringContaining(kind === "base" ? ".service" : "operator.conf"),
      }),
    );
    expect(JSON.stringify(result.definitionDrift)).not.toContain("operator-secret");
  },
);

it("reports unavailable drop-in inspection without adding a repair candidate", async () => {
  const fixture = await systemdFixture((unit) => unit);
  fixture.command.definitionPaths.push(`${fixture.sourcePath}.d/unreadable.conf`);
  const result = await auditGatewayServiceConfig({ ...fixture, platform: "linux" });
  expect(result.issues).toEqual([]);
  expect(result.definitionDriftError).toContain("inspection could not be completed");
});

it.each(["other-source", "disappeared", "reload-pending"])(
  "does not report a complete definition inspection when %s",
  async (state) => {
    const fixture = await systemdFixture((unit) => unit);
    if (state === "other-source") {
      fixture.command.sourcePath = path.join(fixture.env.HOME, "system.service");
      fixture.command.definitionPaths = [fixture.command.sourcePath];
      await fs.unlink(fixture.sourcePath);
    } else if (state === "disappeared") {
      await fs.unlink(fixture.sourcePath);
    }
    const result = await auditGatewayServiceConfig({
      ...fixture,
      command: {
        ...fixture.command,
        ...(state === "reload-pending" ? { reloadPending: true } : {}),
      },
      platform: "linux",
    });
    expect(result.definitionDrift).toBeUndefined();
    expect(result.definitionDriftError).toEqual(expect.any(String));
  },
);

it.each(["missing", "custom", "stale", "legacy-1", "legacy-60"])(
  "distinguishes missing and released launchd policy from custom policy: %s",
  async (kind) => {
    const home = dirs.make("definition-facts-launchd-");
    const env = { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") };
    const sourcePath = resolveLaunchAgentPlistPath(env);
    const command = {
      programArguments: ["/usr/bin/node", "/opt/openclaw/index.js", "gateway"],
      environment: {
        PATH: "/usr/bin:/bin",
        ...(kind !== "custom" ? staleServiceEnvironment : {}),
      },
    };
    const { stdoutPath } = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
    const legacyThrottle = kind.startsWith("legacy-") ? Number(kind.slice(7)) : undefined;
    const original = buildLaunchAgentPlist({
      ...command,
      label: "ai.openclaw.gateway",
      stdoutPath,
      stderrPath: stdoutPath,
    })
      .replace(
        /<key>ExitTimeOut<\/key>\s*<integer>20<\/integer>/u,
        kind === "missing"
          ? ""
          : `<key>ExitTimeOut</key><integer>${legacyThrottle ? 20 : 600}</integer>`,
      )
      .replace(
        /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/u,
        `<key>ThrottleInterval</key><integer>${legacyThrottle ?? 10}</integer>`,
      );
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, original);
    const result = await auditGatewayServiceConfig({
      env,
      command,
      platform: "darwin",
      expectedServicePath: "/usr/bin:/bin",
    });
    expect(result.issues).toEqual([]);
    expect(result.definitionDrift).toEqual([
      expect.objectContaining(
        kind === "custom" || kind === "stale"
          ? {
              kind: "preserved",
              key: "ExitTimeOut",
              message: expect.stringContaining("not changed"),
            }
          : {
              kind: "outdated",
              key: legacyThrottle ? "ThrottleInterval" : "ExitTimeOut",
              current: legacyThrottle ?? null,
              expected: legacyThrottle ? 10 : 20,
            },
      ),
    ]);
    if (kind === "custom" || kind === "stale") {
      expect(JSON.stringify(result.definitionDrift)).not.toContain("600");
    }
    expect(await fs.readFile(sourcePath, "utf8")).toBe(original);
  },
);

it.each([
  { count: "0", stale: false },
  { count: "9", stale: false },
  { count: undefined, stale: false },
  { count: "9", stale: true },
])(
  "reports Scheduled Task retry policy without triggering repair: count=$count stale=$stale",
  async ({ count, stale }) => {
    const home = dirs.make("definition-facts-task-");
    const env = { USERPROFILE: home, OPENCLAW_STATE_DIR: home, USERNAME: "fixture" };
    const command = {
      programArguments: ["node", "C:\\openclaw\\index.js", "gateway"],
      ...(stale ? { environment: staleServiceEnvironment } : {}),
    };
    const xml = buildScheduledTaskXml({
      taskDescription: "fixture",
      taskUser: "fixture",
      launchPath: resolveTaskScriptPath(env),
    }).replace("<Count>3</Count>", count === undefined ? "" : `<Count>${count}</Count>`);
    native.task.mockResolvedValue({ code: 0, stdout: xml, stderr: "" });
    const result = await auditGatewayServiceConfig({ env, command, platform: "win32" });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.definitionDrift).toEqual([
      expect.objectContaining(
        count !== "9"
          ? {
              kind: "outdated",
              key: "Settings.RestartOnFailure.Count",
              current: count ?? null,
              expected: "3",
            }
          : {
              kind: "preserved",
              key: "Settings.RestartOnFailure.Count",
              message: expect.stringContaining("not changed"),
            },
      ),
    ]);
    expect(native.task).toHaveBeenCalledExactlyOnceWith([
      "/Query",
      "/TN",
      "OpenClaw Gateway",
      "/XML",
    ]);
  },
);

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

const discardedSettings: Array<{
  key: string;
  native: string[];
  gateway: string[];
  cwd?: string;
  environment: Record<string, string>;
}> = [
  { key: "ProgramArguments", native: ["--inspect=operator-private"], gateway: [], environment: {} },
  { key: "ProgramArguments", native: [], gateway: ["--verbose"], environment: {} },
  { key: "WorkingDirectory", native: [], gateway: [], cwd: "/operator-private", environment: {} },
  {
    key: "Environment.OPENCLAW_CUSTOM",
    native: [],
    gateway: [],
    environment: { OPENCLAW_CUSTOM: "operator-private" },
  },
  {
    key: "Environment.PATH",
    native: [],
    gateway: [],
    environment: { PATH: "/usr/bin:/operator-private" },
  },
  {
    key: "Environment.NODE_OPTIONS",
    native: [],
    gateway: [],
    environment: { NODE_OPTIONS: "--max-old-space-size=4096 --require=/operator-private" },
  },
];

it.each(discardedSettings)(
  "blocks a rewrite plan that discards $key without exposing values",
  async ({ key, native: nativeArguments, gateway, cwd, environment }) => {
    const fixture = await systemdFixture((unit) => unit);
    const command = {
      ...fixture.command,
      programArguments: [
        "/usr/bin/node",
        ...nativeArguments,
        "/old/index.js",
        "gateway",
        ...gateway,
      ],
      workingDirectory: cwd,
      environment: { ...fixture.command.environment, ...environment },
    };
    const before = await auditGatewayServiceConfig({ ...fixture, command, platform: "linux" });
    expect(before.definitionDrift).toBeUndefined();
    const result = await auditGatewayServiceConfig({
      ...fixture,
      command,
      platform: "linux",
      expectedCommand: fixture.command,
    });
    expect(result.definitionDrift).toContainEqual(
      expect.objectContaining({ kind: "unknown-edit", key }),
    );
    expect(JSON.stringify(result.definitionDrift)).not.toContain("operator-private");
    expect(await fs.readFile(fixture.sourcePath, "utf8")).toBe(fixture.content);
  },
);

it("accepts retained heap aliases, custom environment and owned environment regeneration", async () => {
  const fixture = await systemdFixture((unit) => unit);
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
    platform: "linux",
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

it.each(["OpenClaw Gateway (v2026.9.4)", "operator-private"])(
  "classifies systemd description before a rewrite: %s",
  async (description) => {
    const fixture = await systemdFixture((unit) =>
      unit.replace("Description=OpenClaw Gateway", `Description=${description}`),
    );
    const result = await auditGatewayServiceConfig({
      ...fixture,
      platform: "linux",
      expectedCommand: fixture.command,
    });
    if (description === "operator-private") {
      expect(result.definitionDrift).toContainEqual(
        expect.objectContaining({ kind: "unknown-edit", key: "Unit.Description" }),
      );
      expect(JSON.stringify(result.definitionDrift)).not.toContain(description);
    } else {
      expect(result.definitionDrift).toBeUndefined();
    }
  },
);

it.each(["canonical-wrapper", "legacy-wrapper", "malformed-args", "wrapper", "metadata"])(
  "audits launchd %s before the installer can replace it",
  async (kind) => {
    const home = dirs.make("rewrite-launchd-preservation-");
    const env = { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") };
    const sourcePath = resolveLaunchAgentPlistPath(env);
    const command = {
      programArguments: ["/usr/bin/node", "/opt/openclaw/index.js", "gateway"],
      environment: { PATH: "/usr/bin:/bin", ...staleServiceEnvironment },
    };
    const { stdoutPath } = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      buildLaunchAgentPlist({
        ...command,
        ...(kind === "malformed-args"
          ? {
              programArguments: [
                "/bin/sh",
                resolveLaunchAgentEnvWrapperPath(env, "ai.openclaw.gateway"),
                command.programArguments[0]!,
                ...command.programArguments,
              ],
            }
          : {}),
        label: "ai.openclaw.gateway",
        comment: kind === "metadata" ? "operator-private" : "OpenClaw Gateway",
        stdoutPath,
        stderrPath: stdoutPath,
      }),
    );
    if (kind !== "metadata") {
      const wrapperPath = resolveLaunchAgentEnvWrapperPath(env, "ai.openclaw.gateway");
      await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
      await fs.writeFile(
        wrapperPath,
        kind === "canonical-wrapper" || kind === "malformed-args"
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
    if (kind === "canonical-wrapper") {
      expect(result.definitionDrift ?? []).toEqual([]);
      return;
    }
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
      expect(result.definitionDrift).toEqual([
        expect.objectContaining({ kind: "outdated", key: "EnvironmentWrapper" }),
      ]);
      return;
    }
    expect(result.definitionDrift).toContainEqual(
      expect.objectContaining({
        kind: "unknown-edit",
        key: kind === "wrapper" ? "EnvironmentWrapper" : "Comment",
      }),
    );
    expect(JSON.stringify(result.definitionDrift)).not.toContain("operator-private");
  },
);

it.each([
  "canonical",
  "legacy",
  "literal",
  "reenabled-expansion",
  "script",
  "launcher",
  "metadata",
  "planned-launcher",
  "missing-launcher",
  "path",
  "custom-script",
  "native-defaults",
])("checks generated Scheduled Task %s before a rewrite", async (kind) => {
  const home = dirs.make("rewrite-task-preservation-");
  const env = {
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: home,
    USERNAME: "fixture",
    ...(kind === "custom-script" ? { OPENCLAW_TASK_SCRIPT_NAME: "gateway.bat" } : {}),
  };
  const environment: Record<string, string> =
    kind === "legacy" ? { OPENCLAW_SERVICE_KIND: "gateway" } : { ...staleServiceEnvironment };
  if (kind === "path") {
    environment.PATH = "C:\\operator-private";
  }
  if (kind === "literal") {
    environment.OPENCLAW_TEST_LITERAL = "réseau %% ^!";
  }
  const command = {
    programArguments: ["node", "C:\\openclaw\\index.js", "gateway"],
    environment,
    ...(kind === "literal" ? { workingDirectory: "C:\\réseau %% ^!" } : {}),
  };
  const scriptPath = resolveTaskScriptPath(env);
  const hiddenPath = resolveTaskLauncherScriptPath(
    { OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" },
    scriptPath,
  );
  const script =
    kind === "legacy"
      ? '@echo off\r\nset "OPENCLAW_SERVICE_KIND=gateway"\r\nnode C:\\openclaw\\index.js gateway --task-supervisor < NUL\r\n'
      : (kind === "path" ? 'set "PATH=C:\\operator-private"\r\n' : "") +
        (kind === "reenabled-expansion"
          ? buildTaskScript(command).replace("DisableDelayedExpansion", "EnableDelayedExpansion")
          : buildTaskScript(command)) +
        (kind === "script" ? "echo operator-private\r\n" : "");
  const launcher =
    buildHiddenLauncherScript({ scriptPath, taskSupervisor: true }) +
    (kind === "launcher" || kind === "planned-launcher"
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
      launchPath:
        kind === "planned-launcher" || kind === "missing-launcher" ? scriptPath : hiddenPath,
    })
      .replace(
        "<RunLevel>LeastPrivilege</RunLevel>",
        kind === "native-defaults" ? "" : "<RunLevel>LeastPrivilege</RunLevel>",
      )
      .replace(
        "<Count>3</Count>",
        kind === "native-defaults" ? "<Count>0</Count>" : "<Count>3</Count>",
      )
      .replace(
        "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        `<ExecutionTimeLimit>${kind === "native-defaults" ? "PT72H" : "PT0S"}</ExecutionTimeLimit>`,
      )
      .replace(
        "<StopOnIdleEnd>false</StopOnIdleEnd>",
        `<StopOnIdleEnd>${kind === "native-defaults" ? "true" : "false"}</StopOnIdleEnd>`,
      ),
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
  if (
    kind === "canonical" ||
    kind === "legacy" ||
    kind === "literal" ||
    kind === "missing-launcher" ||
    kind === "custom-script"
  ) {
    expect(result.definitionDrift).toBeUndefined();
  } else if (kind === "native-defaults") {
    expect(result.definitionDrift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "outdated",
          key: "Settings.ExecutionTimeLimit",
          current: "PT72H",
          expected: "PT0S",
        }),
        expect.objectContaining({
          kind: "outdated",
          key: "Settings.IdleSettings.StopOnIdleEnd",
          current: "true",
          expected: "false",
        }),
        expect.objectContaining({
          kind: "outdated",
          key: "Settings.RestartOnFailure.Count",
          current: "0",
          expected: "3",
        }),
      ]),
    );
    expect(result.definitionDrift).toHaveLength(3);
  } else {
    expect(result.definitionDrift).toContainEqual(
      expect.objectContaining({
        kind: "unknown-edit",
        key:
          kind === "script" || kind === "reenabled-expansion"
            ? "TaskScript"
            : kind === "launcher" || kind === "planned-launcher"
              ? "TaskLauncher"
              : kind === "path"
                ? "Environment.PATH"
                : "RegistrationInfo.Description",
      }),
    );
    expect(JSON.stringify(result.definitionDrift)).not.toContain("operator-private");
  }
  expect(result.definitionDriftError).toBeUndefined();
  expect(await fs.readFile(scriptPath, "utf8")).toBe(script);
  if (kind === "missing-launcher") {
    await expect(fs.stat(hiddenPath)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    expect(await fs.readFile(hiddenPath, "utf8")).toBe(launcher);
  }
});
