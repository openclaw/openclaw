import * as fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openUrl } from "../infra/browser-open.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  formatControlUiSshHint,
  handleReset,
  normalizeGatewayTokenInput,
  probeGatewayConfiguredModel,
  probeGatewayReachable,
  resolveAdvertisedControlUiLinks,
  resolveControlUiLinks,
  resolveLocalControlUiProbeLinks,
  summarizeExistingConfig,
  validateGatewayPasswordInput,
  waitForGatewayReachable,
} from "./onboard-helpers.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const localProbe = { url: "ws://127.0.0.1:18789" };
const remoteUrl = "wss://gateway.example.com:18789";
const probeAuth = { token: undefined, password: undefined };

const mocks = vi.hoisted(() => ({
  removeAgentSessions: vi.fn(async () => {}),
  movePathToTrash: vi.fn(async (targetPath: string) => `${targetPath}.trashed`),
  runCommandWithTimeout: vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>(
    async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    }),
  ),
  pickPrimaryTailnetIPv4: vi.fn<() => string | undefined>(() => undefined),
  resolveAdvertisedLanHostCore: vi.fn<() => Promise<string | null>>(async () => null),
  probeGateway: vi.fn(),
  deleteWorkspaceState: vi.fn(),
  prepareWorkspaceStateDeletion: vi.fn((workspaceDir: string) => ({ workspaceDir })),
  prepareLegacyWorkspaceStateReset: vi.fn(() => ({ candidates: [] })),
  removeLegacyWorkspaceStateForReset: vi.fn(
    async (): Promise<{ removedPaths: string[]; warnings: string[] }> => ({
      removedPaths: [],
      warnings: [],
    }),
  ),
}));

vi.mock("./cleanup-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cleanup-utils.js")>()),
  removeAgentSessions: mocks.removeAgentSessions,
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
  movePathToTrash: mocks.movePathToTrash,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
}));

vi.mock("../infra/advertised-lan-host.js", () => ({
  resolveAdvertisedLanHostCore: mocks.resolveAdvertisedLanHostCore,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

vi.mock("../agents/workspace-state-store.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/workspace-state-store.js")>(
    "../agents/workspace-state-store.js",
  )),
  deleteWorkspaceState: mocks.deleteWorkspaceState,
  prepareWorkspaceStateDeletion: mocks.prepareWorkspaceStateDeletion,
}));

vi.mock("../agents/workspace-legacy-state.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/workspace-legacy-state.js")>(
    "../agents/workspace-legacy-state.js",
  )),
  prepareLegacyWorkspaceStateReset: mocks.prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset: mocks.removeLegacyWorkspaceStateForReset,
}));

