import "../../test-utils/prepare-compiled-subprocesses.js";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { getMockCallOutput } from "../test-runtime-capture.js";
import type { DaemonStatus } from "./status.gather.js";

const SYNTHETIC_TOKEN = "synthetic-status-install-hint-token";
const LOG_FILENAME = "status-install-hints.log";
const homes = createSuiteTempRootTracker({ prefix: "openclaw-status-install-hints-" });
const surfaces = (
  [
    ["missing-unit", "Service unit not found", "openclaw --profile work gateway install"],
    ["config-mismatch", "CLI and service are using different config paths"],
    ["cached-label", "LaunchAgent label cached but plist missing", "openclaw gateway install"],
    ["config-audit", "embeds OPENCLAW_GATEWAY_TOKEN"],
    ["version-mismatch", "Gateway service version: 2026.4.15"],
  ] as const
).map(([kind, fact, command = "openclaw gateway install --force"]) => ({ kind, fact, command }));
type StatusSurface = (typeof surfaces)[number]["kind"];
type InvocationEnvironment = (accountHome: string) => NodeJS.ProcessEnv;
const deniedInvocations = [
  [
    "Nix-managed installation",
    () => ({ OPENCLAW_NIX_MODE: "1", OPENCLAW_SUPERVISOR_MODE: "external" }),
    [/Nix mode detected/, /managed by an external supervisor/, /service install is disabled/],
    [0, 3, 4],
  ],
  [
    "global external supervision",
    () => ({ OPENCLAW_SUPERVISOR_MODE: " EXTERNAL " }),
    [/managed by an external supervisor/, /Nix mode detected/, /Use that supervisor to/],
    [1],
  ],
  [
    "relocated invoking HOME",
    (accountHome: string) => ({ HOME: path.join(accountHome, "relocated") }),
    [
      /non-default state dir or config path/,
      /Nix mode detected/,
      /HOME set to the OS account home/,
    ],
    [2],
  ],
] as const;
async function statusFixture(
  surface?: StatusSurface,
  overrides: InvocationEnvironment = () => ({}),
) {
  const accountHome = await homes.setup();
  // Relocating the invoking HOME must not relocate the OS account's home.
  vi.spyOn(os, "homedir").mockReturnValue(accountHome);
  vi.spyOn(os, "userInfo").mockImplementation(() => ({
    uid: 1000,
    gid: 1000,
    username: "status-fixture",
    homedir: accountHome,
    shell: "/bin/sh",
  }));
  const stateDir = path.join(accountHome, ".openclaw");
  for (const [key, value] of Object.entries({
    HOME: accountHome,
    USERPROFILE: accountHome,
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_NIX_MODE: undefined,
    OPENCLAW_SUPERVISOR_MODE: undefined,
    OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
    OPENCLAW_LAUNCHD_LABEL: undefined,
    OPENCLAW_SYSTEMD_UNIT: undefined,
    OPENCLAW_WINDOWS_TASK_NAME: undefined,
    OPENCLAW_CONTAINER: undefined,
    OPENCLAW_CONTAINER_HINT: undefined,
    OPENCLAW_LOG_PREFIX: undefined,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    ...overrides(accountHome),
  })) {
    vi.stubEnv(key, value);
  }
  const { printDaemonStatus } = await import("./status.print.js");
  const status: DaemonStatus = {
    service: {
      label: "LaunchAgent",
      loaded: true,
      loadState: { status: "loaded" },
      loadedText: "loaded",
      notLoadedText: "not loaded",
      runtime: { status: "running", pid: 4242 },
    },
    logFile: path.join(accountHome, LOG_FILENAME),
    extraServices: [],
  };
  if (surface === "missing-unit") {
    status.service.loaded = false;
    status.service.loadState = { status: "not-loaded" };
    status.service.runtime = { status: "stopped", missingUnit: true };
  } else if (surface === "config-mismatch") {
    const serviceStateDir = path.join(accountHome, "service-state");
    const serviceConfigPath = path.join(serviceStateDir, "openclaw.json");
    const validConfig = (file: string) => ({ path: file, exists: true, valid: true });
    status.config = {
      cli: validConfig(path.join(accountHome, ".openclaw", "openclaw.json")),
      daemon: validConfig(serviceConfigPath),
      mismatch: true,
    };
    status.service.command = {
      programArguments: ["openclaw", "gateway"],
      environment: {
        HOME: accountHome,
        OPENCLAW_STATE_DIR: serviceStateDir,
        OPENCLAW_CONFIG_PATH: serviceConfigPath,
      },
    };
  } else if (surface === "cached-label") {
    status.service.runtime = { status: "running", pid: 4242, cachedLabel: true };
  } else if (surface === "version-mismatch") {
    status.cli = { version: "2026.6.35", entrypoint: path.join(accountHome, "bin/openclaw") };
    status.service.targetRole = "target";
    status.service.layout = {
      execStart: "/usr/bin/node /service-install/dist/index.js gateway",
      packageRoot: path.join(accountHome, "service-install"),
      packageVersion: "2026.4.15",
    };
    status.rpc = { ok: false, error: "protocol mismatch" };
  } else if (surface === "config-audit") {
    const { auditGatewayServiceConfig } = await import("../../daemon/service-audit.js");
    const command = {
      programArguments: ["openclaw", "gateway"],
      environment: { OPENCLAW_GATEWAY_TOKEN: SYNTHETIC_TOKEN },
    };
    status.service.command = command;
    // Windows reaches the token audit without native unit/plist/runtime probes.
    status.service.configAudit = await auditGatewayServiceConfig({
      platform: "win32",
      command,
      env: { HOME: accountHome },
    });
  }
  return {
    status,
    print: () => {
      printDaemonStatus(status, { json: false });
      return humanOutput();
    },
  };
}

