// Onboard helper tests cover workspace setup, state cleanup, control UI links, and gateway probes.
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SpawnResult } from "../process/exec-result.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  formatControlUiSshHint,
  handleReset,
  normalizeGatewayTokenInput,
  openUrl,
  probeGatewayConfiguredModel,
  probeGatewayReachable,
  resolveAdvertisedControlUiLinks,
  resolveControlUiLinks,
  resolveLocalControlUiProbeLinks,
  summarizeExistingConfig,
  validateGatewayPasswordInput,
  waitForGatewayReachable,
} from "./onboard-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({
  removeAgentSessions: vi.fn(async () => {}),
  movePathToTrash: vi.fn(async (targetPath: string) => `${targetPath}.trashed`),
  runCommandWithTimeout: vi.fn<
    (
      argv: string[],
      options?: { timeoutMs?: number; windowsVerbatimArguments?: boolean },
    ) => Promise<SpawnResult>
  >(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  })),
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

type RunCommandCall = [
  argv: string[],
  options?: { timeoutMs?: number; windowsVerbatimArguments?: boolean },
];

function requireFirstRunCommandCall(): RunCommandCall {
  const [call] = mocks.runCommandWithTimeout.mock.calls;
  if (!call) {
    throw new Error("expected browser open command call");
  }
  return call as RunCommandCall;
}

function expectedTrashSourcePath(targetPath: string): string {
  return path.join(fs.realpathSync(path.dirname(targetPath)), path.basename(targetPath));
}

