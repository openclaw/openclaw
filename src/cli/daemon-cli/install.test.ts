import "./install.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";

const {
  actionState,
  buildGatewayInstallPlanMock,
  expectFields,
  expectFirstInstallPlanCallOmitsToken,
  installDaemonServiceAndEmitMock,
  isGatewayDaemonRuntimeMock,
  loadConfigMock,
  mockResolvedGatewayTokenSecretRef,
  randomTokenMock,
  readConfigFileSnapshotMock,
  readFirstConfigWriteParams,
  readFirstInstallPlanArg,
  replaceConfigFileMock,
  resolveGatewayAuthMock,
  resolveGatewayBindHostMock,
  resolveSecretInputRefMock,
  resolveSecretRefValuesMock,
  runDaemonInstall,
  service,
  setupInstallTests,
} = await import("./install.test-support.js");

describe("runDaemonInstall", () => {
  setupInstallTests();

  it("refuses update-owned gateway defaults when authority expires during write preparation", async () => {
    const snapshot = await readConfigFileSnapshotMock();
    readConfigFileSnapshotMock.mockResolvedValue({ ...snapshot, sourceConfig: {} });
    let current = true;
    let committed = false;
    replaceConfigFileMock.mockImplementationOnce(async (params) => {
      await Promise.resolve();
      current = false;
      await params.writeOptions.beforeCommit?.();
      committed = true;
    });
    await expect(
      withGatewayServiceUpdateAuthority(
        () => expect(current, "original owner revoked").toBe(true),
        () => runDaemonInstall({ force: true, json: true }),
      ),
    ).rejects.toThrow("original owner revoked");
    expect(committed).toBe(false);
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("fails install when token auth requires an unresolved token SecretRef", async () => {
    resolveSecretInputRefMock.mockReturnValue({
      ref: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
    });
    resolveSecretRefValuesMock.mockRejectedValue(new Error("secret unavailable"));

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain("gateway.auth.token SecretRef is configured");
    expect(actionState.failed[0]?.message).toContain("unresolved");
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("blocks external-supervisor installs before reading or mutating config", async () => {
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain(
      "gateway lifecycle is managed by an external supervisor",
    );
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("blocks sudo-to-root systemd installs before persistent mutation", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    process.env.HOME = "/root";
    process.env.USER = "root";
    process.env.LOGNAME = "root";
    process.env.SUDO_USER = "operator";
    delete process.env.XDG_RUNTIME_DIR;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain("Rerun the same command without sudo");
    expect(actionState.failed[0]?.message).toContain("chmod go-w <path>");
    expect(actionState.failed[0]?.message).toContain(
      "https://docs.openclaw.ai/cli/gateway#install-identity",
    );
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(randomTokenMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("blocks inaccessible definitions before config reads or credential generation", async () => {
    service.readDefinitionMutationCapability.mockRejectedValueOnce(new Error("secret-canary"));
    await runDaemonInstall({ json: true, force: true });
    expect(actionState.failed[0]?.message).toContain("SERVICE_DEFINITION_UNKNOWN");
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(randomTokenMock).not.toHaveBeenCalled();
    expect(service.readCommand).toHaveBeenCalledOnce();
  });

  it("blocks non-default install identities before inspecting host services", async () => {
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain(
      "service management skipped: non-default state dir or config path",
    );
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("validates token SecretRef but does not serialize resolved token into service env", async () => {
    mockResolvedGatewayTokenSecretRef();

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
    expectFirstInstallPlanCallOmitsToken();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(
      actionState.warnings.some((warning) =>
        warning.includes("gateway.auth.token is SecretRef-managed"),
      ),
    ).toBe(true);
  });

  it.each(["darwin", "win32"] as const)(
    "refuses deferred activation on %s before writing configuration or service state",
    async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      await runDaemonInstall({ json: true, force: true, deferActivation: true });
      expect(actionState.failed.at(-1)?.message).toContain("Deferred service load requires Linux");
      expect(replaceConfigFileMock).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
      expect(service.isLoaded).not.toHaveBeenCalled();
    },
  );

  it("refuses an unparented deferred install before reading or writing the selected profile", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await runDaemonInstall({ json: true, force: true, deferActivation: true });
    expect(actionState.failed.at(-1)?.message).toContain("updater IPC channel");
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  });

  it("passes service environment value sources through to service install", async () => {
    buildGatewayInstallPlanMock.mockResolvedValueOnce({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {
        OPENROUTER_API_KEY: "or-operator-key",
      },
      environmentValueSources: {
        OPENROUTER_API_KEY: "file",
      },
    });
    installDaemonServiceAndEmitMock.mockImplementationOnce(async (params?: unknown) => {
      await (params as { install: () => Promise<void> }).install();
    });

    await runDaemonInstall({ json: true });

    const installCalls = service.install.mock.calls as unknown as Array<
      [
        {
          environment?: Record<string, string>;
          environmentValueSources?: Record<string, string>;
        },
      ]
    >;
    const installOptions = installCalls[0]?.[0] as
      | {
          environment?: Record<string, string>;
          environmentValueSources?: Record<string, string>;
        }
      | undefined;
    expect(installOptions?.environment).toEqual({
      OPENROUTER_API_KEY: "or-operator-key",
    });
    expect(installOptions?.environmentValueSources).toEqual({
      OPENROUTER_API_KEY: "file",
    });
  });

  it("captures service install warnings in json install output", async () => {
    installDaemonServiceAndEmitMock.mockImplementationOnce(async (params?: unknown) => {
      await (params as { install: () => Promise<void> }).install();
    });
    service.install.mockImplementationOnce(async (args?: unknown) => {
      (args as { warn?: (message: string) => void }).warn?.(
        "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
      );
    });

    await runDaemonInstall({ json: true, force: true });

    expect(actionState.warnings).toContain(
      "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
    );
  });

  it("does not treat env-template gateway.auth.token as plaintext during install", async () => {
    loadConfigMock.mockReturnValue({
      gateway: { auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    });
    mockResolvedGatewayTokenSecretRef();

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
    expect(resolveSecretRefValuesMock).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
    expectFirstInstallPlanCallOmitsToken();
  });

  it("auto-mints and persists token when no source exists", async () => {
    randomTokenMock.mockReturnValue("minted-token");
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: { gateway: { auth: { mode: "token" } } },
      sourceConfig: { gateway: { mode: "local", auth: { mode: "token" } } },
    });

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
    expect(replaceConfigFileMock).toHaveBeenCalledTimes(1);
    expect(readFirstConfigWriteParams().sourceConfig?.gateway?.auth?.token).toBe("minted-token");
    expectFields(readFirstInstallPlanArg(), { port: 18789 });
    expectFirstInstallPlanCallOmitsToken();
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    expect(actionState.warnings.join("\n")).toContain("Auto-generated");
  });

  it("persists local gateway mode when installing from config missing gateway.mode", async () => {
    readConfigFileSnapshotMock
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        config: { gateway: { auth: { mode: "token", token: "durable-token" } } },
        sourceConfig: { gateway: { auth: { mode: "token", token: "durable-token" } } },
      })
      .mockResolvedValue({
        exists: true,
        valid: true,
        config: {
          gateway: { mode: "local", auth: { mode: "token", token: "durable-token" } },
        },
        sourceConfig: {
          gateway: { mode: "local", auth: { mode: "token", token: "durable-token" } },
        },
      });
    resolveGatewayAuthMock.mockReturnValue({
      mode: "token",
      token: "durable-token",
      password: undefined,
      allowTailscale: false,
    });

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
    expect(replaceConfigFileMock).toHaveBeenCalledTimes(1);
    expect(readFirstConfigWriteParams().sourceConfig?.gateway?.mode).toBe("local");
    expect(actionState.warnings).toContain(
      "No gateway.mode found. Set gateway.mode=local for managed gateway install.",
    );
    expectFields(readFirstInstallPlanArg().config as Record<string, unknown>, {
      gateway: {
        mode: "local",
        auth: { mode: "token", token: "durable-token" },
      },
    });
  });

  it("blocks managed install when explicit no-auth would bind to LAN", async () => {
    const config = {
      gateway: {
        mode: "local",
        bind: "lan",
        auth: {
          mode: "none",
          token: "test-token",
        },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
    });
    resolveGatewayAuthMock.mockReturnValue({
      mode: "none",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    });
    resolveGatewayBindHostMock.mockResolvedValue("0.0.0.0");

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain("Gateway install blocked");
    expect(actionState.failed[0]?.message).toContain("gateway.bind=lan");
    expect(actionState.failed[0]?.message).toContain("gateway.auth.mode=none");
    expect(actionState.failed[0]?.message).toContain("openclaw config set gateway.auth.mode token");
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "custom bind resolving to a network interface",
      bind: "custom" as const,
      customBindHost: "192.168.1.20",
      resolvedHost: "192.168.1.20",
      blocked: true,
      message: undefined,
    },
    {
      name: "tailnet bind resolving to a tailnet interface",
      bind: "tailnet" as const,
      customBindHost: undefined,
      resolvedHost: "100.64.0.20",
      blocked: true,
      message: undefined,
    },
    {
      name: "tailnet bind falling back to loopback",
      bind: "tailnet" as const,
      customBindHost: undefined,
      resolvedHost: "127.0.0.1",
      blocked: true,
      message: "can later resolve to a Tailnet interface",
    },
    {
      name: "loopback bind",
      bind: "loopback" as const,
      customBindHost: undefined,
      resolvedHost: "127.0.0.1",
      blocked: false,
      message: undefined,
    },
  ])("handles explicit no-auth for $name", async (testCase) => {
    const config = {
      gateway: {
        mode: "local" as const,
        bind: testCase.bind,
        customBindHost: testCase.customBindHost,
        auth: { mode: "none" as const },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
    });
    resolveGatewayAuthMock.mockReturnValue({
      mode: "none",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    });
    resolveGatewayBindHostMock.mockResolvedValue(testCase.resolvedHost);

    await runDaemonInstall({ json: true });

    expect(resolveGatewayBindHostMock).toHaveBeenCalledWith(testCase.bind, testCase.customBindHost);
    if (testCase.blocked) {
      expect(actionState.failed[0]?.message).toContain(`gateway.bind=${testCase.bind}`);
      if (testCase.message) {
        expect(actionState.failed[0]?.message).toContain(testCase.message);
      }
      expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
      expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
    } else {
      expect(actionState.failed).toStrictEqual([]);
      expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
      expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    }
  });

  it("allows a managed LAN install with trusted-proxy auth", async () => {
    const config = {
      gateway: {
        mode: "local" as const,
        bind: "lan" as const,
        trustedProxies: ["127.0.0.1"],
        auth: { mode: "trusted-proxy" as const },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
    });
    resolveGatewayAuthMock.mockReturnValue({
      mode: "trusted-proxy",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    });
    resolveGatewayBindHostMock.mockResolvedValue("0.0.0.0");

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });

  it("does not persist gateway mode when runtime validation fails", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: { gateway: { auth: { mode: "token", token: "durable-token" } } },
      sourceConfig: { gateway: { auth: { mode: "token", token: "durable-token" } } },
    });
    isGatewayDaemonRuntimeMock.mockReturnValue(false);

    await runDaemonInstall({ json: true, runtime: "bogus" });

    expect(actionState.failed[0]?.message).toContain("Invalid --runtime");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("forwards Bun as the explicit managed-service runtime", async () => {
    await runDaemonInstall({ json: true, runtime: "bun" });

    expect(readFirstInstallPlanArg().runtime).toBe("bun");
    expect(actionState.failed).toStrictEqual([]);
  });

  it("continues Linux install when service probe hits a non-fatal systemd bus failure", async () => {
    service.isLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: Failed to connect to bus"),
    );

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });

  it("fails install when service probe reports an unrelated error", async () => {
    service.isLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: read-only file system"),
    );

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain("Gateway service check failed");
    expect(actionState.failed[0]?.message).toContain("read-only file system");
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("blocks install from an older binary when config was written by a newer one", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    });

    await runDaemonInstall({ json: true, force: true });

    expect(actionState.failed[0]?.message).toContain(
      "Refusing to install or rewrite the gateway service",
    );
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });
});