function humanOutput(): string {
  return stripVTControlCharacters(
    [defaultRuntime.log, defaultRuntime.error]
      .map((fn) => getMockCallOutput(vi.mocked(fn)))
      .join("\n"),
  );
}
function expectProblemAndLogs(output: string, fact: string): void {
  expect(output).toContain(fact);
  expect(output).toContain("File logs:");
  expect(output).toContain(LOG_FILENAME);
  expect(output).not.toContain(SYNTHETIC_TOKEN);
}

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  for (const method of ["log", "error", "writeJson"] as const) {
    vi.spyOn(defaultRuntime, method).mockImplementation(() => {});
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await homes.cleanup();
});

it.each(
  deniedInvocations.flatMap(([name, environment, messages, indices]) =>
    indices.map((index) => [name, environment, messages, surfaces[index]] as const),
  ),
)(
  "retains facts without unusable native advice under %s (case %#)",
  async (_name, environment, [reason, absent, recovery], { kind, fact }) => {
    const { print } = await statusFixture(kind, environment);
    const output = print();
    expectProblemAndLogs(output, fact);
    expect(output).toMatch(reason);
    expect(output).toMatch(recovery);
    expect(output).not.toMatch(absent);
    expect(output).not.toMatch(
      /\bgateway\s+install\b|\bdoctor\s+--(?:repair|fix)\b|launchctl bootout/,
    );
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  },
);

it("reports incomplete definition inspection without recommending a reinstall", async () => {
  const { status, print } = await statusFixture();
  const diagnostic = "Backup inspection failed; check /fixture/gateway.service.bak.";
  delete status.logFile;
  status.service = {
    ...status.service,
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    configAudit: { ok: true, issues: [], definitionDriftError: diagnostic },
  };
  const output = print();
  expect(output).toContain(`Service definition inspection incomplete: ${diagnostic}`);
  expect(output).not.toContain("Service config looks out of date or non-standard.");
  expect(output).not.toMatch(/\bgateway\s+install\b/);
});

it("directs version-manager runtime findings to Doctor before reinstall", async () => {
  const { status, print } = await statusFixture("config-audit");
  const finding = {
    code: "gateway-runtime-node-version-manager",
    message: "Gateway service uses Node from a version manager; it can break after upgrades.",
    level: "recommended",
  } as const;
  status.service.configAudit = { ok: false, issues: [finding] };
  const output = print();
  expect(output).toContain("openclaw doctor");
  expect(output).toContain("Reinstalling alone may select the same runtime");
  expect(output).not.toContain("openclaw gateway install --force");
});

it("keeps remote service-install facts diagnostic-only even when installation is blocked", async () => {
  const { status, print } = await statusFixture("version-mismatch", () => ({
    OPENCLAW_NIX_MODE: "1",
  }));
  status.service.targetRole = "diagnostic-only";
  status.rpc = { ok: false, url: "wss://remote.example:19443", error: "protocol mismatch" };
  const output = print();
  expect(output).toContain("CLI version: 2026.6.35");
  expect(output).toContain("Gateway service version: 2026.4.15");
  expect(output).toContain("service-install");
  expect(output).toContain("The Gateway did not report its own version");
  expect(output).not.toMatch(/\breinstall\b/i);
  expect(output).not.toMatch(/\bgateway\s+install\b|\bdoctor\s+--fix\b/);
  expect(output).not.toContain("Nix mode detected");
});

it("gateway status keeps a missing diagnostic-only unit informational when its probe fails", async () => {
  const { status } = await statusFixture("missing-unit", (accountHome) => ({
    OPENCLAW_HOME: path.join(accountHome, "external"),
  }));
  const connectionError = "connect ECONNREFUSED";
  const unitInfo = "Native service is not installed; diagnostic only, not the check target.";
  status.service.targetRole = "diagnostic-only";
  status.rpc = { ok: false, error: connectionError };
  const gather = await import("./status.gather.js");
  vi.spyOn(gather, "gatherDaemonStatus").mockResolvedValue(status);
  const { runDaemonStatus } = await import("./status.js");
  await runDaemonStatus({ rpc: {}, probe: true, requireRpc: false, json: false });
  const output = humanOutput();
  expect(output).toContain("Connectivity check: failed");
  expect(defaultRuntime.log).toHaveBeenCalledWith(expect.stringContaining(unitInfo));
  expect(output).not.toContain("Service unit not found");
  expect(output).not.toContain("Gateway install blocked:");
  expect(output).not.toMatch(/\bgateway\s+install\b/);
  expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(connectionError));
});

it.each(surfaces)(
  "keeps the canonical default installation's $kind advice",
  async ({ kind, fact, command }) => {
    const { status, print } = await statusFixture(kind, (accountHome) =>
      kind === "missing-unit"
        ? {
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: path.join(accountHome, ".openclaw-work"),
            OPENCLAW_CONFIG_PATH: path.join(accountHome, ".openclaw-work", "openclaw.json"),
            OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.work",
          }
        : kind === "config-audit"
          ? { OPENCLAW_SERVICE_REPAIR_POLICY: "external" }
          : {},
    );
    if (kind === "cached-label") {
      status.service.targetRole = "diagnostic-only";
    }
    const output = print();
    expectProblemAndLogs(output, fact);
    expect(output).toContain(command);
    expect(output).not.toContain("service management skipped");
    expect(output).not.toContain("managed by an external supervisor");
    if (kind === "version-mismatch") {
      expect(output).toContain("service-install");
      expect(output).toContain("The Gateway did not report its own version");
    }
    if (kind === "cached-label") {
      expect(output).toContain("launchctl bootout gui/$UID/ai.openclaw.gateway");
    }
  },
);