describe("handleReset", () => {
  it("rejects full-reset workspaces that contain the active onboarding lock", async () => {
    const homeDir = tempDirs.make("openclaw-reset-lock-overlap-");
    const stateDir = path.join(homeDir, "state");
    const migrationDir = path.join(stateDir, "migration");
    const migrationAlias = path.join(homeDir, "migration-alias");
    const lockSidecar = path.join(migrationDir, "onboarding.lock-target.lock");
    const lockSidecarViaAlias = path.join(migrationAlias, "onboarding.lock-target.lock");
    const configPath = path.join(stateDir, "openclaw.json");
    fs.mkdirSync(migrationDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n");
    fs.symlinkSync(migrationDir, migrationAlias, process.platform === "win32" ? "junction" : "dir");
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    for (const workspaceDir of [
      homeDir,
      stateDir,
      migrationDir,
      migrationAlias,
      lockSidecar,
      lockSidecarViaAlias,
    ]) {
      await expect(
        withEnvAsync(
          {
            HOME: homeDir,
            OPENCLAW_HOME: homeDir,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
          },
          async () => await handleReset("full", workspaceDir, runtime),
        ),
      ).rejects.toThrow("overlaps the active onboarding lock directory");
    }

    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
  });

  it("uses active profile paths for destructive reset targets", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-profile-"));
    const profileStateDir = path.join(homeDir, ".openclaw-work");
    const defaultStateDir = path.join(homeDir, ".openclaw");
    const profileConfigPath = path.join(profileStateDir, "openclaw.json");
    const profileCredentialsDir = path.join(profileStateDir, "credentials");
    const profileSessionsDir = path.join(profileStateDir, "agents", "main", "sessions");
    const secondarySessionsDir = path.join(profileStateDir, "agents", "ops", "sessions");
    const workspaceDir = path.join(profileStateDir, "workspace");
    const defaultCredentialsDir = path.join(defaultStateDir, "credentials");

    fs.mkdirSync(profileCredentialsDir, { recursive: true });
    fs.mkdirSync(profileSessionsDir, { recursive: true });
    fs.mkdirSync(secondarySessionsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(defaultCredentialsDir, { recursive: true });
    fs.writeFileSync(profileConfigPath, "{}\n");

    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
    const expectedTrashedPaths = [profileConfigPath, profileCredentialsDir, workspaceDir].map(
      expectedTrashSourcePath,
    );
    const expectedDefaultCredentialsDir = expectedTrashSourcePath(defaultCredentialsDir);

    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: profileStateDir,
          OPENCLAW_CONFIG_PATH: profileConfigPath,
        },
        async () => await handleReset("full", workspaceDir, runtime),
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }

    const trashedPaths = mocks.movePathToTrash.mock.calls.map(([targetPath]) => targetPath);
    expect(trashedPaths).toEqual(expectedTrashedPaths);
    expect(trashedPaths).not.toContain(expectedDefaultCredentialsDir);
    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
  });

  it("rejects a config-only reset when the existing config cannot be trashed", async () => {
    const homeDir = tempDirs.make("openclaw-reset-config-failure-");
    const configPath = path.join(homeDir, "openclaw.json");
    fs.writeFileSync(configPath, "{}\n");
    mocks.movePathToTrash.mockRejectedValueOnce(new Error("trash unavailable"));
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    await withEnvAsync(
      { HOME: homeDir, OPENCLAW_HOME: homeDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        await expect(handleReset("config", "unused", runtime)).rejects.toThrow(configPath);
      },
    );

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to move to Trash \(manual delete\): .*openclaw\.json$/),
    );
  });

  it("preserves config and workspace when canonical session reset fails", async () => {
    const homeDir = tempDirs.make("openclaw-reset-session-enumeration-");
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(stateDir, "agents");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const inspectError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    mocks.removeAgentSessions.mockRejectedValueOnce(inspectError);
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      async () => {
        const failure = await handleReset("full", workspaceDir, runtime).catch(
          (error: unknown) => error,
        );
        expect(failure).toBe(inspectError);
      },
    );

    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
  });

  it("fails closed after attempting workspace state cleanup when retired state remains", async () => {
    const homeDir = tempDirs.make("openclaw-reset-retired-state-");
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    const warning = `Could not remove retired workspace state at ${workspaceDir}.attested`;
    fs.mkdirSync(workspaceDir, { recursive: true });
    mocks.removeLegacyWorkspaceStateForReset.mockResolvedValueOnce({
      removedPaths: [],
      warnings: [warning],
    });
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      async () => {
        await expect(handleReset("full", workspaceDir, runtime)).rejects.toThrow(warning);
      },
    );

    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
    expect(runtime.log).toHaveBeenCalledWith(warning);
  });

  it("reports rejected retired and workspace state cleanup after attempting both", async () => {
    const homeDir = tempDirs.make("openclaw-reset-state-cleanup-rejections-");
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    mocks.removeLegacyWorkspaceStateForReset.mockRejectedValueOnce(
      new Error("retired state unavailable"),
    );
    mocks.deleteWorkspaceState.mockRejectedValueOnce(new Error("state database unavailable"));

    const reset = withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      async () =>
        await handleReset("full", workspaceDir, {
          log: vi.fn(),
        } as unknown as RuntimeEnv),
    );

    await expect(reset).rejects.toThrow(`${workspaceDir} (retired workspace state)`);
    await expect(reset).rejects.toThrow(`${workspaceDir} (workspace state)`);
    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
  });

  it("retains workspace state when workspace removal fails", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-profile-"));
    const profileStateDir = path.join(homeDir, ".openclaw-work");
    const profileConfigPath = path.join(profileStateDir, "openclaw.json");
    const profileCredentialsDir = path.join(profileStateDir, "credentials");
    const profileSessionsDir = path.join(profileStateDir, "agents", "main", "sessions");
    const workspaceDir = path.join(profileStateDir, "workspace");

    fs.mkdirSync(profileCredentialsDir, { recursive: true });
    fs.mkdirSync(profileSessionsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(profileConfigPath, "{}\n");

    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
    mocks.movePathToTrash.mockImplementation(async (targetPath) => {
      if (targetPath === expectedTrashSourcePath(workspaceDir)) {
        throw new Error("trash unavailable");
      }
      return `${targetPath}.trashed`;
    });

    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: profileStateDir,
          OPENCLAW_CONFIG_PATH: profileConfigPath,
        },
        async () => {
          await expect(handleReset("full", workspaceDir, runtime)).rejects.toThrow(workspaceDir);
        },
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }

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

      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
      const [argv, options] = requireFirstRunCommandCall();
      expect(argv).toEqual([rundll32, "url.dll,FileProtocolHandler", url]);
      expect(options?.timeoutMs).toBe(5_000);
      expect(options?.windowsVerbatimArguments).toBeUndefined();
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

