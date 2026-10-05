import "./install.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { nodeProbeOutput } from "./install.test-helpers.js";
import type { DaemonInstallOptions } from "./types.js";

const {
  actionState,
  buildGatewayInstallPlanMock,
  expectFields,
  expectLastEmittedResult,
  ensureConfigReadyMock,
  installDaemonServiceAndEmitMock,
  isGatewayDaemonRuntimeMock,
  pinSnapshotMock,
  readConfigFileSnapshotMock,
  readFirstInstallPlanArg,
  readFirstNodeStartupTlsEnvironmentArg,
  replaceConfigFileMock,
  resolveGatewayAuthMock,
  resolveGatewayBindHostMock,
  resolveNodeStartupTlsEnvironmentMock,
  runDaemonInstall,
  runExecMock,
  service,
  setupInstallTests,
} = await import("./install.test-support.js");

describe("runDaemonInstall", () => {
  setupInstallTests();
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  describe("restore service CLI", () => {
    const expected = { revision: "observed", definition: "failed-app-service", stored: true };
    const expectedRuntimePin = JSON.stringify({
      revision: expected.revision,
      definition: expected.definition,
    });
    function recoveryFixture(runtime: "node" | "bun" = "node") {
      const root = tempDirs.make("openclaw-restore-cli-");
      const executable = path.join(
        root,
        runtime === "node" && process.platform === "win32" ? "node.exe" : runtime,
      );
      const entrypoint = path.join(root, "openclaw.mjs");
      const sqliteLibrary = path.join(root, "libsqlite3.dylib");
      for (const file of [executable, entrypoint, sqliteLibrary]) {
        fs.writeFileSync(file, "", { mode: 0o755 });
      }
      pinSnapshotMock.mockReturnValue(expected);
      return { executable, entrypoint, sqliteLibrary };
    }
    function expectNoPreparation() {
      expect(ensureConfigReadyMock).not.toHaveBeenCalled();
      expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
      expect(replaceConfigFileMock).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
    }

    it.each<{
      name: string;
      options?: Partial<DaemonInstallOptions>;
      inheritedWrapper?: boolean;
      update?: boolean;
      message: string;
    }>([
      {
        name: "missing fence",
        options: { expectedRuntimePin: undefined },
        message: "requires --expected-runtime-pin",
      },
      {
        name: "missing runtime",
        options: { runtime: undefined },
        message: "requires an explicit --runtime",
      },
      { name: "mismatched pin", options: { runtimePath: "/another/node" }, message: "must match" },
      {
        name: "inherited wrapper",
        inheritedWrapper: true,
        message: "cannot be combined with a wrapper",
      },
      { name: "update reconciliation", update: true, message: "update-owned reconciliation" },
    ])(
      "refuses $name before preparation",
      async ({ options, inheritedWrapper, update, message }) => {
        const cli = recoveryFixture();
        if (inheritedWrapper) {
          service.readCommand.mockResolvedValue({
            programArguments: [cli.executable, cli.entrypoint],
            environment: { OPENCLAW_WRAPPER: "/wrapper" },
          });
        }
        if (update) {
          process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
        }
        await runDaemonInstall({
          json: true,
          force: true,
          runtime: "node",
          expectedRuntimePin,
          restoreServiceCli: JSON.stringify(cli),
          ...options,
        });
        expect(actionState.failed[0]?.message).toContain(message);
        expectNoPreparation();
      },
    );

    it("refuses an invalid entrypoint before preparation", async () => {
      const cli = recoveryFixture();
      cli.entrypoint = "relative/path";
      await runDaemonInstall({
        json: true,
        force: true,
        runtime: "node",
        expectedRuntimePin,
        restoreServiceCli: JSON.stringify(cli),
      });
      expect(actionState.failed[0]?.message).toContain("Invalid restore service CLI.");
      expectNoPreparation();
    });

    it.each([
      { runtime: "node", library: false },
      { runtime: "bun", library: true },
    ] as const)(
      "restores $runtime with retained library=$library and definition custody",
      async ({ runtime, library }) => {
        const files = recoveryFixture(runtime);
        const cli = { ...files, sqliteLibrary: library ? files.sqliteLibrary : null };
        process.env.OPENCLAW_SQLITE_LIBRARY = "/installer/libsqlite3.dylib";
        if (runtime === "bun") {
          const probe = nodeProbeOutput("26.8.1");
          runExecMock.mockResolvedValue({
            ...probe,
            stdout: JSON.stringify({ ...JSON.parse(probe.stdout), bunVersion: "1.4.0" }),
          });
        }
        installDaemonServiceAndEmitMock.mockImplementationOnce(async (params) => {
          await (params as { install: () => Promise<void> }).install();
        });
        await runDaemonInstall({
          json: true,
          force: true,
          runtime,
          expectedRuntimePin,
          restoreServiceCli: JSON.stringify(cli),
          ...(runtime === "bun" ? { runtimePath: cli.executable } : {}),
        });
        expect(actionState.failed).toEqual([]);
        const plan = readFirstInstallPlanArg();
        expect(plan).toMatchObject({
          serviceCli: { executable: cli.executable, entrypoint: cli.entrypoint },
          runtimePath: cli.executable,
        });
        expect(plan.pinnedRuntimePath).toBe(runtime === "bun" ? cli.executable : undefined);
        expect(service.install).toHaveBeenCalledWith(
          expect.objectContaining({
            runtimePinUpdate: {
              expected,
              pin: runtime === "bun" ? { runtime, path: cli.executable } : undefined,
              requireDefinitionMatch: true,
            },
            env: plan.env,
          }),
        );
        for (const call of runExecMock.mock.calls) {
          expect(call[2].baseEnv.OPENCLAW_SQLITE_LIBRARY).toBe(
            library ? cli.sqliteLibrary : undefined,
          );
        }
        if (library) {
          expect(plan.env).toHaveProperty("OPENCLAW_SQLITE_LIBRARY", cli.sqliteLibrary);
        } else {
          expect(plan.env).not.toHaveProperty("OPENCLAW_SQLITE_LIBRARY");
        }
        expect(process.env.OPENCLAW_SQLITE_LIBRARY).toBe("/installer/libsqlite3.dylib");
      },
    );
  });

  it.each([
    { change: "operator pin", revision: "previous-pin", definition: "current-service" },
    { change: "service definition", revision: "current-pin", definition: "previous-service" },
    { change: "none", revision: "current-pin", definition: "current-service" },
    { change: "none-absent", revision: "current-pin", definition: null },
  ])(
    "checks caller custody before config preparation when change is $change",
    async ({ change, revision, definition }) => {
      // The operator's change completed before this install subprocess captured its own snapshot.
      const current = {
        revision: "current-pin",
        definition: change === "none-absent" ? undefined : "current-service",
        stored: true,
      };
      pinSnapshotMock.mockReturnValue(current);
      installDaemonServiceAndEmitMock.mockImplementationOnce(async (params) => {
        await (params as { install: () => Promise<void> }).install();
      });
      await runDaemonInstall({
        json: true,
        force: true,
        runtime: "node",
        expectedRuntimePin: JSON.stringify({ revision, definition }),
      });
      if (!change.startsWith("none")) {
        expect(actionState.failed[0]?.message).toContain("newer selection was preserved");
        expect(ensureConfigReadyMock).not.toHaveBeenCalled();
        expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
        expect(replaceConfigFileMock).not.toHaveBeenCalled();
        expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
        expect(service.install).not.toHaveBeenCalled();
        return;
      }
      expect(actionState.failed).toEqual([]);
      expect(ensureConfigReadyMock).toHaveBeenCalledOnce();
      expect(service.install).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePinUpdate: {
            expected: current,
            pin: undefined,
            requireDefinitionMatch: true,
            ...(definition !== null ? { requireRunning: true } : {}),
          },
        }),
      );
    },
  );

  it.each(["invalid JSON"])(
    "rejects malformed runtime custody before preparation: %s",
    async (expectedRuntimePin) => {
      await runDaemonInstall({ json: true, force: true, expectedRuntimePin });
      expect(actionState.failed[0]?.message).toContain("Invalid expected runtime pin snapshot");
      expect(ensureConfigReadyMock).not.toHaveBeenCalled();
      expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
    },
  );

  it("refuses update-owned gateway defaults when authority expires during write preparation", async () => {
    const snapshot = await readConfigFileSnapshotMock();
    readConfigFileSnapshotMock.mockResolvedValue({ ...snapshot, sourceConfig: {} });
    let current = true;
    let committed = false;
    replaceConfigFileMock.mockImplementationOnce(async (params) => {
      await Promise.resolve();
      current = false;
      await params.writeOptions.beforeCommit?.();
      params.writeOptions.assertCurrent?.();
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

  it("blocks no-auth Tailnet installation even when it currently resolves to loopback", async () => {
    const config = { gateway: { mode: "local", bind: "tailnet", auth: { mode: "none" } } };
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
    resolveGatewayBindHostMock.mockResolvedValue("127.0.0.1");
    await runDaemonInstall({ json: true });
    expect(actionState.failed[0]?.message).toContain("can later resolve to a Tailnet interface");
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
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
});

describe("runDaemonInstall reinstall", () => {
  setupInstallTests();

  it.each([{ mode: "local", installedOverride: true, plannedOverride: false }])(
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
  ])(
    "refuses runtime repair on $failure without claiming success",
    async ({ failure, message }) => {
      service.isLoaded.mockResolvedValue(true);
      const oldNode = failure === "probe" ? resolveTestNodeExecPath() : "/opt/old/bin/node";
      service.readCommand.mockResolvedValue({
        programArguments: [oldNode, "/opt/openclaw/dist/index.js", "gateway"],
      });
      runExecMock.mockImplementation(async () => {
        if (failure === "probe") {
          throw new Error("runtime probe timed out");
        }
        return nodeProbeOutput("22.23.1");
      });
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