afterEach(() => {
  mocks.probeGateway.mockReset();
  mocks.removeAgentSessions.mockReset().mockResolvedValue(undefined);
  vi.clearAllMocks();
  mocks.movePathToTrash.mockReset();
  mocks.movePathToTrash.mockImplementation(async (targetPath: string) => `${targetPath}.trashed`);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function expectedTrashSourcePath(targetPath: string): string {
  return path.join(fs.realpathSync(path.dirname(targetPath)), path.basename(targetPath));
}

function resetFixture(profile?: string) {
  const homeDir = tempDirs.make("openclaw-reset-");
  const stateDir = path.join(homeDir, profile ? `.openclaw-${profile}` : ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const workspaceDir = path.join(stateDir, "workspace");
  const credentialsDir = path.join(stateDir, "credentials");
  fs.mkdirSync(workspaceDir, { recursive: true });
  if (profile) {
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n");
  }
  const runtime = createThrowingTestRuntime();
  const run = (scope: Parameters<typeof handleReset>[0] = "full", workspace = workspaceDir) =>
    withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_HOME: homeDir,
        OPENCLAW_PROFILE: profile,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      () => handleReset(scope, workspace, runtime),
    );
  return { homeDir, stateDir, configPath, workspaceDir, credentialsDir, runtime, run };
}

describe("handleReset", () => {
  it("rejects full-reset workspaces that contain the active onboarding lock", async () => {
    const { homeDir, stateDir, configPath, run } = resetFixture();
    const migrationDir = path.join(stateDir, "migration");
    const migrationAlias = path.join(homeDir, "migration-alias");
    const lockSidecar = path.join(migrationDir, "onboarding.lock-target.lock");
    const lockSidecarViaAlias = path.join(migrationAlias, "onboarding.lock-target.lock");
    fs.mkdirSync(migrationDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n");
    fs.symlinkSync(migrationDir, migrationAlias, process.platform === "win32" ? "junction" : "dir");

    for (const workspaceDir of [
      homeDir,
      stateDir,
      migrationDir,
      migrationAlias,
      lockSidecar,
      lockSidecarViaAlias,
    ]) {
      await expect(run("full", workspaceDir)).rejects.toThrow(
        "overlaps the active onboarding lock directory",
      );
    }

    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
  });

  it("uses active profile paths for destructive reset targets", async () => {
    const { homeDir, stateDir, configPath, credentialsDir, workspaceDir, run } =
      resetFixture("work");
    const defaultCredentialsDir = path.join(homeDir, ".openclaw", "credentials");
    for (const agent of ["main", "ops"]) {
      fs.mkdirSync(path.join(stateDir, "agents", agent, "sessions"), { recursive: true });
    }
    fs.mkdirSync(defaultCredentialsDir, { recursive: true });
    const expectedTrashedPaths = [configPath, credentialsDir, workspaceDir].map(
      expectedTrashSourcePath,
    );
    const expectedDefaultCredentialsDir = expectedTrashSourcePath(defaultCredentialsDir);

    await run();

    const trashedPaths = mocks.movePathToTrash.mock.calls.map(([targetPath]) => targetPath);
    expect(trashedPaths).toEqual(expectedTrashedPaths);
    expect(trashedPaths).not.toContain(expectedDefaultCredentialsDir);
    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
  });

  it("rejects a config-only reset when the existing config cannot be trashed", async () => {
    const { configPath, runtime, run } = resetFixture();
    fs.writeFileSync(configPath, "{}\n");
    mocks.movePathToTrash.mockRejectedValueOnce(new Error("trash unavailable"));
    await expect(run("config", "unused")).rejects.toThrow(configPath);

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to move to Trash \(manual delete\): .*openclaw\.json$/),
    );
  });

  it("preserves config and workspace when canonical session reset fails", async () => {
    const { stateDir, run } = resetFixture();
    const workspaceDir = path.join(stateDir, "agents");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const inspectError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    mocks.removeAgentSessions.mockRejectedValueOnce(inspectError);
    await expect(run("full", workspaceDir)).rejects.toBe(inspectError);

    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
  });

  it("fails closed after attempting workspace state cleanup when retired state remains", async () => {
    const { workspaceDir, runtime, run } = resetFixture();
    const warning = `Could not remove retired workspace state at ${workspaceDir}.attested`;
    mocks.removeLegacyWorkspaceStateForReset.mockResolvedValueOnce({
      removedPaths: [],
      warnings: [warning],
    });
    await expect(run()).rejects.toThrow(warning);

    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
    expect(runtime.log).toHaveBeenCalledWith(warning);
  });

  it("reports rejected retired and workspace state cleanup after attempting both", async () => {
    const { workspaceDir, run } = resetFixture();
    mocks.removeLegacyWorkspaceStateForReset.mockRejectedValueOnce(
      new Error("retired state unavailable"),
    );
    mocks.deleteWorkspaceState.mockRejectedValueOnce(new Error("state database unavailable"));

    const reset = run();

    await expect(reset).rejects.toThrow(`${workspaceDir} (retired workspace state)`);
    await expect(reset).rejects.toThrow(`${workspaceDir} (workspace state)`);
    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
  });

  it("retains workspace state when workspace removal fails", async () => {
    const { stateDir, workspaceDir, runtime, run } = resetFixture("work");
    fs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    mocks.movePathToTrash.mockImplementation(async (targetPath) => {
      if (targetPath === expectedTrashSourcePath(workspaceDir)) {
        throw new Error("trash unavailable");
      }
      return `${targetPath}.trashed`;
    });

    await expect(run()).rejects.toThrow(workspaceDir);

    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to move to Trash \(manual delete\): .*workspace$/),
    );
  });
});

