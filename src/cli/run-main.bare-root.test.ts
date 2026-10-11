import "../test-utils/prepare-compiled-subprocesses.js";
// Register fixture mocks before modules that consume them.
// oxfmt-ignore
import {
  installRunMainTestHooks,
  type ConfigSnapshotStub,
  cliArgs,
  tempDirs,
  runCli,
  tryRouteCliMock,
  buildProgramMock,
  readConfigFileSnapshotMock,
  readLocalOnboardingStateMock,
  setupWizardCommandMock,
  runRemoteGatewayInferenceOnboardingMock,
  runTuiMock,
  runTuiCliActionMock,
  probeGatewayConfiguredModelMock,
  readActiveGatewayLockPortMock,
  inspectGatewayTlsCertificateMock,
  resolveControlUiLinksMock,
  validConfig,
} from "./run-main.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withSecureTestNodeExecPath } from "../secrets/test-node-command.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { registerBareRootArgumentTests, withCliTty } from "./run-main.bare-root.test-support.js";

const TLS_FINGERPRINT = "ab".repeat(32);
const PREFIXED_TLS_FINGERPRINT = `sha256:${TLS_FINGERPRINT.toUpperCase()}`;
function withInteractiveTty(fn: () => Promise<void>): Promise<void> {
  return withCliTty(true, fn);
}

function runBareCli(): Promise<void> {
  return withInteractiveTty(() => runCli(cliArgs()));
}

function expectBoundTui(expected: {
  url: string;
  configuredRemote?: boolean;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
}): void {
  expect(runTuiMock).toHaveBeenCalledWith(
    expect.objectContaining({
      deliver: false,
      boundGateway: expected,
    }),
  );
}

function expectGatewayTarget(expected: Parameters<typeof expectBoundTui>[0]): void {
  expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
    ...expected,
    ...(expected.configuredRemote
      ? {
          originScopedDeviceAuth: true,
          config: expect.objectContaining({ gateway: expect.objectContaining({ mode: "remote" }) }),
        }
      : {}),
  });
  expectBoundTui(expected);
}

function primeBareRootConfig(sourceConfig: ConfigSnapshotStub["sourceConfig"]): void {
  readConfigFileSnapshotMock.mockResolvedValueOnce({ exists: true, valid: true, sourceConfig });
}

async function expectNonInteractiveBareCliError(
  message: string,
  assert?: () => void,
): Promise<void> {
  const previousExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  try {
    await withCliTty(false, () => runCli(cliArgs()));
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(message);
    assert?.();
  } finally {
    errorSpy.mockRestore();
    process.exitCode = previousExitCode;
  }
}