describe("formatControlUiSshHint", () => {
  it.each([
    {
      label: "plain HTTP base path",
      tlsEnabled: false,
      basePath: "/control",
      expectedUrl: "http://localhost:18789/control/",
    },
    {
      label: "HTTPS root",
      tlsEnabled: true,
      basePath: undefined,
      expectedUrl: "https://localhost:18789/",
    },
  ])("uses the Gateway transport for $label", ({ tlsEnabled, basePath, expectedUrl }) => {
    const hint = formatControlUiSshHint({ port: 18789, basePath, tlsEnabled });

    expect(hint).toContain(`Then open:\n${expectedUrl}`);
  });
});

describe("waitForGatewayReachable", () => {
  it("keeps oversized poll intervals within the overall deadline", async () => {
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "connect failed: timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
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

describe("summarizeExistingConfig", () => {
  it("collapses gateway fields into a friendly remote summary", () => {
    expect(
      summarizeExistingConfig({
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
        gateway: {
          mode: "remote",
          port: 18789,
          bind: "lan",
          remote: { url: "ws://192.168.0.202:18789" },
        },
      }),
    ).toBe("Model: openai/gpt-5.4\nGateway: remote via LAN at ws://192.168.0.202:18789");
  });

  it("does not show a stale remote URL as active for local gateway mode", () => {
    expect(
      summarizeExistingConfig({
        gateway: {
          mode: "local",
          port: 18789,
          bind: "loopback",
          remote: { url: "ws://192.168.0.202:18789" },
        },
      }),
    ).toBe("Gateway: local via loopback on :18789");
  });

  it("surfaces missing remote URL instead of falling back to port for remote mode", () => {
    expect(
      summarizeExistingConfig({
        gateway: {
          mode: "remote",
          port: 18789,
          bind: "lan",
        },
      }),
    ).toBe("Gateway: remote via LAN (missing remote URL)");
  });
});

describe("resolveControlUiLinks", () => {
  it("uses tailnet IP for tailnet bind", () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "tailnet",
    });
    expect(links.httpUrl).toBe("http://100.64.0.9:18789/");
    expect(links.wsUrl).toBe("ws://100.64.0.9:18789");
  });

  it("uses route-aware advertised LAN host for display links", async () => {
    mocks.resolveAdvertisedLanHostCore.mockResolvedValueOnce("10.211.55.3");

    const links = await resolveAdvertisedControlUiLinks({
      port: 18789,
      bind: "lan",
    });

    expect(links.httpUrl).toBe("http://10.211.55.3:18789/");
    expect(links.wsUrl).toBe("ws://10.211.55.3:18789");
  });

  it.each(["tailnet"] as const)("keeps co-located %s probes on loopback", (bind) => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const links = resolveLocalControlUiProbeLinks({
      port: 18789,
      bind,
      customBindHost: "192.0.2.10",
      tlsEnabled: true,
      basePath: "/dashboard",
    });

    expect(links.httpUrl).toBe("https://127.0.0.1:18789/dashboard/");
    expect(links.wsUrl).toBe("wss://127.0.0.1:18789/dashboard");
    expect(mocks.resolveAdvertisedLanHostCore).not.toHaveBeenCalled();
  });
});

describe("normalizeGatewayTokenInput", () => {
  it("trims string input", () => {
    expect(normalizeGatewayTokenInput("  token  ")).toBe("token");
  });

  it('rejects literal string coercion artifacts ("undefined"/"null")', () => {
    expect(normalizeGatewayTokenInput("undefined")).toBe("");
    expect(normalizeGatewayTokenInput("null")).toBe("");
  });
});

describe("validateGatewayPasswordInput", () => {
  it("requires a non-empty password", () => {
    expect(validateGatewayPasswordInput("")).toBe("Required");
    expect(validateGatewayPasswordInput("   ")).toBe("Required");
  });

  it("rejects literal string coercion artifacts", () => {
    expect(validateGatewayPasswordInput("undefined")).toBe(
      'Cannot be the literal string "undefined" or "null"',
    );
    expect(validateGatewayPasswordInput("null")).toBe(
      'Cannot be the literal string "undefined" or "null"',
    );
  });

  it("accepts a normal password", () => {
    expect(validateGatewayPasswordInput(" secret ")).toBeUndefined();
  });
});