describe("openUrl", () => {
  it("passes OAuth URLs to Windows FileProtocolHandler without cmd parsing", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("NODE_ENV", "development");
    const rundll32 = path.win32.join("C:\\Windows", "System32", "rundll32.exe");

    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost";

    await withMockedPlatform("win32", async () => {
      const ok = await openUrl(url);
      expect(ok).toBe(true);

      expect(mocks.runCommandWithTimeout).toHaveBeenCalledExactlyOnceWith(
        [rundll32, "url.dll,FileProtocolHandler", url],
        { timeoutMs: 5_000 },
      );
    });
  });

  it("does not pass non-http URLs to the OS browser handler", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");

    await withMockedPlatform("win32", async () => {
      const ok = await openUrl("file://C:/Users/test/secrets.txt");

      expect(ok).toBe(false);
      expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    });
  });
});

it.each([
  [false, "/control", "http://localhost:18789/control/"],
  [true, undefined, "https://localhost:18789/"],
] as const)(
  "formats the SSH hint with TLS=%s and base path %s",
  (tlsEnabled, basePath, expectedUrl) => {
    expect(formatControlUiSshHint({ port: 18789, basePath, tlsEnabled })).toContain(
      `Then open:\n${expectedUrl}`,
    );
  },
);

describe("waitForGatewayReachable", () => {
  it("cancels the pending retry timer when readiness is abandoned", async () => {
    vi.useFakeTimers();
    try {
      mocks.probeGateway.mockResolvedValue({ ok: false, error: "not ready" });
      const controller = new AbortController();
      const waiting = waitForGatewayReachable({
        url: "ws://127.0.0.1:18789",
        deadlineMs: 60_000,
        pollMs: 30_000,
        signal: controller.signal,
      });
      const cancelled = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await cancelled;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps oversized poll intervals within the overall deadline", async () => {
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      error: "connect failed: timeout",
    });

    const result = await waitForGatewayReachable({
      url: "ws://127.0.0.1:18789",
      deadlineMs: 5,
      pollMs: Number.MAX_SAFE_INTEGER,
      probeTimeoutMs: 1,
    });

    expect(result).toEqual({ ok: false, detail: "connect failed: timeout" });
  });
});

it.each([
  [
    "remote",
    "lan",
    "ws://192.168.0.202:18789",
    "openai/gpt-5.4",
    "Model: openai/gpt-5.4\nGateway: remote via LAN at ws://192.168.0.202:18789",
  ],
  [
    "local",
    "loopback",
    "ws://192.168.0.202:18789",
    undefined,
    "Gateway: local via loopback on :18789",
  ],
  ["remote", "lan", undefined, undefined, "Gateway: remote via LAN (missing remote URL)"],
] as const)("summarizes %s via %s with remote URL %s", (mode, bind, url, model, expected) => {
  expect(
    summarizeExistingConfig({
      agents: { defaults: { model: model ? { primary: model } : undefined } },
      gateway: { mode, bind, port: 18789, remote: url ? { url } : undefined },
    }),
  ).toBe(expected);
});

describe("resolveControlUiLinks", () => {
  it("uses tailnet IP for tailnet bind", () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    expect(resolveControlUiLinks({ port: 18789, bind: "tailnet" })).toEqual({
      httpUrl: "http://100.64.0.9:18789/",
      wsUrl: "ws://100.64.0.9:18789",
    });
  });

  it("uses route-aware advertised LAN host for display links", async () => {
    mocks.resolveAdvertisedLanHostCore.mockResolvedValueOnce("10.211.55.3");

    expect(await resolveAdvertisedControlUiLinks({ port: 18789, bind: "lan" })).toEqual({
      httpUrl: "http://10.211.55.3:18789/",
      wsUrl: "ws://10.211.55.3:18789",
    });
  });

  it("keeps co-located tailnet probes on loopback", () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const links = resolveLocalControlUiProbeLinks({
      port: 18789,
      bind: "tailnet",
      customBindHost: "192.0.2.10",
      tlsEnabled: true,
      basePath: "/dashboard",
    });

    expect(links.httpUrl).toBe("https://127.0.0.1:18789/dashboard/");
    expect(links.wsUrl).toBe("wss://127.0.0.1:18789/dashboard");
    expect(mocks.resolveAdvertisedLanHostCore).not.toHaveBeenCalled();
  });
});

