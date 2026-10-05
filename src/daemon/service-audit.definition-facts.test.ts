import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { VERSION } from "../version.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import "./test-helpers/service-audit-mocks.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import {
  buildLaunchAgentEnvironmentWrapper,
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

it.each([false, true])("preserves custom systemd policy (managed base=%s)", async (managedBase) => {
  const fixture = await systemdFixture(
    (unit) =>
      unit
        .replace("TimeoutStartSec=30", "TimeoutStartSec=45")
        .replace("TimeoutStopSec=330", "TimeoutStopSec=600"),
    undefined,
    staleServiceEnvironment,
  );
  const command: GatewayServiceCommandConfig = fixture.command;
  if (managedBase) {
    command.managedDefinition = { ...command };
    command.environment = { ...command.environment, OPENCLAW_SERVICE_VERSION: VERSION };
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

it.each([
  { key: undefined, expected: undefined },
  { key: "Restart", expected: "always" },
  { key: "KillMode", expected: "mixed" },
])("audits missing $key separately from effective manager policy", async ({ key, expected }) => {
  const fixture = await systemdFixture((unit) =>
    key ? unit.replace(`${key}=${expected}\n`, "") : unit,
  );
  if (key === "KillMode") {
    execSystemctlUserMock.mockResolvedValue({
      code: 0,
      stderr: "",
      termination: "exit",
      stdout:
        "LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=330s\n",
    });
  }
  const result = await auditGatewayServiceConfig({ ...fixture, platform: "linux" });
  if (key === undefined) {
    expect(result).toEqual({ ok: true, issues: [] });
  } else {
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.definitionDrift).toEqual([
      {
        kind: "outdated",
        key: `Service.${key}`,
        current: null,
        expected,
        sourcePath: fixture.sourcePath,
        message: expect.stringContaining(`Service.${key}`),
      },
    ]);
  }
  expect(await fs.readFile(fixture.sourcePath, "utf8")).toBe(fixture.content);
});

it.each([
  "base",
  "drop-in",
  "drop-in-unknown",
  "drop-in-dependency",
  "description",
  "versioned-description",
])("reports unknown %s edits without exposing their values", async (kind) => {
  const description = kind === "description" || kind === "versioned-description";
  const fixture = await systemdFixture(
    (unit) =>
      description
        ? unit.replace(
            "Description=OpenClaw Gateway",
            `Description=${kind === "description" ? "operator-secret" : "OpenClaw Gateway (v2026.9.4)"}`,
          )
        : kind === "base"
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
  const result = await auditGatewayServiceConfig({
    ...fixture,
    platform: "linux",
    ...(description ? { expectedCommand: fixture.command } : {}),
  });
  if (kind === "versioned-description") {
    expect(result.definitionDrift).toBeUndefined();
    return;
  }
  expect(result.definitionDrift).toContainEqual(
    expect.objectContaining({
      kind: "unknown-edit",
      key: description
        ? "Unit.Description"
        : kind === "drop-in"
          ? "Service.Restart"
          : kind === "drop-in-dependency"
            ? "Unit.After"
            : "Service.ExecStartPre",
      sourcePath: expect.stringContaining(
        kind === "base" || description ? ".service" : "operator.conf",
      ),
    }),
  );
  expect(JSON.stringify(result.definitionDrift)).not.toContain("operator-secret");
});

it.each(["other-source", "disappeared", "reload-pending", "unreadable-drop-in"])(
  "does not report a complete definition inspection when %s",
  async (state) => {
    const fixture = await systemdFixture((unit) => unit);
    if (state === "unreadable-drop-in") {
      fixture.command.definitionPaths.push(`${fixture.sourcePath}.d/unreadable.conf`);
    } else if (state === "other-source") {
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
    if (state === "unreadable-drop-in") {
      expect(result.issues).toEqual([]);
      expect(result.definitionDriftError).toContain("inspection could not be completed");
    }
  },
);

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
    const home = dirs.make("definition-facts-launchd-");
    const env = { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") };
    const sourcePath = resolveLaunchAgentPlistPath(env);
    const command = {
      programArguments: [
        "/usr/bin/node",
        "/opt/openclaw/index.js",
        "gateway",
        ...(customized === "ProgramArguments" ? ["--verbose"] : []),
      ],
      environment: { PATH: "/usr/bin:/bin", ...(stale ? staleServiceEnvironment : {}) },
    };
    const { stdoutPath } = resolveGatewaySupervisorLogPaths(env);
    const original = buildLaunchAgentPlist({
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
      label: "ai.openclaw.gateway",
      comment: customized === "Comment" ? "Operator service" : "OpenClaw Gateway",
      stdoutPath,
      stderrPath: stdoutPath,
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
      ...(kind
        ? [
            expect.objectContaining(
              kind === "preserved"
                ? { kind, key: "ExitTimeOut", message: expect.stringContaining("not changed") }
                : { kind, key: "ExitTimeOut", current: seconds ?? null, expected: 330 },
            ),
          ]
        : []),
      ...(throttle
        ? [
            expect.objectContaining({
              kind: throttle === 45 ? "preserved" : "outdated",
              key: "ThrottleInterval",
              ...(throttle === 45 ? {} : { current: throttle, expected: 10 }),
            }),
          ]
        : []),
      ...(customized === "ProcessType"
        ? [expect.objectContaining({ kind: "preserved", key: "ProcessType" })]
        : []),
      ...(customized === "UnknownKey"
        ? [expect.objectContaining({ kind: "unknown-edit", key: "LowPriorityIO" })]
        : []),
    ];
    expect(result.definitionDrift ?? []).toEqual(expect.arrayContaining(expectedDrift));
    expect(result.definitionDrift ?? []).toHaveLength(expectedDrift.length);
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

it.each(["edited-file", "edited-inline", "canonical"])(
  "preserves operator PATH edits while admitting canonical Darwin defaults: %s",
  (kind) => {
    const home = "/home/fixture";
    const canonical = `${home}/.n/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
    const edited = kind.startsWith("edited");
    const command: GatewayServiceCommandConfig = {
      programArguments: [`${home}/.n/bin/node`, "/opt/openclaw/index.js", "gateway"],
      environment: {
        HOME: home,
        PATH: `${canonical}${edited ? ":/operator-private" : ""}`,
      },
      environmentValueSources: { PATH: kind === "edited-inline" ? "inline" : "file" },
    };
    const findings: ServiceDefinitionDrift[] = [];
    auditGatewayInstallPreservation(
      command,
      { ...command, environment: { HOME: home, PATH: canonical } },
      "darwin",
      findings,
    );
    expect(findings).toEqual(
      edited ? [expect.objectContaining({ kind: "unknown-edit", key: "Environment.PATH" })] : [],
    );
  },
);

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
  {
    key: "Environment.OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS",
    native: [],
    gateway: [],
    environment: { OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS: "30000" },
  },
];

it.each(discardedSettings)(
  "blocks a rewrite plan that discards $key with a safe environment diff",
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
    if (key === "Environment.PATH") {
      expect(result.definitionDrift?.[0]?.message).toContain(
        'Current: "/usr/bin:/operator-private"; installer: "/usr/bin:/bin"',
      );
    } else if (key === "Environment.OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS") {
      expect(result.definitionDrift?.[0]?.message).toContain(
        'Current: "30000"; installer: <absent>',
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

it("bounds environment diffs and redacts nonnumeric timeout values", () => {
  const command = {
    programArguments: ["/usr/bin/node", "/opt/openclaw/index.js", "gateway"],
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

it.each([false, true])(
  "reports a missing managed value unless a drop-in supplies it: %s",
  async (dropIn) => {
    const key = "OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS";
    const fixture = await systemdFixture((unit) => unit);
    const managedDefinition = {
      ...fixture.command,
      environment: { ...fixture.command.environment, OPENCLAW_SERVICE_MANAGED_ENV_KEYS: key },
    };
    const result = await auditGatewayServiceConfig({
      ...fixture,
      command: {
        ...managedDefinition,
        managedDefinition,
        environment: { ...managedDefinition.environment, ...(dropIn ? { [key]: "30000" } : {}) },
      },
      expectedCommand: {
        ...managedDefinition,
        environment: { ...managedDefinition.environment, [key]: "30000" },
      },
      platform: "linux",
    });
    expect(result.definitionDrift).toEqual(
      dropIn
        ? undefined
        : [
            expect.objectContaining({
              kind: "outdated",
              key: `Environment.${key}`,
              message: expect.stringContaining('Current: <absent>; installer: "30000"'),
            }),
          ],
    );
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
    const { stdoutPath } = resolveGatewaySupervisorLogPaths(env);
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
  "released-waiting",
  "released-waiting-custom",
  "script",
  "launcher",
  "metadata",
  "planned-launcher",
  "missing-launcher",
  "path",
  "custom-script",
  "native-defaults",
])("checks generated Scheduled Task %s before a rewrite", async (kind) => {
  const releasedWaiting = kind.startsWith("released-waiting");
  const home = dirs.make("rewrite-task-preservation-");
  const env = {
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: home,
    USERNAME: "fixture",
    ...(kind === "custom-script" ? { OPENCLAW_TASK_SCRIPT_NAME: "gateway.bat" } : {}),
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
    (kind === "launcher" || kind === "planned-launcher" || kind === "released-waiting-custom"
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
    kind === "released-waiting" ||
    kind === "missing-launcher" ||
    kind === "custom-script"
  ) {
    expect(result.definitionDrift).toBeUndefined();
  } else if (kind === "script") {
    expect(result.definitionDrift).toBeUndefined();
    expect(result.definitionDriftError).toBe(
      "Service definition inspection could not be completed.",
    );
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
          kind === "launcher" || kind === "planned-launcher" || kind === "released-waiting-custom"
            ? "TaskLauncher"
            : kind === "path"
              ? "Environment.PATH"
              : "RegistrationInfo.Description",
      }),
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