describe("runCli exit behavior", () => {
  installRunMainTestHooks();

  it.each([
    {
      label: "before the URL with split values",
      args: [
        "--token",
        "direct-token",
        "--password",
        "direct-password",
        "--tls-fingerprint",
        PREFIXED_TLS_FINGERPRINT,
        "https://gateway.example/dashboard/main/movies-a1166b81",
        "--deliver",
        "--message",
        "continue here",
      ],
    },
    {
      label: "before the URL with inline values",
      args: [
        "--token=direct-token",
        "--password=direct-password",
        `--tls-fingerprint=${PREFIXED_TLS_FINGERPRINT}`,
        "--message=continue here",
        "https://gateway.example/dashboard/main/movies-a1166b81",
        "--deliver",
      ],
    },
  ])("forwards bare-root TUI options $label without an environment handoff", async ({ args }) => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "ambient-token",
        OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
      },
      () => withInteractiveTty(() => runCli(cliArgs(...args))),
    );

    expect(runTuiCliActionMock).toHaveBeenCalledWith(target, {
      token: "direct-token",
      password: "direct-password",
      tlsFingerprint: PREFIXED_TLS_FINGERPRINT,
      deliver: true,
      message: "continue here",
    });
  });

  it.each([
    ["unknown inline option", ["--typo=do-not-print-me"]],
    ["option terminator", ["--"]],
  ])("rejects a pre-URL %s without reflecting values", async (_label, prefix) => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";
    let error: unknown;
    try {
      await runCli(cliArgs(...prefix, target));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("do-not-print-me");
    expect(runTuiCliActionMock).not.toHaveBeenCalled();
  });

  it("rejects a missing pre-URL direct option value before command discovery", async () => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";

    await expect(runCli(cliArgs("--token", target))).rejects.toThrow("--token requires a value");
    expect(runTuiCliActionMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "resumes onboarding when an interrupted first run only persisted risk acknowledgement",
      snapshot: validConfig({
        meta: { updatedBy: "fixture" },
        wizard: { securityAcknowledgedAt: "2026-07-13T00:00:00.000Z" },
      }),
    },
  ])("$name", async ({ snapshot }) => {
    readConfigFileSnapshotMock.mockResolvedValueOnce(snapshot);
    await expect(runBareCli()).resolves.toBeUndefined();

    expect(readConfigFileSnapshotMock).toHaveBeenCalledOnce();
    expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
  });

  it("resumes pending local onboarding after inference persisted its model", async () => {
    const configPath = "/tmp/openclaw.json";
    const securityAcknowledgedAt = "2026-08-02T00:00:00.000Z";
    const sourceConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
      wizard: { securityAcknowledgedAt },
    };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: true,
      path: configPath,
      sourceConfig,
    });
    readLocalOnboardingStateMock.mockReturnValueOnce({
      version: 1,
      status: "pending",
      runId: "pending-onboarding",
      configPath,
      workspace: "/tmp/workspace",
      securityAcknowledgedAt,
      startedAtMs: 1,
    });

    await runBareCli();

    expect(readLocalOnboardingStateMock).toHaveBeenCalledWith(configPath, sourceConfig);
    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(probeGatewayConfiguredModelMock).not.toHaveBeenCalled();
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  registerBareRootArgumentTests({
    runCli: (argv) => runCli(argv),
    readConfigFileSnapshotMock,
    buildProgramMock,
    setupWizardCommandMock,
    runTuiMock,
    tryRouteCliMock,
    withInteractiveTty,
    expectNonInteractiveBareCliError,
  });

  it.each(["ws://127.0.0.1:18789"])(
    "configures missing inference on the selected remote Gateway: %s",
    async (url) => {
      const sourceConfig = {
        agents: { defaults: { model: { primary: "openai/local-only-model" } } },
        gateway: {
          mode: "remote",
          remote: {
            url,
            token: "missing-inference-remote-auth",
            tlsFingerprint: `sha256:${TLS_FINGERPRINT.toUpperCase()}`,
          },
        },
      };
      readConfigFileSnapshotMock.mockResolvedValueOnce({ exists: true, valid: true, sourceConfig });
      probeGatewayConfiguredModelMock.mockImplementationOnce(async (options) =>
        options.url === "ws://127.0.0.1:18789" && !options.originScopedDeviceAuth
          ? { kind: "reachable-unverified", detail: "missing scope: operator.read" }
          : {
              kind: "missing-configured-model",
              detail: "Gateway default agent has no configured model",
            },
      );

      await runBareCli();

      expect(setupWizardCommandMock).not.toHaveBeenCalled();
      expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
      expect(runRemoteGatewayInferenceOnboardingMock).toHaveBeenCalledWith({
        config: sourceConfig,
        gatewayUrl: url,
        configuredRemote: true,
        token: "missing-inference-remote-auth",
        tlsFingerprint: TLS_FINGERPRINT,
      });
      expect(runTuiMock).not.toHaveBeenCalled();
    },
  );

  it("does not direct non-interactive remote setup into local onboarding", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "remote",
        remote: { url: "wss://gateway.example/ws", token: "noninteractive-remote-auth" },
      },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "missing-configured-model",
      detail: "Gateway default agent has no configured model",
    });
    await expectNonInteractiveBareCliError(
      "Remote Gateway inference setup needs an interactive TTY. Re-run `openclaw` in a terminal connected to this Gateway.",
      () => {
        expect(setupWizardCommandMock).not.toHaveBeenCalled();
        expect(runRemoteGatewayInferenceOnboardingMock).not.toHaveBeenCalled();
      },
    );
  });

  it("uses the active local gateway lock port for bare root preflight and TUI handoff", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        port: 18789,
        auth: { mode: "token", token: "configured-token" },
      },
    });
    readActiveGatewayLockPortMock.mockResolvedValueOnce(48789);

    await runBareCli();

    expectGatewayTarget({ url: "ws://127.0.0.1:48789", token: "configured-token" });
  });

  it("carries the canonical local TLS fingerprint through bare root", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        tls: { enabled: true },
        auth: { mode: "token", token: "configured-token" },
      },
    });
    inspectGatewayTlsCertificateMock.mockResolvedValueOnce({
      ok: true,
      value: { cert: "public-certificate", fingerprintSha256: TLS_FINGERPRINT },
    });

    await runBareCli();

    expectGatewayTarget({
      url: "wss://127.0.0.1:18789",
      token: "configured-token",
      tlsFingerprint: TLS_FINGERPRINT,
    });
  });

  it("resolves only the configured auth-mode SecretRef for bare root preflight", async () => {
    const tempDir = tempDirs.make("openclaw-bare-auth-mode-");
    const tokenMarker = path.join(tempDir, "token-provider-ran");
    const passwordMarker = path.join(tempDir, "password-provider-ran");
    const tokenProgram = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(tokenMarker)},'1');`,
      "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { TOKEN_SECRET: 'token-from-exec' } }));", // pragma: allowlist secret
    ].join("");
    const passwordProgram = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(passwordMarker)},'1');`,
      "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { PASSWORD_SECRET: 'password-from-exec' } }));", // pragma: allowlist secret
    ].join("");
    await withSecureTestNodeExecPath(async () => {
      primeBareRootConfig({
        secrets: {
          providers: {
            tokenprovider: {
              source: "exec",
              command: process.execPath,
              args: ["-e", tokenProgram],
              allowInsecurePath: true,
            },
            passwordprovider: {
              source: "exec",
              command: process.execPath,
              args: ["-e", passwordProgram],
              allowInsecurePath: true,
            },
          },
        },
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            token: { source: "exec", provider: "tokenprovider", id: "TOKEN_SECRET" },
            password: { source: "exec", provider: "passwordprovider", id: "PASSWORD_SECRET" },
          },
        },
      });

      await runBareCli();

      expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
        url: "ws://127.0.0.1:18789",
        password: "password-from-exec",
      });
      await expect(fs.access(tokenMarker)).rejects.toThrow();
      await expect(fs.access(passwordMarker)).resolves.toBeUndefined();
      expectBoundTui({
        url: "ws://127.0.0.1:18789",
        password: "password-from-exec",
      });
    });
  });

  it("prefers a configured secondary Gateway over a missing-model primary probe", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        bind: "tailnet",
        auth: { mode: "token", token: "local-token" },
      },
    });
    resolveControlUiLinksMock.mockImplementation(({ bind }: { bind?: string } = {}) =>
      bind === "tailnet"
        ? { httpUrl: "http://100.64.0.10:18789/", wsUrl: "ws://100.64.0.10:18789" }
        : { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
    );
    probeGatewayConfiguredModelMock
      .mockResolvedValueOnce({
        kind: "missing-configured-model",
        detail: "Gateway default agent has no configured model",
      })
      .mockResolvedValueOnce({ kind: "configured" });

    await runBareCli();

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url: "ws://100.64.0.10:18789", token: "local-token" });
  });

  it("keeps confirmed missing inference ahead of an unverified secondary Gateway", async () => {
    primeBareRootConfig({
      agents: { defaults: { model: { primary: "openai/local-only-model" } } },
      gateway: {
        mode: "local",
        bind: "tailnet",
        auth: { mode: "token", token: "local-token" },
      },
    });
    resolveControlUiLinksMock.mockImplementation(({ bind }: { bind?: string } = {}) =>
      bind === "tailnet"
        ? { httpUrl: "http://100.64.0.10:18789/", wsUrl: "ws://100.64.0.10:18789" }
        : { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
    );
    probeGatewayConfiguredModelMock
      .mockResolvedValueOnce({ kind: "reachable-unverified", detail: "config.get: unauthorized" })
      .mockResolvedValueOnce({
        kind: "missing-configured-model",
        detail: "Gateway default agent has no configured model",
      });

    await runBareCli();

    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it("keeps a reachable unverified Gateway ahead of local inference fallback", async () => {
    const url = "ws://127.0.0.1:18789";
    primeBareRootConfig({
      agents: { defaults: { model: { primary: "openai/local-only-model" } } },
      gateway: { mode: "remote", remote: { url, token: "unverified-remote-auth" } },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "reachable-unverified",
      detail: "config.get: unauthorized",
    });

    await runBareCli();

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url, configuredRemote: true, token: "unverified-remote-auth" });
  });

  it("keeps a configured remote Gateway authoritative across a transient cold-restart probe", async () => {
    const url = "wss://gateway.example/ws";
    primeBareRootConfig({
      gateway: { mode: "remote", remote: { url, token: "restart-remote-auth" } },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "unreachable",
      detail: "gateway restarting",
    });

    await runBareCli();

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(runRemoteGatewayInferenceOnboardingMock).not.toHaveBeenCalled();
    expectBoundTui({ url, configuredRemote: true, token: "restart-remote-auth" });
  });

  it("routes an explicit roster with no configured inference to onboarding", async () => {
    primeBareRootConfig({
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, beta: {} },
      },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "unreachable",
      detail: "offline",
    });

    await runBareCli();

    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it.each([{ label: "LAN IP", url: "ws://192.168.1.10:18789" }])(
    "does not probe a plaintext remote gateway over $label without opt-in",
    async ({ url }) => {
      primeBareRootConfig({
        gateway: {
          mode: "remote",
          remote: {
            url,
            token: "unsafe-remote-auth",
          },
        },
      });

      await withEnvAsync({ OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: undefined }, async () => {
        await runBareCli();
      });

      expect(probeGatewayConfiguredModelMock).not.toHaveBeenCalled();
      expect(setupWizardCommandMock).toHaveBeenCalledWith({});
      expect(runTuiMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "configured edge auth",
      url: "wss://gateway.example/ws",
      remote: { token: "test-token", edgeAuth: { "X-Edge-Auth": "test-secret" } },
      env: {},
      auth: { token: "test-token" },
    },
    {
      name: "configured password ahead of ambient auth",
      url: "ws://127.0.0.1:18789",
      remote: { password: "configured-remote-password" }, // pragma: allowlist secret
      env: { OPENCLAW_GATEWAY_PASSWORD: "obsolete-shell-pass-value" },
      auth: { password: "configured-remote-password" }, // pragma: allowlist secret
    },
    {
      name: "unresolved references without ambient substitution",
      url: "ws://127.0.0.1:18789",
      remote: {
        token: { source: "env" as const, provider: "default", id: "MISSING_REMOTE_GATEWAY_TOKEN" },
        password: {
          source: "env" as const,
          provider: "default",
          id: "MISSING_REMOTE_GATEWAY_PASSWORD",
        },
      },
      env: {
        MISSING_REMOTE_GATEWAY_TOKEN: undefined,
        MISSING_REMOTE_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: "shell-fallback-auth-value",
        OPENCLAW_GATEWAY_PASSWORD: "env-remote-password",
      },
      auth: {},
    },
    {
      name: "explicit plaintext private opt-in",
      url: "ws://192.168.1.10:18789",
      remote: { token: "private-remote-auth" },
      env: { OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" },
      auth: { token: "private-remote-auth" },
    },
  ])("preserves $name through the probe and TUI handoff", async ({ url, remote, env, auth }) => {
    const config: OpenClawConfig = { gateway: { mode: "remote", remote: { url, ...remote } } };
    primeBareRootConfig(config);
    await withEnvAsync(env, runBareCli);
    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url,
      originScopedDeviceAuth: true,
      configuredRemote: true,
      config,
      ...auth,
    });
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url, configuredRemote: true, ...auth });
  });

  it("rejects configured bare root TUI startup without an interactive TTY", async () => {
    await expectNonInteractiveBareCliError(
      "OpenClaw TUI needs an interactive TTY. Use `openclaw agent --local ...` for automation.",
      () => expect(runTuiMock).not.toHaveBeenCalled(),
    );
  });

  it("routes invalid configured bare root invocations to classic doctor guidance", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: false,
      sourceConfig: { gateway: { mode: "local" } },
    });

    await runBareCli();

    expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).toHaveBeenCalledWith({ classic: true });
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it("points noninteractive invalid config to doctor before onboarding", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: false,
      sourceConfig: { gateway: { mode: "local" } },
    });
    await expectNonInteractiveBareCliError(
      "OpenClaw config is invalid. Run `openclaw doctor --fix` before onboarding.",
      () => expect(setupWizardCommandMock).not.toHaveBeenCalled(),
    );
  });

  it("keeps a completed model-only onboarding on its existing local TUI path", async () => {
    const configPath = "/tmp/openclaw.json";
    const securityAcknowledgedAt = "2026-08-02T00:00:00.000Z";
    const sourceConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
      wizard: { securityAcknowledgedAt },
    };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: true,
      path: configPath,
      sourceConfig,
    });
    readLocalOnboardingStateMock.mockReturnValueOnce({
      version: 1,
      status: "completed",
      runId: "completed-onboarding",
      configPath,
      workspace: "/tmp/workspace",
      securityAcknowledgedAt,
      startedAtMs: 1,
      completedAtMs: 2,
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({ kind: "unreachable" });

    await runBareCli();

    expect(readLocalOnboardingStateMock).toHaveBeenCalledWith(configPath, sourceConfig);
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(runTuiMock).toHaveBeenCalledWith({
      deliver: false,
      local: true,
    });
  });
});
