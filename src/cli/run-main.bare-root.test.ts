import "../test-utils/prepare-compiled-subprocesses.js";
// Register fixture mocks before modules that consume them.
// oxfmt-ignore
import * as cli from "./run-main.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withSecureTestNodeExecPath } from "../secrets/test-node-command.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { TuiBoundGateway } from "../tui/tui-types.js";
import { registerBareRootArgumentTests, withCliTty } from "./run-main.bare-root.test-support.js";

const TLS_FINGERPRINT = "ab".repeat(32);
const PREFIXED_TLS_FINGERPRINT = `sha256:${TLS_FINGERPRINT.toUpperCase()}`;
const LOCAL_URL = "ws://127.0.0.1:18789";
const SESSION_URL = "https://gateway.example/dashboard/main/movies-a1166b81";
const LOCAL_MODEL = { defaults: { model: { primary: "openai/local-only-model" } } };
const MISSING_MODEL = {
  kind: "missing-configured-model",
  detail: "Gateway default agent has no configured model",
} as const;
const DIRECT_AUTH = {
  token: "direct-token",
  password: "direct-password",
  tlsFingerprint: PREFIXED_TLS_FINGERPRINT,
};
const directArgs = (inline: boolean) =>
  Object.entries({
    token: DIRECT_AUTH.token,
    password: DIRECT_AUTH.password,
    "tls-fingerprint": DIRECT_AUTH.tlsFingerprint,
  }).flatMap(([key, value]) => (inline ? [`--${key}=${value}`] : [`--${key}`, value]));
function withInteractiveTty(fn: () => Promise<void>): Promise<void> {
  return withCliTty(true, fn);
}

function runBareCli(): Promise<void> {
  return withInteractiveTty(() => cli.runCli(cli.cliArgs()));
}

function expectBoundTui(expected: TuiBoundGateway): void {
  expect(cli.runTuiMock).toHaveBeenCalledWith(
    expect.objectContaining({ deliver: false, boundGateway: expected }),
  );
}

function primeBareRootConfig(sourceConfig: cli.ConfigSnapshotStub["sourceConfig"]): void {
  cli.readConfigFileSnapshotMock.mockResolvedValueOnce(cli.validConfig(sourceConfig));
}

function remoteConfig(
  url: string,
  remote: NonNullable<NonNullable<OpenClawConfig["gateway"]>["remote"]>,
): OpenClawConfig {
  return { gateway: { mode: "remote", remote: { url, ...remote } } };
}
const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });

