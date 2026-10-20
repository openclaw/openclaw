// Non-interactive gateway onboarding tests cover local/remote setup, daemon install, and config writes.
// Gateway credential storage and health probes share the gateway-health-auth suite.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { resolveGatewayStartupTiming } from "./gateway-startup-timing.js";
import {
  capturedReplaceConfigFileCalls,
  configWritePluginLeaseDepths,
  ensureWorkspaceAndSessionsMock,
  gatewayReachableState,
  gatewayServiceMock,
  getPseudoPort,
  healthCommandMock,
  installGatewayDaemonNonInteractiveMock,
  gatewayOnboardConfigSnapshotMock as readConfigFileSnapshotMock,
  readLastGatewayErrorLineMock,
  readTestConfig,
  resolveTestConfigPath,
  runNonInteractiveSetup,
  gatewayOnboardRuntime as runtime,
  testConfigStore,
  useGatewayOnboardTestHarness,
  waitForGatewayReachableMock,
} from "./onboard-non-interactive.gateway.test-mocks.js";
import {
  createOnboardJsonCaptureRuntime,
  createOnboardLocalDaemonOptions,
  expectOnboardLocalJsonSetupFailure,
} from "./onboard-non-interactive.test-helpers.js";
import type { WaitForGatewayReachableMock } from "./onboard-non-interactive.test-helpers.js";
import type { OnboardOptions } from "./onboard-types.js";

const localDefaults = {
  nonInteractive: true,
  mode: "local",
  authChoice: "skip",
  skipSkills: true,
  skipHealth: true,
  installDaemon: false,
} as const;
const localOptions = (stateDir: string) => ({
  ...localDefaults,
  workspace: path.join(stateDir, "openclaw"),
});
const makeAgents = () => ({ alpha: { model: "fixture/alpha" }, beta: { model: "fixture/beta" } });
const routeBinding = (agentId: string, id: string) => ({
  type: "route" as const,
  agentId,
  match: { channel: "discord", peer: { kind: "direct" as const, id } },
});
type FailureOutput = {
  hints?: string[];
  daemonInstall?: { requested: boolean; installed: boolean; skippedReason?: string };
  diagnostics?: {
    service?: {
      loaded: boolean | null;
      loadState: { status: string; detail?: string };
    };
  };
};