it.each([
  [["  token  "], "token"],
  [["undefined", "null"], ""],
] as const)("normalizes token inputs %j", (inputs, expected) => {
  inputs.forEach((input) => expect(normalizeGatewayTokenInput(input)).toBe(expected));
});

it.each([
  [["", "   "], "Required"],
  [["undefined", "null"], 'Cannot be the literal string "undefined" or "null"'],
  [[" secret "], undefined],
] as const)("validates password inputs %j", (inputs, expected) => {
  inputs.forEach((input) => expect(validateGatewayPasswordInput(input)).toBe(expected));
});

describe("probeGatewayReachable", () => {
  it("forwards remote trust through polling", async () => {
    mocks.probeGateway.mockResolvedValueOnce({ ok: true, configSnapshot: null });
    const config: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
          edgeAuth: { "X-Edge-Auth": "test-secret" },
          tlsFingerprint: "ab".repeat(32),
        },
      },
    };

    await expect(
      waitForGatewayReachable({
        url: "wss://gateway.example",
        config,
        originScopedDeviceAuth: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://gateway.example",
        config,
        originScopedDeviceAuth: true,
      }),
    );
  });

  it("bounds thrown probe errors without splitting UTF-16", async () => {
    const detail = `${"x".repeat(118)}…`;
    mocks.probeGateway.mockRejectedValue(new Error(`${"x".repeat(118)}🚀tail\nignored`));
    expect(await probeGatewayReachable(localProbe)).toEqual({ ok: false, detail });
    expect(await probeGatewayConfiguredModel(localProbe)).toBe("unreachable");
  });

  it.each([
    ["TLS fingerprint", { tlsFingerprint: "sha256:11:22:33:44" }, 1500],
    ["preauth handshake budget", { preauthHandshakeTimeoutMs: 30_000 }, 30_000],
  ] as const)(
    "forwards the configured %s to the Gateway probe",
    async (_name, options, timeoutMs) => {
      mocks.probeGateway.mockResolvedValueOnce({ ok: true, configSnapshot: null });
      await expect(probeGatewayReachable({ url: remoteUrl, ...options })).resolves.toEqual({
        ok: true,
      });
      expect(mocks.probeGateway).toHaveBeenCalledWith({
        url: remoteUrl,
        timeoutMs,
        auth: probeAuth,
        ...options,
        detailLevel: "none",
      });
    },
  );

  it("classifies configured and missing default-agent models from config-only probes", async () => {
    mocks.probeGateway
      .mockResolvedValueOnce({
        ok: true,
        gatewayReached: true,
        configSnapshot: {
          valid: true,
          config: { agents: { entries: { work: { model: "openai/gpt-5.5" } } } },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        gatewayReached: true,
        configSnapshot: { valid: true, config: { gateway: { mode: "local" } } },
      });

    await expect(probeGatewayConfiguredModel(localProbe)).resolves.toBe("configured");
    await expect(
      probeGatewayConfiguredModel({
        ...localProbe,
        originScopedDeviceAuth: true,
      }),
    ).resolves.toBe("missing-configured-model");
    expect(mocks.probeGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({ detailLevel: "config", originScopedDeviceAuth: true }),
    );
  });

  it.each([
    [
      "typed pairing failure",
      {
        ok: false,
        gatewayReached: true,
        error: "device pairing required",
        connectErrorDetails: { code: ConnectErrorDetailCodes.PAIRING_REQUIRED },
      },
      "reachable-unverified",
    ],
    [
      "unrecognized connect error",
      {
        ok: false,
        error: "foreign protocol error",
        connectErrorDetails: { code: "NOT_AN_OPENCLAW_CONNECT_ERROR" },
      },
      "unreachable",
    ],
    [
      "config without handshake evidence",
      {
        ok: true,
        error: null,
        server: { version: "foreign-server", connId: null },
        configSnapshot: {
          valid: true,
          config: { agents: { defaults: { model: "openai/foreign-model" } } },
        },
      },
      "unreachable",
    ],
    [
      "invalid config",
      {
        ok: true,
        gatewayReached: true,
        configSnapshot: { valid: false },
      },
      "reachable-unverified",
    ],
  ])("classifies %s", async (_name, result, expected) => {
    mocks.probeGateway.mockResolvedValueOnce(result);
    await expect(probeGatewayConfiguredModel(localProbe)).resolves.toEqual(expected);
  });
});