function expectNoCalls(...mocks: unknown[]): void {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

async function expectNonInteractiveBareCliError(
  message: string,
  assert?: () => void,
): Promise<void> {
  const previousExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  try {
    await withCliTty(false, () => cli.runCli(cli.cliArgs()));
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(message);
    assert?.();
  } finally {
    errorSpy.mockRestore();
    process.exitCode = previousExitCode;
  }
}

cli.installRunMainTestHooks();

it.each([
  {
    label: "before the URL with split values",
    args: [...directArgs(false), SESSION_URL, "--deliver", "--message", "continue here"],
  },
  {
    label: "before the URL with inline values",
    args: [...directArgs(true), "--message=continue here", SESSION_URL, "--deliver"],
  },
])("forwards bare-root TUI options $label without an environment handoff", async ({ args }) => {
  await withEnvAsync(
    {
      OPENCLAW_GATEWAY_TOKEN: "ambient-token",
      OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
    },
    () => withInteractiveTty(() => cli.runCli(cli.cliArgs(...args))),
  );

  expect(cli.runTuiCliActionMock).toHaveBeenCalledWith(SESSION_URL, {
    ...DIRECT_AUTH,
    deliver: true,
    message: "continue here",
  });
});

it.each([
  ["unknown inline option", ["--typo=do-not-print-me"]],
  ["option terminator", ["--"]],
])("rejects a pre-URL %s without reflecting values", async (_label, prefix) => {
  const error = await cli
    .runCli(cli.cliArgs(...prefix, SESSION_URL))
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain("do-not-print-me");
  expect(cli.runTuiCliActionMock).not.toHaveBeenCalled();
});

it("rejects a missing pre-URL direct option value before command discovery", async () => {
  await expect(cli.runCli(cli.cliArgs("--token", SESSION_URL))).rejects.toThrow(
    "--token requires a value",
  );
  expect(cli.runTuiCliActionMock).not.toHaveBeenCalled();
});

it("resumes onboarding when an interrupted first run only persisted risk acknowledgement", async () => {
  cli.readConfigFileSnapshotMock.mockResolvedValueOnce(
    cli.validConfig({
      meta: { updatedBy: "fixture" },
      wizard: { securityAcknowledgedAt: "2026-07-13T00:00:00.000Z" },
    }),
  );
  await expect(runBareCli()).resolves.toBeUndefined();

  expect(cli.readConfigFileSnapshotMock).toHaveBeenCalledOnce();
  expectNoCalls(cli.readLocalOnboardingStateMock, cli.tryRouteCliMock, cli.buildProgramMock);
  expect(cli.setupWizardCommandMock).toHaveBeenCalledWith({});
});

registerBareRootArgumentTests({
  runCli: (argv) => cli.runCli(argv),
  readConfigFileSnapshotMock: cli.readConfigFileSnapshotMock,
  buildProgramMock: cli.buildProgramMock,
  setupWizardCommandMock: cli.setupWizardCommandMock,
  runTuiMock: cli.runTuiMock,
  tryRouteCliMock: cli.tryRouteCliMock,
  withInteractiveTty,
  expectNonInteractiveBareCliError,
});

it("configures missing inference on the selected remote Gateway", async () => {
  const sourceConfig = {
    ...remoteConfig(LOCAL_URL, {
      token: "missing-inference-remote-auth",
      tlsFingerprint: PREFIXED_TLS_FINGERPRINT,
    }),
    agents: LOCAL_MODEL,
  };
  primeBareRootConfig(sourceConfig);
  cli.probeGatewayConfiguredModelMock.mockImplementationOnce(async (options) =>
    options.url === LOCAL_URL && !options.originScopedDeviceAuth
      ? { kind: "reachable-unverified", detail: "missing scope: operator.read" }
      : MISSING_MODEL,
  );

  await runBareCli();

  expectNoCalls(cli.setupWizardCommandMock, cli.readLocalOnboardingStateMock, cli.runTuiMock);
  expect(cli.runRemoteGatewayInferenceOnboardingMock).toHaveBeenCalledWith({
    config: sourceConfig,
    gatewayUrl: LOCAL_URL,
    configuredRemote: true,
    token: "missing-inference-remote-auth",
    tlsFingerprint: TLS_FINGERPRINT,
  });
});

it("carries the canonical local TLS fingerprint through bare root", async () => {
  primeBareRootConfig({
    gateway: {
      mode: "local",
      tls: { enabled: true },
      auth: { mode: "token", token: "configured-token" },
    },
  });
  cli.inspectGatewayTlsCertificateMock.mockResolvedValueOnce({
    ok: true,
    value: { cert: "public-certificate", fingerprintSha256: TLS_FINGERPRINT },
  });

  await runBareCli();

  const target = {
    url: "wss://127.0.0.1:18789",
    token: "configured-token",
    tlsFingerprint: TLS_FINGERPRINT,
  };
  expect(cli.probeGatewayConfiguredModelMock).toHaveBeenCalledWith(target);
  expectBoundTui(target);
});

it("resolves only the configured auth-mode SecretRef for bare root preflight", async () => {
  const tempDir = cli.tempDirs.make("openclaw-bare-auth-mode-");
  const marker = (kind: string) => path.join(tempDir, `${kind}-provider-ran`);
  const execProvider = (kind: string) => ({
    source: "exec",
    command: process.execPath,
    args: [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker(kind))},'1');` +
        `process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { ${kind.toUpperCase()}_SECRET: '${kind}-from-exec' } }));`,
    ],
    allowInsecurePath: true,
  });
  await withSecureTestNodeExecPath(async () => {
    primeBareRootConfig({
      secrets: {
        providers: {
          tokenprovider: execProvider("token"),
          passwordprovider: execProvider("password"),
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

    const target = { url: LOCAL_URL, password: "password-from-exec" };
    expect(cli.probeGatewayConfiguredModelMock).toHaveBeenCalledWith(target);
    await expect(fs.access(marker("token"))).rejects.toThrow();
    await fs.access(marker("password"));
    expectBoundTui(target);
  });
});

it("keeps confirmed missing inference ahead of an unverified secondary Gateway", async () => {
  primeBareRootConfig({
    agents: LOCAL_MODEL,
    gateway: {
      mode: "local",
      bind: "tailnet",
      auth: { mode: "token", token: "local-token" },
    },
  });
  cli.resolveControlUiLinksMock.mockImplementation(({ bind }: { bind?: string } = {}) =>
    bind === "tailnet"
      ? { httpUrl: "http://100.64.0.10:18789/", wsUrl: "ws://100.64.0.10:18789" }
      : { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
  );
  cli.probeGatewayConfiguredModelMock
    .mockResolvedValueOnce({ kind: "reachable-unverified", detail: "config.get: unauthorized" })
    .mockResolvedValueOnce(MISSING_MODEL);

  await runBareCli();

  expect(cli.setupWizardCommandMock).toHaveBeenCalledWith({});
  expect(cli.runTuiMock).not.toHaveBeenCalled();
  expect(cli.startProxyMock).toHaveBeenCalledBefore(cli.setupWizardCommandMock);
});

it.each([
  ["reachable-unverified", LOCAL_URL],
  ["unreachable", "wss://gateway.example/ws"],
] as const)("keeps a %s remote Gateway authoritative over local inference", async (kind, url) => {
  primeBareRootConfig({
    ...remoteConfig(url, { token: "remote-auth" }),
    ...(kind === "reachable-unverified" ? { agents: LOCAL_MODEL } : {}),
  });
  cli.probeGatewayConfiguredModelMock.mockResolvedValueOnce({ kind, detail: "unavailable" });
  await runBareCli();
  expectNoCalls(
    cli.setupWizardCommandMock,
    cli.runRemoteGatewayInferenceOnboardingMock,
    cli.startProxyMock,
  );
  expectBoundTui({ url, configuredRemote: true, token: "remote-auth" });
});

it("does not probe a plaintext remote gateway over LAN without opt-in", async () => {
  const url = "ws://192.168.1.10:18789";
  primeBareRootConfig(remoteConfig(url, { token: "unsafe-remote-auth" }));
  await withEnvAsync({ OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: undefined }, runBareCli);
  expectNoCalls(cli.probeGatewayConfiguredModelMock, cli.runTuiMock);
  expect(cli.setupWizardCommandMock).toHaveBeenCalledWith({});
});

it.each([
  [
    "configured edge auth",
    "wss://gateway.example/ws",
    { token: "test-token", edgeAuth: { "X-Edge-Auth": "test-secret" } },
    {},
    { token: "test-token" },
  ],
  [
    "configured password ahead of ambient auth",
    LOCAL_URL,
    { password: "configured-remote-password" },
    { OPENCLAW_GATEWAY_PASSWORD: "obsolete-shell-pass-value" },
    { password: "configured-remote-password" },
  ],
  [
    "unresolved references without ambient substitution",
    LOCAL_URL,
    {
      token: envRef("MISSING_REMOTE_GATEWAY_TOKEN"),
      password: envRef("MISSING_REMOTE_GATEWAY_PASSWORD"),
    },
    {
      MISSING_REMOTE_GATEWAY_TOKEN: undefined,
      MISSING_REMOTE_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: "shell-fallback-auth-value",
      OPENCLAW_GATEWAY_PASSWORD: "env-remote-password",
    },
    {},
  ],
  [
    "explicit plaintext private opt-in",
    "ws://192.168.1.10:18789",
    { token: "private-remote-auth" },
    { OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" },
    { token: "private-remote-auth" },
  ],
] as const)(
  "preserves %s through the probe and TUI handoff",
  async (_name, url, remote, env, auth) => {
    const config = remoteConfig(url, remote);
    primeBareRootConfig(config);
    await withEnvAsync(env, runBareCli);
    expect(cli.probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url,
      originScopedDeviceAuth: true,
      configuredRemote: true,
      config,
      ...auth,
    });
    expect(cli.setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url, configuredRemote: true, ...auth });
  },
);

it("routes invalid configured bare root invocations to classic doctor guidance", async () => {
  cli.readConfigFileSnapshotMock.mockResolvedValueOnce(
    cli.validConfig({ gateway: { mode: "local" } }, { valid: false }),
  );

  await runBareCli();

  expectNoCalls(cli.readLocalOnboardingStateMock, cli.runTuiMock);
  expect(cli.setupWizardCommandMock).toHaveBeenCalledWith({ classic: true });
});

it("keeps a completed model-only onboarding on its local TUI path behind the managed proxy", async () => {
  const proxy = { proxyUrl: "http://proxy.invalid:3128" };
  cli.loadConfigMock.mockReturnValue({ proxy });
  const configPath = "/tmp/openclaw.json";
  const securityAcknowledgedAt = "2026-08-02T00:00:00.000Z";
  const sourceConfig = {
    agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
    wizard: { securityAcknowledgedAt },
  };
  cli.readConfigFileSnapshotMock.mockResolvedValueOnce(
    cli.validConfig(sourceConfig, { path: configPath }),
  );
  cli.readLocalOnboardingStateMock.mockResolvedValueOnce({
    version: 1,
    status: "completed",
    runId: "completed-onboarding",
    configPath,
    workspace: "/tmp/workspace",
    securityAcknowledgedAt,
    startedAtMs: 1,
    completedAtMs: 2,
  });
  cli.probeGatewayConfiguredModelMock.mockResolvedValueOnce({ kind: "unreachable" });

  await runBareCli();

  expect(cli.readLocalOnboardingStateMock).toHaveBeenCalledWith(configPath, sourceConfig);
  expect(cli.setupWizardCommandMock).not.toHaveBeenCalled();
  expect(cli.runTuiMock).toHaveBeenCalledWith({ deliver: false, local: true });
  // The embedded agent runs in this process, so the managed proxy must be active first.
  expect(cli.startProxyMock).toHaveBeenCalledExactlyOnceWith(proxy);
  expect(cli.startProxyMock).toHaveBeenCalledBefore(cli.runTuiMock);
});