describe("onboard (non-interactive): gateway and remote auth", () => {
  const { withStateDir } = useGatewayOnboardTestHarness("openclaw-onboard-");

  async function jsonFailure(
    stateDir: string,
    overrides: Partial<Parameters<typeof runNonInteractiveSetup>[0]> = {},
  ) {
    const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();
    await expectOnboardLocalJsonSetupFailure({
      runSetup: (opts, runtimeEnv) => runNonInteractiveSetup({ ...opts, ...overrides }, runtimeEnv),
      stateDir,
      runtime: runtimeWithCapture,
    });
    return { parsed: JSON.parse(readCapturedJson()) as FailureOutput, output: readCapturedJson() };
  }

  afterEach(async () => {
    gatewayReachableState.mock = undefined;
    const { resetSecretRedactionRegistryForTest } =
      await import("../logging/secret-redaction-registry.test-support.js");
    resetSecretRedactionRegistryForTest();
    testConfigStore.clear();
    capturedReplaceConfigFileCalls.length = 0;
    configWritePluginLeaseDepths.length = 0;
    vi.clearAllMocks();
  });

  it("uses the setup phase's Fix hint in human and JSON output", async () => {
    for (const json of [false, true]) {
      await withStateDir("state-phase-recovery-", async (stateDir) => {
        gatewayReachableState.mock = vi.fn(async () => ({
          ok: false,
          detail: "connect ECONNREFUSED 127.0.0.1:18997",
        }));
        const output = vi.fn();
        await expect(
          runNonInteractiveSetup(
            { ...createOnboardLocalDaemonOptions(stateDir), installDaemon: undefined, json },
            {
              ...runtime,
              log: output,
              error: output,
              exit: () => {
                throw new Error("exit:1");
              },
            },
          ),
        ).rejects.toThrow("exit:1");

        const emitted = String(output.mock.calls.at(-1)?.[0]);
        const hints = json
          ? (JSON.parse(emitted) as { hints: string[] }).hints
          : emitted.split("\n");
        expect(hints.filter((hint) => hint.startsWith("Fix:"))).toEqual([
          "Fix: start `openclaw gateway run`, re-run `openclaw onboard --install-daemon`, or use `openclaw onboard --skip-health`.",
        ]);
        if (json) {
          expect(JSON.parse(emitted)).toMatchObject({
            ok: false,
            error: {
              type: "cli_error",
              message: expect.stringContaining("Gateway did not become reachable"),
            },
            phase: "gateway-health",
            classification: "not-listening",
          });
        }
      });
    }
  });

  it("keeps container precedence on every recovery command in human and JSON output", async () => {
    const { env, selector } = {
      env: { OPENCLAW_PROFILE: "work", OPENCLAW_CONTAINER_HINT: "preview" },
      selector: "--container preview",
    } as const;

    const cases = [
      {
        detail: "unauthorized: invalid token",
        commands: ["doctor --fix"],
      },
      {
        detail: "Cannot find module sqlite-vec",
        commands: ["doctor --fix"],
      },
      {
        detail: "Cannot find package 'typebox' imported from /app/plugin.mjs",
        commands: ["doctor --fix"],
      },
      {
        detail: "ERR_MODULE_NOT_FOUND",
        commands: ["doctor --fix"],
      },
      {
        detail: "connect ECONNREFUSED",
        diagnostics: {
          lastGatewayError: "Cannot find package '@openclaw/example' imported from /app/plugin.mjs",
        },
        commands: ["doctor --fix"],
      },
      {
        detail: "connect ECONNREFUSED",
        diagnostics: {
          service: {
            label: "Gateway",
            loaded: false,
            loadState: { status: "not-loaded" as const },
            loadedText: "not loaded",
          },
        },
        commands: ["gateway install --force"],
      },
      {
        detail: "connect ECONNREFUSED",
        diagnostics: {
          service: {
            label: "Gateway",
            loaded: true,
            loadState: { status: "loaded" as const },
            loadedText: "loaded",
            runtimeStatus: "stopped",
          },
        },
        commands: ["gateway restart"],
      },
      {
        detail: "startup timed out",
        diagnostics: { lastGatewayError: "configuration parse failed" },
        commands: ["gateway status --deep"],
      },
      {
        detail: "connect ECONNREFUSED",
        commands: ["gateway run", "gateway restart"],
      },
    ];

    await withEnvAsync(env, async () => {
      for (const { detail, diagnostics, commands } of cases) {
        for (const json of [false, true]) {
          await withStateDir("state-container-recovery-", async (stateDir) => {
            gatewayReachableState.mock = vi.fn(async () => ({ ok: false, detail }));
            gatewayServiceMock.isLoaded.mockResolvedValueOnce(diagnostics?.service?.loaded ?? true);
            gatewayServiceMock.readRuntime.mockResolvedValueOnce({
              status: diagnostics?.service?.runtimeStatus ?? "running",
              state: "active",
              pid: 4242,
            });
            readLastGatewayErrorLineMock.mockResolvedValueOnce(diagnostics?.lastGatewayError ?? "");
            const output = vi.fn();
            await expect(
              runNonInteractiveSetup(
                { ...createOnboardLocalDaemonOptions(stateDir), json },
                {
                  ...runtime,
                  log: output,
                  error: output,
                  exit: () => {
                    throw new Error("exit:1");
                  },
                },
              ),
            ).rejects.toThrow("exit:1");

            const emitted = String(output.mock.calls.at(-1)?.[0]);
            const hint = json
              ? (JSON.parse(emitted) as { hints: string[] }).hints[0]
              : emitted.split("\n").find((line) => line.startsWith("Fix:"));
            for (const command of commands) {
              expect(hint).toContain(`\`openclaw ${selector} ${command}\``);
            }
          });
        }
      }
    });
  });

  it("rejects invalid existing config without writes and reports JSON failure", async () => {
    await withStateDir("state-invalid-config-", async (stateDir) => {
      const snapshot = await readConfigFileSnapshotMock();
      readConfigFileSnapshotMock.mockResolvedValueOnce({
        ...snapshot,
        exists: true,
        valid: false,
        issues: [{ path: "gateway.port", message: "invalid" }],
      });
      const output = vi.fn();
      const error = vi.fn();
      const captureRuntime: RuntimeEnv = {
        log: output,
        error,
        exit: (code) => {
          throw new Error(`exit:${code}`);
        },
      };
      const message =
        "Config invalid. Run `openclaw doctor --fix` to apply supported repairs, then re-run setup.";

      await expect(
        runNonInteractiveSetup(
          {
            ...createOnboardLocalDaemonOptions(stateDir),
            installDaemon: false,
            skipHealth: true,
            json: true,
          },
          captureRuntime,
        ),
      ).rejects.toThrow("exit:1");

      expect(error).toHaveBeenCalledWith(message);
      expect(output).toHaveBeenCalledOnce();
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: { type: "cli_error", message },
        phase: "options",
        message,
      });
      expect(capturedReplaceConfigFileCalls).toHaveLength(0);
      expect(ensureWorkspaceAndSessionsMock).not.toHaveBeenCalled();
    });
  });

  it("rejects concurrent onboarding runs sharing one state directory", async () => {
    await withStateDir("state-concurrent-onboard-", async (stateDir) => {
      let workspaceSetupCalls = 0;
      let releaseFirstSetup!: () => void;
      const firstSetupEntered = new Promise<void>((resolve) => {
        ensureWorkspaceAndSessionsMock.mockImplementation(async () => {
          workspaceSetupCalls += 1;
          if (workspaceSetupCalls === 1) {
            resolve();
            await new Promise<void>((release) => {
              releaseFirstSetup = release;
            });
          }
        });
      });
      const options = localOptions(stateDir);

      try {
        const first = runNonInteractiveSetup(options, runtime);
        await firstSetupEntered;
        const readsBeforeSecond = readConfigFileSnapshotMock.mock.calls.length;
        const writesBeforeSecond = capturedReplaceConfigFileCalls.length;
        await expect(runNonInteractiveSetup(options, runtime)).rejects.toMatchObject({
          name: "SetupTargetLockedError",
        });

        expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(readsBeforeSecond);
        expect(capturedReplaceConfigFileCalls).toHaveLength(writesBeforeSecond);
        expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledOnce();

        releaseFirstSetup();
        await first;
        await runNonInteractiveSetup(options, runtime);
        expect(configWritePluginLeaseDepths).toHaveLength(2);
        expect(configWritePluginLeaseDepths.every((depth) => depth > 0)).toBe(true);
      } finally {
        releaseFirstSetup?.();
        ensureWorkspaceAndSessionsMock.mockImplementation(async () => {});
      }
    });
  });

  it("writes the implicit workspace under a non-default state directory", async () => {
    await withStateDir("state-isolated-workspace-", async (stateDir) => {
      await runNonInteractiveSetup(
        {
          ...localDefaults,
          gatewayBind: "loopback",
          gatewayAuth: "token",
          gatewayToken: "tok_state_isolation",
        },
        runtime,
      );

      const workspace = path.join(stateDir, "workspace");
      const cfg = readTestConfig();
      expect(cfg.agents).toMatchObject({
        defaults: { workspace },
        entries: { main: { workspace } },
      });
    });
  });

  it("preserves existing config on onboard rerun (openclaw#84692)", async () => {
    await withStateDir("state-preserve-agents-", async (stateDir) => {
      const workspace = path.join(stateDir, "openclaw");
      const warningRuntime = { ...runtime, error: vi.fn() };
      const seededAgents = makeAgents();
      const passwordRef = { source: "env" as const, provider: "default", id: "GATEWAY_PASSWORD" };
      const seededBindings = [routeBinding("alpha", "user-1"), routeBinding("beta", "user-2")];
      testConfigStore.set(resolveTestConfigPath(), {
        agents: {
          ownership: "explicit",
          entries: seededAgents,
          defaults: { workspace, systemAgent: { agentId: "alpha" } },
        },
        bindings: seededBindings,
        gateway: {
          mode: "local",
          port: 24680,
          bind: "loopback",
          auth: { mode: "password", password: passwordRef },
          tailscale: { mode: "serve" },
        },
      } as OpenClawConfig);

      await runNonInteractiveSetup(
        {
          ...localDefaults,
          workspace: path.join(stateDir, "requested-workspace"),
        },
        warningRuntime,
      );

      const cfg = readTestConfig();
      expect(cfg.agents?.entries).toEqual(seededAgents);
      expect(cfg.agents?.defaults?.workspace).toBe(workspace);
      expect(cfg.bindings).toEqual(seededBindings);
      expect(warningRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("existing agents keep their current workspace"),
      );
      expect(cfg.gateway?.port).toBe(24680);

      const onboardWrite = capturedReplaceConfigFileCalls.at(-1);
      expect(onboardWrite?.writeOptions?.allowConfigSizeDrop).toBe(false);
    });
  }, 60_000);

  it("migrates local onboard plugin install records in the setup write", async () => {
    await withStateDir("state-local-plugin-installs-", async (stateDir) => {
      testConfigStore.set(resolveTestConfigPath(), {
        plugins: {
          installs: {
            demo: {
              source: "path",
              installPath: path.join(stateDir, "plugins", "demo"),
            },
          },
        },
      } as OpenClawConfig);

      await runNonInteractiveSetup(
        {
          ...localOptions(stateDir),
          gatewayBind: "loopback",
          gatewayAuth: "token",
          gatewayToken: "tok_plugin_installs",
        },
        runtime,
      );

      expect(capturedReplaceConfigFileCalls).toHaveLength(1);
      const onboardWrite = capturedReplaceConfigFileCalls.at(-1);
      expect(onboardWrite?.nextConfig.plugins?.installs).toBeUndefined();
      expect(onboardWrite?.writeOptions?.unsetPaths).toEqual([["plugins", "installs"]]);
      expect(onboardWrite?.writeOptions?.allowConfigSizeDrop).toBe(false);
    });
  }, 60_000);

  it("persists skipBootstrap and skips workspace bootstrap creation", async () => {
    await withStateDir("state-skip-bootstrap-", async (stateDir) => {
      const workspace = path.join(stateDir, "openclaw");

      await runNonInteractiveSetup(
        {
          ...localOptions(stateDir),
          skipBootstrap: true,
          gatewayBind: "loopback",
        },
        runtime,
      );

      const cfg = readTestConfig();

      expect(cfg.agents?.defaults).toMatchObject({ workspace, skipBootstrap: true });
      expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledOnce();
      expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledWith(
        workspace,
        runtime,
        expect.objectContaining({ skipBootstrap: true }),
      );
      expect(ensureWorkspaceAndSessionsMock.mock.calls[0]?.[1]).toBe(runtime);
    });
  }, 60_000);

  const remoteCredentialUrl = "wss://gateway.example.test";
  const remoteTokenRef = { source: "env", provider: "default", id: "OLD_REMOTE_TOKEN" } as const;
  const remoteTlsFingerprint = "sha256:test-fingerprint";
  const remoteEdgeAuth = { "X-Edge-Auth": "existing-edge-secret" };
  const remoteCredentialConfig = (
    remote: NonNullable<OpenClawConfig["gateway"]>["remote"],
  ): OpenClawConfig => ({ gateway: { mode: "remote", remote } });

  async function setupRemoteCredentials(opts: Partial<OnboardOptions>, baseConfig: OpenClawConfig) {
    let remote: NonNullable<OpenClawConfig["gateway"]>["remote"];
    await withStateDir("state-remote-credentials-", async () => {
      testConfigStore.set(resolveTestConfigPath(), baseConfig);
      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "remote",
          remoteUrl: remoteCredentialUrl,
          skipHooks: true,
          ...opts,
        },
        runtime,
      );
      remote = readTestConfig().gateway?.remote;
    });
    return remote;
  }

  it.each([
    {
      name: "fresh remote configuration",
      baseConfig: {},
      expectedRemote: { url: remoteCredentialUrl, password: "replacement-password" },
    },
    {
      name: "a token SecretRef on the same endpoint",
      baseConfig: remoteCredentialConfig({
        url: remoteCredentialUrl,
        token: remoteTokenRef,
        tlsFingerprint: remoteTlsFingerprint,
        edgeAuth: remoteEdgeAuth,
      }),
      expectedRemote: {
        url: remoteCredentialUrl,
        password: "replacement-password",
        tlsFingerprint: remoteTlsFingerprint,
        edgeAuth: remoteEdgeAuth,
      },
    },
    {
      name: "credentials and routing from a different endpoint",
      baseConfig: remoteCredentialConfig({
        url: "wss://old-gateway.example.test",
        token: remoteTokenRef,
        password: { source: "env", provider: "default", id: "OLD_REMOTE_PASSWORD" },
        tlsFingerprint: "sha256:old-fingerprint",
        sshTarget: "operator@old-gateway.example.test",
        edgeAuth: { "X-Edge-Auth": "old-edge-secret" },
      }),
      expectedRemote: { url: remoteCredentialUrl, password: "replacement-password" },
    },
  ])("stores a remote password while replacing $name", async ({ baseConfig, expectedRemote }) => {
    expect(
      await setupRemoteCredentials({ remotePassword: "replacement-password" }, baseConfig),
    ).toEqual(expectedRemote);
  });

  it.each([
    ["remoteToken", "token", "OPENCLAW_GATEWAY_TOKEN", "password"],
    ["remotePassword", "password", "OPENCLAW_GATEWAY_PASSWORD", "token"],
  ] as const)(
    "stores %s as a configured-provider env reference and clears the old credential",
    async (option, field, envName, previousField) => {
      await withEnvAsync({ [envName]: "replacement-credential" }, async () => {
        const remote = await setupRemoteCredentials(
          { [option]: "replacement-credential", secretInputMode: "ref" },
          {
            secrets: {
              defaults: { env: "gatewayenv" },
              providers: { gatewayenv: { source: "env" } },
            },
            ...remoteCredentialConfig({
              url: remoteCredentialUrl,
              [previousField]: { source: "env", provider: "default", id: "OLD_GATEWAY_CREDENTIAL" },
              tlsFingerprint: remoteTlsFingerprint,
            }),
          },
        );
        expect(remote).toEqual({
          url: remoteCredentialUrl,
          [field]: { source: "env", provider: "gatewayenv", id: envName },
          tlsFingerprint: remoteTlsFingerprint,
        });
      });
    },
  );

  it("clears a stale remote password when a token replaces auth for the same endpoint", async () => {
    const remote = await setupRemoteCredentials(
      { remoteToken: "replacement-token" },
      remoteCredentialConfig({
        url: remoteCredentialUrl,
        password: "old-password",
        tlsFingerprint: remoteTlsFingerprint,
      }),
    );
    expect(remote).toEqual({
      url: remoteCredentialUrl,
      token: "replacement-token",
      tlsFingerprint: remoteTlsFingerprint,
    });
  });

  it.each([
    "existing-password",
    { source: "env", provider: "default", id: "EXISTING_REMOTE_PASSWORD" },
  ] as const)(
    "preserves existing remote token and password %j without a replacement",
    async (password) => {
      const remote = {
        url: remoteCredentialUrl,
        token: "existing-token",
        password,
        tlsFingerprint: remoteTlsFingerprint,
      };
      expect(
        await setupRemoteCredentials({ secretInputMode: "ref" }, remoteCredentialConfig(remote)),
      ).toEqual(remote);
    },
  );

  it("writes gateway.remote url/token", async () => {
    await withStateDir("state-remote-", async (_stateDir) => {
      const port = getPseudoPort(30_000);
      const token = "tok_remote_123";
      testConfigStore.set(resolveTestConfigPath(), {
        gateway: {
          remote: {
            url: "wss://old.example.test",
            transport: "ssh",
            remotePort: 24680,
            sshTarget: "operator@old.example.test",
            sshIdentity: "/tmp/old-identity",
            sshHostKeyPolicy: "openssh",
            token: "test-token",
            password: { source: "env", provider: "default", id: "REMOTE_PASSWORD" },
            tlsFingerprint: "sha256:test-fingerprint",
          },
        },
      } as OpenClawConfig);
      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "remote",
          remoteUrl: `ws://127.0.0.1:${port}`,
          remoteToken: token,
          authChoice: "skip",
          json: true,
        },
        runtime,
      );

      const cfg = readTestConfig();

      expect(cfg.gateway?.mode).toBe("remote");
      expect(cfg.gateway?.remote).toEqual({
        url: `ws://127.0.0.1:${port}`,
        token,
      });
      expect(cfg.hooks).toBeUndefined();
    });
  }, 60_000);

  it("preserves existing agents and bindings on remote onboard rerun (openclaw#84692)", async () => {
    await withStateDir("state-remote-preserve-agents-", async (_stateDir) => {
      const port = getPseudoPort(30_000);
      const passwordRef = {
        source: "env" as const,
        provider: "default",
        id: "OPENCLAW_REMOTE_GATEWAY_PASSWORD",
      };
      const tokenRef = { source: "env" as const, provider: "default", id: "REMOTE_TOKEN" };
      const seededAgents = makeAgents();
      const seededBindings = [routeBinding("alpha", "user-1")];
      const seededHooks = {
        internal: {
          enabled: false,
          entries: { "session-memory": { enabled: false } },
        },
      };
      testConfigStore.set(resolveTestConfigPath(), {
        agents: { ownership: "explicit", entries: seededAgents },
        bindings: seededBindings,
        hooks: seededHooks,
        gateway: {
          mode: "remote",
          remote: {
            url: `ws://127.0.0.1:${port}`,
            token: tokenRef,
            password: passwordRef,
            tlsFingerprint: "sha256:test-fingerprint",
          },
        },
      } as OpenClawConfig);

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "remote",
          remoteUrl: `ws://127.0.0.1:${port}`,
          authChoice: "skip",
          json: true,
        },
        runtime,
      );

      const cfg = readTestConfig();
      expect(cfg.agents?.entries).toEqual(seededAgents);
      expect(cfg.bindings).toEqual(seededBindings);
      expect(cfg.hooks).toEqual(seededHooks);
      expect(cfg.gateway?.remote).toEqual({
        url: `ws://127.0.0.1:${port}`,
        token: tokenRef,
        password: passwordRef,
        tlsFingerprint: "sha256:test-fingerprint",
      });

      const remoteWrite = capturedReplaceConfigFileCalls.at(-1);
      expect(remoteWrite?.writeOptions?.allowConfigSizeDrop).toBe(false);
    });
  }, 60_000);

  it("completes explicit no-daemon setup without a startup wait when no gateway is listening", async () => {
    await withStateDir("state-local-health-hint-", async (stateDir) => {
      gatewayReachableState.mock = vi.fn(async () => ({
        ok: false,
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      }));
      const log = vi.fn();

      await runNonInteractiveSetup(
        { ...createOnboardLocalDaemonOptions(stateDir), installDaemon: false },
        { ...runtime, log },
      );

      expect(log.mock.calls.flat().join("\n")).toMatch(
        /Setup complete; gateway was not installed or started because daemon installation was explicitly skipped\.[\s\S]*Gateway did not become reachable[\s\S]*Classification: not-listening[\s\S]*only waits for an already-running gateway unless you pass `--install-daemon` to `openclaw onboard`[\s\S]*openclaw onboard --install-daemon[\s\S]*openclaw onboard --skip-health/,
      );
      expect(gatewayReachableState.mock).toHaveBeenCalledOnce();
      expect(waitForGatewayReachableMock).not.toHaveBeenCalled();
    });
  }, 60_000);

  it.each([
    { platform: "linux", healthTimeoutMs: 10_000 },
    { platform: "win32", healthTimeoutMs: 90_000 },
  ] as const)(
    "uses managed daemon health timing on $platform",
    async ({ platform, healthTimeoutMs }) => {
      await withStateDir("state-local-daemon-health-", async (stateDir) => {
        // Bootstrap shared/client state and runtime pins before spoofing daemon timing.
        const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
        openOpenClawStateDatabase({ env: process.env });
        const { initializeFreshDaemonRuntimePinMigration } =
          await import("../infra/state-migrations.daemon-runtime-pins.js");
        initializeFreshDaemonRuntimePinMigration(process.env);
        const probe = vi.fn<NonNullable<WaitForGatewayReachableMock>>(async () => ({ ok: true }));
        gatewayReachableState.mock = probe;

        await withMockedPlatform(platform, () =>
          runNonInteractiveSetup(createOnboardLocalDaemonOptions(stateDir), runtime),
        );

        expect(readTestConfig().gateway).toMatchObject({ mode: "local", bind: "loopback" });
        expect(installGatewayDaemonNonInteractiveMock).toHaveBeenCalledTimes(1);
        const timing = resolveGatewayStartupTiming(platform);
        expect(probe.mock.calls.at(-1)?.[0]).toMatchObject({
          deadlineMs: timing.deadlineMs,
          probeTimeoutMs: timing.probeTimeoutMs,
        });
        expect(healthCommandMock).toHaveBeenCalledWith(
          expect.objectContaining({ timeoutMs: healthTimeoutMs }),
          expect.anything(),
        );
      });
    },
    60_000,
  );

  it("emits a daemon-install failure even when health checks are skipped", async () => {
    await withStateDir("state-local-daemon-install-json-fail-", async (stateDir) => {
      installGatewayDaemonNonInteractiveMock.mockResolvedValueOnce({
        installed: false,
        skippedReason: "systemd-user-unavailable",
      });

      const { parsed } = await withMockedPlatform("linux", () =>
        jsonFailure(stateDir, { skipHealth: true }),
      );
      expect(parsed).toMatchObject({ ok: false, phase: "daemon-install" });
      expect(parsed.daemonInstall).toEqual({
        requested: true,
        installed: false,
        skippedReason: "systemd-user-unavailable",
      });
      expect(parsed.hints).toContain(
        "Fix: rerun without `--install-daemon` for one-shot setup, or enable a working user-systemd session and retry.",
      );
    });
  }, 60_000);

  it("emits structured JSON diagnostics when daemon health fails", async () => {
    await withStateDir("state-local-daemon-health-json-fail-", async (stateDir) => {
      const registeredSecret = "qa-onboarding-health-secret";
      const { registerSecretValueForRedaction } =
        await import("../logging/secret-redaction-registry.js");
      registerSecretValueForRedaction(registeredSecret);
      gatewayReachableState.mock = vi.fn(async () => ({
        ok: false,
        detail: `gateway closed (1006 abnormal closure (no close frame)): ${registeredSecret}`,
      }));
      readLastGatewayErrorLineMock.mockResolvedValueOnce(
        `Gateway failed to start: required secrets are unavailable: ${registeredSecret}`,
      );

      const { parsed, output } = await jsonFailure(stateDir);
      expect(parsed).toMatchObject({
        ok: false,
        phase: "gateway-health",
        installDaemon: true,
        detail: expect.stringContaining("1006 abnormal closure"),
        gateway: { wsUrl: expect.stringContaining("ws://127.0.0.1:") },
        diagnostics: {
          service: { label: "LaunchAgent", loaded: true, runtimeStatus: "running", pid: 4242 },
          lastGatewayError: expect.stringContaining("required secrets are unavailable"),
        },
      });
      expect(parsed.hints).toContain("Run `openclaw gateway status --deep` for more detail.");
      expect(parsed.diagnostics?.service?.loadState).toEqual({ status: "loaded" });
      expect(output).not.toContain(registeredSecret);
    });
  }, 60_000);

  it("emits structured JSON failure when a reachable managed gateway fails its health check", async () => {
    await withStateDir("state-local-daemon-health-exit-json-", async (stateDir) => {
      gatewayReachableState.mock = vi.fn(async () => ({ ok: true }));
      healthCommandMock.mockImplementationOnce(async (...args: unknown[]) => {
        // healthCommand prints its reachable-gateway diagnostic before its
        // CLI-style exit; the capture runtime must keep it off JSON stdout.
        // importActual yields the ExitError instance the prod graph sees; the
        // test file's static import can be a second class instance under Vitest.
        const { ExitError: RuntimeExitError } =
          await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
        const healthRuntime = args[1] as RuntimeEnv;
        healthRuntime.log("Gateway is reachable.");
        healthRuntime.log("Gateway credentials rejected.");
        throw new RuntimeExitError(1);
      });

      const { parsed } = await jsonFailure(stateDir);
      expect(parsed).toMatchObject({
        ok: false,
        phase: "gateway-health",
        message: expect.stringContaining("health check failed"),
        detail: expect.stringContaining("Gateway credentials rejected."),
      });
      expect(parsed.hints).toContain("Run `openclaw health` for full diagnostics.");
    });
  }, 60_000);

  it("routes thrown health-check errors through the onboarding failure owner", async () => {
    await withStateDir("state-local-health-failure-text-", async (stateDir) => {
      const registeredSecret = "qa-onboarding-health-secret";
      const { registerSecretValueForRedaction } =
        await import("../logging/secret-redaction-registry.js");
      registerSecretValueForRedaction(registeredSecret);
      gatewayReachableState.mock = vi.fn(async () => ({ ok: true }));
      healthCommandMock.mockRejectedValueOnce(
        new Error(`health request timed out: ${registeredSecret}`),
      );

      const failure = await runNonInteractiveSetup(
        createOnboardLocalDaemonOptions(stateDir),
        runtime,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/health check failed[\s\S]*health request timed out/);
      expect(String(failure)).not.toContain(registeredSecret);
    });
  }, 60_000);

  it("preserves unknown service inspection in JSON diagnostics", async () => {
    await withStateDir("state-local-daemon-health-unknown-", async (stateDir) => {
      gatewayReachableState.mock = vi.fn(async () => ({
        ok: false,
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      }));
      gatewayServiceMock.isLoaded.mockRejectedValueOnce(new Error("systemctl timed out"));

      const { parsed } = await jsonFailure(stateDir);
      expect(parsed.diagnostics?.service?.loaded).toBeNull();
      expect(parsed.diagnostics?.service?.loadState).toEqual({
        status: "unknown",
        detail: "Error: systemctl timed out",
      });
    });
  }, 60_000);
});