describe("probeGatewayReachable", () => {
  it.each([["polling", waitForGatewayReachable]] as const)(
    "forwards remote trust through %s",
    async (_name, probe) => {
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
        probe({ url: "wss://gateway.example", config, originScopedDeviceAuth: true }),
      ).resolves.toEqual({ ok: true });
      expect(mocks.probeGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "wss://gateway.example",
          config,
          originScopedDeviceAuth: true,
        }),
      );
    },
  );

  it("bounds thrown probe errors without splitting UTF-16", async () => {
    const detail = `${"x".repeat(118)}…`;
    const params = { url: "ws://127.0.0.1:18789" };
    mocks.probeGateway.mockRejectedValue(new Error(`${"x".repeat(118)}🚀tail\nignored`));
    expect(await probeGatewayReachable(params)).toEqual({ ok: false, detail });
    expect(await probeGatewayConfiguredModel(params)).toEqual({ kind: "unreachable", detail });
  });

  it("forwards a configured TLS fingerprint to the gateway probe", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: null,
    });

    await expect(
      probeGatewayReachable({
        url: "wss://gateway.example.com:18789",
        tlsFingerprint: "sha256:11:22:33:44",
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "wss://gateway.example.com:18789",
      timeoutMs: 1500,
      auth: {
        token: undefined,
        password: undefined,
      },
      tlsFingerprint: "sha256:11:22:33:44",
      detailLevel: "none",
    });
  });

  it("lets a configured preauth handshake timeout widen the default probe budget", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: null,
    });

    await expect(
      probeGatewayReachable({
        url: "wss://gateway.example.com:18789",
        preauthHandshakeTimeoutMs: 30_000,
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "wss://gateway.example.com:18789",
      timeoutMs: 30_000,
      auth: {
        token: undefined,
        password: undefined,
      },
      preauthHandshakeTimeoutMs: 30_000,
      detailLevel: "none",
    });
  });

  it("classifies configured and missing default-agent models from config-only probes", async () => {
    mocks.probeGateway
      .mockResolvedValueOnce({
        ok: true,
        server: { version: "2026.7.2", connId: "conn-configured" },
        gatewayReached: true,
        configSnapshot: {
          valid: true,
          config: { agents: { entries: { work: { model: "openai/gpt-5.5" } } } },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        server: { version: "2026.7.2", connId: "conn-missing" },
        gatewayReached: true,
        configSnapshot: { valid: true, config: { gateway: { mode: "local" } } },
      });

    await expect(
      probeGatewayConfiguredModel({
        url: "ws://127.0.0.1:18789",
      }),
    ).resolves.toEqual({ kind: "configured" });
    await expect(
      probeGatewayConfiguredModel({
        url: "ws://127.0.0.1:18789",
        originScopedDeviceAuth: true,
      }),
    ).resolves.toEqual({
      kind: "missing-configured-model",
      detail: "Gateway default agent has no configured model",
    });
    expect(mocks.probeGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({ detailLevel: "config", originScopedDeviceAuth: true }),
    );
  });

  it("keeps typed pre-Hello Gateway auth failures on the reachable path", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "device pairing required",
      connectErrorDetails: { code: ConnectErrorDetailCodes.PAIRING_REQUIRED },
      gatewayReached: true,
      auth: { role: null, scopes: [], capability: "pairing_pending" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "device pairing required",
    });
  });

  it("does not trust an unrecognized connect error code as Gateway evidence", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "foreign protocol error",
      connectErrorDetails: { code: "NOT_AN_OPENCLAW_CONNECT_ERROR" },
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
      detail: "foreign protocol error",
    });
  });

  it("does not trust a config-shaped response without Gateway handshake evidence", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      connectLatencyMs: 42,
      error: null,
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: "foreign-server", connId: null },
      configSnapshot: {
        valid: true,
        config: { agents: { defaults: { model: "openai/foreign-model" } } },
      },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
    });
  });

  it("treats an invalid config snapshot as reachable but unverified", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      connectLatencyMs: 42,
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      server: { version: "2026.7.2", connId: "conn-1" },
      gatewayReached: true,
      configSnapshot: { valid: false },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "Gateway returned an invalid config snapshot",
    });
  });
});
