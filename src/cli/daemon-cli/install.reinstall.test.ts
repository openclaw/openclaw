import "./install.test-support.js";
import { describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { createInstallPlanFixture, nodeProbeOutput } from "./install.test-helpers.js";

const {
  actionState,
  buildGatewayInstallPlanMock,
  expectFields,
  expectLastEmittedResult,
  installDaemonServiceAndEmitMock,
  readConfigFileSnapshotMock,
  readFirstInstallPlanArg,
  readFirstNodeStartupTlsEnvironmentArg,
  replaceConfigFileMock,
  resolveNodeStartupTlsEnvironmentMock,
  runDaemonInstall,
  runExecMock,
  service,
  setupInstallTests,
} = await import("./install.test-support.js");

describe("runDaemonInstall reinstall", () => {
  setupInstallTests();

  it.each([
    { mode: "local", installedOverride: false, plannedOverride: false },
    { mode: "remote", installedOverride: true, plannedOverride: true },
    { mode: "local", installedOverride: true, plannedOverride: false },
  ])(
    "refreshes only changed service start mode with $mode primary",
    async ({ mode, installedOverride, plannedOverride }) => {
      service.isLoaded.mockResolvedValue(true);
      readConfigFileSnapshotMock.mockResolvedValue({
        valid: true,
        sourceConfig: { gateway: { mode, auth: { mode: "token" } } },
      });
      const command = (override: boolean) =>
        ["openclaw", "gateway", "run"].concat(override ? ["--allow-unconfigured"] : []);
      const environment = { NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt" };
      resolveNodeStartupTlsEnvironmentMock.mockReturnValue(environment);
      service.readCommand.mockResolvedValue({
        programArguments: command(installedOverride),
        environment,
      });
      buildGatewayInstallPlanMock.mockResolvedValue({
        programArguments: command(plannedOverride),
        environment,
        workingDirectory: "/tmp",
      });
      await runDaemonInstall({ json: true });
      expect(actionState.failed).toEqual([]);
      if (installedOverride !== plannedOverride) {
        expect(installDaemonServiceAndEmitMock).toHaveBeenCalledOnce();
      } else {
        expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
        expect(actionState.emitted.at(-1)).toMatchObject({ result: "already-installed" });
      }
    },
  );

  it.each([
    { failure: "probe", message: "openclaw gateway install --force" },
    { failure: "no-replacement", message: "No supported Node runtime is available" },
    { failure: "sealed-definition", message: "SERVICE_DEFINITION_UNKNOWN" },
  ])(
    "refuses runtime repair on $failure without claiming success",
    async ({ failure, message }) => {
      service.isLoaded.mockResolvedValue(true);
      const oldNode = failure === "probe" ? resolveTestNodeExecPath() : "/opt/old/bin/node";
      service.readCommand.mockResolvedValue({
        programArguments: [oldNode, "/opt/openclaw/dist/index.js", "gateway"],
      });
      runExecMock.mockImplementation(async (file: string) => {
        if (failure === "probe") {
          throw new Error("runtime probe timed out");
        }
        return nodeProbeOutput(
          failure === "sealed-definition" && file !== oldNode ? "26.8.1" : "22.23.1",
        );
      });
      if (failure === "sealed-definition") {
        service.readDefinitionMutationCapability.mockRejectedValue(new Error("sealed"));
      }
      await runDaemonInstall({ json: true });
      expect(actionState.failed[0]?.message).toContain(message);
      expect(actionState.emitted).toEqual([]);
      expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
    },
  );

  it("reinstalls when the loaded service still embeds OPENCLAW_GATEWAY_TOKEN", async () => {
    const programArguments = [
      "/usr/bin/node",
      "--max-old-space-size=24576",
      "--require=/tmp/service-preload.js",
      "/usr/local/bin/openclaw",
      "gateway",
    ];
    service.isLoaded.mockResolvedValue(true);
    const managedDefinition = {
      programArguments,
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "stale-service-token",
      },
    };
    const existingCommand = {
      ...managedDefinition,
      environment: { NODE_OPTIONS: "--max-old-space-size=512" },
      managedDefinition,
      managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
    };
    service.readCommand.mockResolvedValue(existingCommand as never);

    await runDaemonInstall({ json: true });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    for (const [options] of buildGatewayInstallPlanMock.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ existingCommand }));
    }
    expect(actionState.warnings).toContain(
      "Gateway service OPENCLAW_GATEWAY_TOKEN differs from the current install plan; refreshing the install.",
    );
  });

  it("returns already-installed when the embedded gateway token matches the install plan", async () => {
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "durable-token",
      },
    } as never);
    buildGatewayInstallPlanMock.mockResolvedValueOnce({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "durable-token",
      },
    });

    await runDaemonInstall({ json: true });

    expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
    expectLastEmittedResult("already-installed");
  });

  it("preserves managed base wrapper, environment, and provenance during forced reinstall", async () => {
    for (const key of ["OPENAI_API_KEY", "OPENCLAW_WRAPPER"]) {
      delete process.env[key];
    }
    const environment = {
      OPENAI_API_KEY: "managed-service-key",
      OPENCLAW_WRAPPER: "/usr/local/bin/openclaw-doppler",
    };
    const environmentValueSources = {
      OPENAI_API_KEY: "file",
      OPENCLAW_WRAPPER: "inline",
    };
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue({
      programArguments: ["/operator/drop-in-wrapper", "gateway", "run"],
      environment: {
        OPENAI_API_KEY: "operator-drop-in-key",
        OPENCLAW_WRAPPER: "/operator/drop-in-wrapper",
      },
      environmentValueSources: { OPENAI_API_KEY: "inline" },
      managedDefinition: {
        programArguments: [environment.OPENCLAW_WRAPPER, "gateway", "run"],
        environment,
        environmentValueSources,
      },
    } as never);

    await runDaemonInstall({ json: true, force: true });

    expect(service.readCommand).toHaveBeenCalledTimes(1);
    const installPlanArg = readFirstInstallPlanArg();
    expectFields(installPlanArg, {
      wrapperPath: environment.OPENCLAW_WRAPPER,
      existingEnvironment: environment,
      existingEnvironmentValueSources: environmentValueSources,
    });
    expectFields(installPlanArg.env, environment);
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });

  it("preserves generated-service CA trust without unsafe overrides during forced reinstall", async () => {
    const extraCaCerts = "/opt/openclaw/corporate-ca.pem";
    const programArguments = [
      "/usr/bin/node",
      "--max-old-space-size=24576",
      "--require=/tmp/service-preload.js",
      "/usr/local/bin/openclaw",
      "gateway",
    ];
    for (const key of [
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "HTTPS_PROXY",
      "NODE_OPTIONS",
      "BASH_ENV",
      "LD_PRELOAD",
    ]) {
      delete process.env[key];
    }
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments,
      environment: {
        NODE_EXTRA_CA_CERTS: extraCaCerts,
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        HTTPS_PROXY: "https://attacker.invalid",
        NODE_OPTIONS: "--require /tmp/untrusted.js",
        BASH_ENV: "/tmp/untrusted.sh",
        LD_PRELOAD: "/tmp/untrusted.so",
      },
      environmentValueSources: {
        NODE_EXTRA_CA_CERTS: "file",
      },
    } as never);
    buildGatewayInstallPlanMock.mockImplementationOnce(async (params) => {
      const plan = await createInstallPlanFixture(params);
      return {
        ...plan,
        environment: {
          ...plan.environment,
          NODE_EXTRA_CA_CERTS: params?.env?.NODE_EXTRA_CA_CERTS ?? "/etc/ssl/cert.pem",
        },
      };
    });
    installDaemonServiceAndEmitMock.mockImplementationOnce(async (params?: unknown) => {
      await (params as { install: () => Promise<void> }).install();
    });

    await runDaemonInstall({ json: true, force: true });

    const installPlanArg = readFirstInstallPlanArg();
    expect(installPlanArg.existingCommand).toEqual(expect.objectContaining({ programArguments }));
    const installEnv = installPlanArg.env as Record<string, string | undefined>;
    expect(installEnv.NODE_EXTRA_CA_CERTS).toBe(extraCaCerts);
    expect(installEnv.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(installEnv.HTTPS_PROXY).toBeUndefined();
    expect(installEnv.NODE_OPTIONS).toBeUndefined();
    expect(installEnv.BASH_ENV).toBeUndefined();
    expect(installEnv.LD_PRELOAD).toBeUndefined();
    expectFields(installPlanArg.existingEnvironmentValueSources, {
      NODE_EXTRA_CA_CERTS: "file",
    });
    const installCalls = service.install.mock.calls as unknown as Array<
      [{ environment?: Record<string, string | undefined> }]
    >;
    expect(installCalls[0]?.[0].environment?.NODE_EXTRA_CA_CERTS).toBe(extraCaCerts);
  });

  it("reinstalls when wrapper command matches but wrapper env is missing", async () => {
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["/usr/local/bin/openclaw-doppler", "gateway", "run"],
      environment: {},
    } as never);

    await runDaemonInstall({
      json: true,
      wrapper: "/usr/local/bin/openclaw-doppler",
    });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    expect(actionState.warnings).toContain(
      "Gateway service OPENCLAW_WRAPPER differs from the current wrapper install plan; refreshing the install.",
    );
  });

  it("reinstalls when the embedded gateway token differs from the install plan", async () => {
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "stale-service-token",
      },
    } as never);
    buildGatewayInstallPlanMock.mockResolvedValueOnce({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "fresh-token",
      },
    });

    await runDaemonInstall({ json: true });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    expect(actionState.warnings).toContain(
      "Gateway service OPENCLAW_GATEWAY_TOKEN differs from the current install plan; refreshing the install.",
    );
  });

  it.each([
    { name: "an env file", source: "file", operatorOwned: false },
    { name: "an operator-only drop-in", source: "inline", operatorOwned: true },
  ])("does not reinstall when OPENCLAW_GATEWAY_TOKEN comes from $name", async (testCase) => {
    service.isLoaded.mockResolvedValue(true);
    const programArguments = ["openclaw", "gateway", "run"];
    service.readCommand.mockResolvedValue({
      programArguments,
      environment: { OPENCLAW_GATEWAY_TOKEN: "operator-token" },
      environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: testCase.source },
      ...(testCase.operatorOwned && {
        managedDefinition: { programArguments, environment: {} },
      }),
    } as never);

    await runDaemonInstall({ json: true });

    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
    expectLastEmittedResult("already-installed");
  });

  it("reinstalls when an existing service is missing the nvm TLS CA bundle", async () => {
    service.isLoaded.mockResolvedValue(true);
    resolveNodeStartupTlsEnvironmentMock.mockReturnValue({
      NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
      NODE_USE_SYSTEM_CA: undefined,
    });
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {},
    } as never);

    await runDaemonInstall({ json: true });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });

  it("reinstalls when the installed service still runs from nvm even if the installer runtime does not", async () => {
    service.isLoaded.mockResolvedValue(true);
    resolveNodeStartupTlsEnvironmentMock.mockImplementation(({ execPath }) => ({
      NODE_EXTRA_CA_CERTS:
        typeof execPath === "string" && execPath.includes("/.nvm/")
          ? "/etc/ssl/certs/ca-certificates.crt"
          : undefined,
      NODE_USE_SYSTEM_CA: undefined,
    }));
    service.readCommand.mockResolvedValue({
      programArguments: ["/home/test/.nvm/versions/node/v22.19.0/bin/node", "dist/entry.js"],
      environment: {},
    } as never);

    await runDaemonInstall({ json: true });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    expectFields(readFirstNodeStartupTlsEnvironmentArg(), {
      execPath: "/home/test/.nvm/versions/node/v22.19.0/bin/node",
    });
  });

  it("reuses env-backed service secrets during forced reinstall when the current shell is missing them", async () => {
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENAI_API_KEY: "service-openai-key",
      },
    } as never);
    delete process.env.OPENAI_API_KEY;
    process.env.NODE_OPTIONS = "--require /tmp/untrusted.js";
    await runDaemonInstall({ json: true, force: true });

    expectFields(readFirstInstallPlanArg().env, {
      OPENAI_API_KEY: "service-openai-key",
    });
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse stale service control env during forced reinstall", async () => {
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENCLAW_STATE_DIR: "/tmp/openclaw-doctor-manual",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-doctor-manual/openclaw.json",
        OPENCLAW_GATEWAY_TOKEN: "stale-service-token",
        PATH: "/tmp/doctor-bin:/usr/bin",
        NODE_OPTIONS: "--require /tmp/evil.js",
        OPENAI_API_KEY: "service-openai-key",
      },
    } as never);

    delete process.env.OPENAI_API_KEY;
    await runDaemonInstall({ json: true, force: true });

    expectFields(readFirstInstallPlanArg().env, {
      OPENAI_API_KEY: "service-openai-key",
    });
    const env = readFirstInstallPlanArg().env as Record<string, string | undefined>;
    expect(env.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(env.OPENCLAW_CONFIG_PATH).toBeUndefined();
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).not.toContain("/tmp/doctor-bin");
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });
});
