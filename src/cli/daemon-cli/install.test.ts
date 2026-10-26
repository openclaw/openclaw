import "./install.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ServiceStartRefusalError } from "../../daemon/service-inspection-error.js";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { nodeProbeOutput } from "./install.test-helpers.js";
import { expectNoCalls, expectPartialCall } from "./lifecycle-assertions.test-support.js";
import type { DaemonInstallOptions } from "./types.js";

const {
  actionState,
  buildGatewayInstallPlanMock,
  ensureConfigReadyMock,
  installDaemonServiceAndEmitMock,
  isGatewayDaemonRuntimeMock,
  pinSnapshotMock,
  pinMigrationMock,
  readConfigFileSnapshotMock,
  readFirstInstallPlanArg,
  replaceConfigFileMock,
  resolveGatewayAuthMock,
  resolveGatewayBindHostMock,
  resolveNodeStartupTlsEnvironmentMock,
  runDaemonInstall,
  runExecMock,
  service,
  setupInstallTests,
} = await import("./install.test-support.js");

function setConfig(config: object) {
  readConfigFileSnapshotMock.mockResolvedValue({
    exists: true,
    valid: true,
    config,
    sourceConfig: config,
  });
}

function expectFailure(...messages: string[]) {
  for (const message of messages) {
    expect(actionState.failed[0]?.message).toContain(message);
  }
}

function loadedService(command: Partial<GatewayServiceCommandConfig> = {}) {
  const installed = { programArguments: ["openclaw", "gateway", "run"], ...command };
  service.isLoaded.mockResolvedValue(true);
  service.readCommand.mockResolvedValue(installed);
  return installed;
}

async function expectReinstall(options: DaemonInstallOptions = {}) {
  await runDaemonInstall({ json: true, ...options });
  expect(installDaemonServiceAndEmitMock).toHaveBeenCalledOnce();
}

function expectNoPreparation() {
  expectNoCalls(
    ensureConfigReadyMock,
    readConfigFileSnapshotMock,
    replaceConfigFileMock,
    service.install,
  );
}

function performServiceInstall() {
  installDaemonServiceAndEmitMock.mockImplementationOnce(async (params) => {
    await (params as { install: () => Promise<void> }).install();
  });
}

describe("runDaemonInstall", () => {
  setupInstallTests();
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("runs pin admission before planning and preserves the service on refusal", async () => {
    pinMigrationMock.mockRejectedValueOnce(
      new Error("Runtime pin migration conflict; run openclaw doctor."),
    );

    await runDaemonInstall({ json: true, force: true });

    expectFailure("Runtime pin migration conflict");
    expectNoCalls(pinSnapshotMock, buildGatewayInstallPlanMock, service.install);
  });

  it.each([true, false])(
    "attests pre-write service holds only from native refusal facts (%s)",
    async (typed) => {
      const message = "Service is masked. Run `systemctl --user unmask openclaw-gateway.service`.";
      service.readCommand.mockRejectedValueOnce(
        typed ? new ServiceStartRefusalError({ reason: "masked", message }) : new Error(message),
      );

      await runDaemonInstall({ json: true, force: true });

      expect(actionState.failed[0]?.message).toBe(
        typed
          ? `SERVICE_DEFINITION_UNKNOWN: ${message}`
          : "SERVICE_DEFINITION_UNKNOWN: Service definition cannot be safely inspected.",
      );
      expectNoCalls(
        readConfigFileSnapshotMock,
        replaceConfigFileMock,
        installDaemonServiceAndEmitMock,
        service.install,
      );
    },
  );

  describe("restore service CLI", () => {
    const expected = { revision: "observed", definition: "failed-app-service", stored: true };
    const expectedRuntimePin = JSON.stringify({
      revision: expected.revision,
      definition: expected.definition,
    });
    function recoveryFixture(runtime: "node" | "bun" | "standalone" = "node") {
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
      if (runtime === "standalone") {
        fs.mkdirSync(path.join(root, "runtime"));
        fs.writeFileSync(
          path.join(root, "manifest.json"),
          JSON.stringify({
            schemaVersion: 1,
            mode: "aot",
            executable: { path: "standalone" },
            runtime: { path: "runtime" },
            openclaw: { version: "2026.10.25" },
            bun: { version: "1.4.4" },
          }),
        );
      }
      pinSnapshotMock.mockReturnValue(expected);
      return {
        executable,
        entrypoint,
        sqliteLibrary,
      };
    }
    const restore = (cli: object, options: Partial<DaemonInstallOptions> = {}) =>
      runDaemonInstall({
        json: true,
        force: true,
        runtime: "node",
        expectedRuntimePin,
        restoreServiceCli: JSON.stringify(cli),
        ...options,
      });

    it.each<[string, Partial<DaemonInstallOptions>, string]>([
      ["missing fence", { expectedRuntimePin: undefined }, "requires --expected-runtime-pin"],
      ["missing runtime", { runtime: undefined }, "requires an explicit --runtime"],
      ["mismatched pin", { runtimePath: "/another/node" }, "must match"],
      ["inherited wrapper", {}, "cannot be combined with a wrapper"],
      ["update reconciliation", {}, "update-owned reconciliation"],
      ["invalid entrypoint", {}, "Invalid restore service CLI."],
    ])("refuses %s before preparation", async (name, options, message) => {
      const cli = recoveryFixture();
      if (name === "inherited wrapper") {
        service.readCommand.mockResolvedValue({
          programArguments: [cli.executable, cli.entrypoint],
          environment: { OPENCLAW_WRAPPER: "/wrapper" },
        });
      }
      if (name === "update reconciliation") {
        process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
      }
      if (name === "invalid entrypoint") {
        cli.entrypoint = "relative/path";
      }
      await restore(cli, options);
      expectFailure(message);
      expectNoPreparation();
    });

    it.each([
      { runtime: "node", library: false },
      { runtime: "bun", library: true },
      { runtime: "standalone", library: false },
    ] as const)(
      "restores $runtime with retained library=$library and definition custody",
      async ({ runtime, library }) => {
        const files = recoveryFixture(runtime);
        const cli = {
          ...files,
          entrypoint: runtime === "standalone" ? null : files.entrypoint,
          sqliteLibrary: library ? files.sqliteLibrary : null,
        };
        process.env.OPENCLAW_SQLITE_LIBRARY = "/installer/libsqlite3.dylib";
        if (runtime !== "node") {
          const probe = nodeProbeOutput("26.12.1");
          runExecMock.mockResolvedValue({
            ...probe,
            stdout: JSON.stringify({ ...JSON.parse(probe.stdout), bunVersion: "1.4.3" }),
          });
        }
        performServiceInstall();
        await restore(cli, {
          runtime,
          ...(runtime !== "node" ? { runtimePath: cli.executable } : {}),
        });
        expect(actionState.failed).toEqual([]);
        const plan = readFirstInstallPlanArg();
        expect(plan).toMatchObject({
          serviceCli: { executable: cli.executable, entrypoint: cli.entrypoint },
          runtimePath: cli.executable,
          pinnedRuntimePath: runtime !== "node" ? cli.executable : undefined,
        });
        expectPartialCall(service.install, {
          runtimePinUpdate: {
            expected,
            pin: runtime !== "node" ? { runtime, path: cli.executable } : undefined,
            requireDefinitionMatch: true,
          },
          env: plan.env,
        });
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
      performServiceInstall();
      await runDaemonInstall({
        json: true,
        force: true,
        runtime: "node",
        expectedRuntimePin: JSON.stringify({ revision, definition }),
      });
      if (!change.startsWith("none")) {
        expectFailure("newer selection was preserved");
        expectNoPreparation();
        expectNoCalls(installDaemonServiceAndEmitMock);
        return;
      }
      expect(actionState.failed).toEqual([]);
      expect(ensureConfigReadyMock).toHaveBeenCalledOnce();
      expectPartialCall(service.install, {
        runtimePinUpdate: {
          expected: current,
          pin: undefined,
          requireDefinitionMatch: true,
          ...(definition !== null ? { requireRunning: true } : {}),
        },
      });
    },
  );

  it("rejects malformed runtime custody before preparation", async () => {
    await runDaemonInstall({ json: true, force: true, expectedRuntimePin: "invalid JSON" });
    expectFailure("Invalid expected runtime pin snapshot");
    expectNoCalls(ensureConfigReadyMock, readConfigFileSnapshotMock, service.install);
  });

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

  it.each([
    [
      "lan",
      "0.0.0.0",
      "test-token",
      [
        "Gateway install blocked",
        "gateway.bind=lan",
        "gateway.auth.mode=none",
        "openclaw config set gateway.auth.mode token",
      ],
    ],
    ["tailnet", "127.0.0.1", undefined, ["can later resolve to a Tailnet interface"]],
  ] as const)("blocks no-auth %s installation", async (bind, host, token, messages) => {
    setConfig({ gateway: { mode: "local", bind, auth: { mode: "none", token } } });
    resolveGatewayAuthMock.mockReturnValue({
      mode: "none",
      token,
      password: undefined,
      allowTailscale: false,
    });
    resolveGatewayBindHostMock.mockResolvedValue(host);
    await runDaemonInstall({ json: true });
    expectFailure(...messages);
    expectNoCalls(buildGatewayInstallPlanMock, installDaemonServiceAndEmitMock);
  });

  it("does not persist gateway mode when runtime validation fails", async () => {
    setConfig({ gateway: { auth: { mode: "token", token: "durable-token" } } });
    isGatewayDaemonRuntimeMock.mockReturnValue(false);

    await runDaemonInstall({ json: true, runtime: "bogus" });

    expectFailure("Invalid --runtime");
    expectNoCalls(replaceConfigFileMock, installDaemonServiceAndEmitMock);
  });

  it.each([
    ["Failed to connect to bus", false],
    ["read-only file system", true],
  ] as const)("handles service probe failure %s (fatal=%s)", async (message, fatal) => {
    service.isLoaded.mockRejectedValueOnce(
      new Error(`systemctl is-enabled unavailable: ${message}`),
    );
    await runDaemonInstall({ json: true });
    if (fatal) {
      expectFailure("Gateway service check failed", message);
      expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
    } else {
      expect(actionState.failed).toStrictEqual([]);
      expect(installDaemonServiceAndEmitMock).toHaveBeenCalledOnce();
    }
  });

  it("refreshes changed service start mode with local primary", async () => {
    setConfig({ gateway: { mode: "local", auth: { mode: "token" } } });
    const command = (override: boolean) =>
      ["openclaw", "gateway", "run"].concat(override ? ["--allow-unconfigured"] : []);
    const environment = { NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt" };
    resolveNodeStartupTlsEnvironmentMock.mockReturnValue(environment);
    loadedService({ programArguments: command(true), environment });
    buildGatewayInstallPlanMock.mockResolvedValue({
      programArguments: command(false),
      environment,
      workingDirectory: "/tmp",
    });
    await expectReinstall();
    expect(actionState.failed).toEqual([]);
  });

  it.each([
    { failure: "probe", message: "openclaw gateway install --force" },
    { failure: "no-replacement", message: "No supported Node runtime is available" },
  ])(
    "refuses runtime repair on $failure without claiming success",
    async ({ failure, message }) => {
      const oldNode = failure === "probe" ? resolveTestNodeExecPath() : "/opt/old/bin/node";
      loadedService({ programArguments: [oldNode, "/opt/openclaw/dist/index.js", "gateway"] });
      runExecMock.mockImplementation(async () => {
        if (failure === "probe") {
          throw new Error("runtime probe timed out");
        }
        return nodeProbeOutput("22.23.1");
      });
      await runDaemonInstall({ json: true });
      expectFailure(message);
      expect(actionState.emitted).toEqual([]);
      expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
    },
  );

  it("reinstalls when the loaded service still embeds OPENCLAW_GATEWAY_TOKEN", async () => {
    const managedDefinition = {
      programArguments: [
        "/usr/bin/node",
        "--max-old-space-size=24576",
        "--require=/tmp/service-preload.js",
        "/usr/local/bin/openclaw",
        "gateway",
      ],
      environment: { OPENCLAW_GATEWAY_TOKEN: "stale-service-token" },
    };
    const existingCommand = loadedService({
      ...managedDefinition,
      environment: { NODE_OPTIONS: "--max-old-space-size=512" },
      managedDefinition,
      managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
    });
    await expectReinstall();
    for (const [options] of buildGatewayInstallPlanMock.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ existingCommand }));
    }
    expect(actionState.warnings).toContain(
      "Gateway service OPENCLAW_GATEWAY_TOKEN differs from the current install plan; refreshing the install.",
    );
  });

  it("refreshes a loaded service when its definition is missing", async () => {
    service.isLoaded.mockResolvedValue(true);

    await expectReinstall();

    expect(actionState.warnings).toContain(
      "Gateway service definition is missing; refreshing the install.",
    );
  });

  it("returns already-installed when the embedded gateway token matches the install plan", async () => {
    const environment = { OPENCLAW_GATEWAY_TOKEN: "durable-token" };
    const command = loadedService({ environment });
    buildGatewayInstallPlanMock.mockResolvedValueOnce({
      ...command,
      environment,
      workingDirectory: "/tmp",
    });
    await runDaemonInstall({ json: true });
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
    expectNoCalls(replaceConfigFileMock, installDaemonServiceAndEmitMock);
    expect(actionState.emitted.at(-1)).toMatchObject({ result: "already-installed" });
  });

  it("reinstalls when wrapper command matches but wrapper env is missing", async () => {
    loadedService({
      programArguments: ["/usr/local/bin/openclaw-doppler", "gateway", "run"],
      environment: {},
    });

    await expectReinstall({ wrapper: "/usr/local/bin/openclaw-doppler" });
    expect(actionState.warnings).toContain(
      "Gateway service OPENCLAW_WRAPPER differs from the current wrapper install plan; refreshing the install.",
    );
  });

  it("reinstalls when the installed service still runs from nvm even if the installer runtime does not", async () => {
    const serviceNode = "/home/test/.nvm/versions/node/v22.19.0/bin/node";
    resolveNodeStartupTlsEnvironmentMock.mockImplementation(({ execPath }) => ({
      NODE_EXTRA_CA_CERTS:
        typeof execPath === "string" && execPath.includes("/.nvm/")
          ? "/etc/ssl/certs/ca-certificates.crt"
          : undefined,
      NODE_USE_SYSTEM_CA: undefined,
    }));
    loadedService({
      programArguments: [serviceNode, "dist/entry.js"],
      environment: {},
    });

    await expectReinstall();
    expect(resolveNodeStartupTlsEnvironmentMock.mock.calls[0]?.[0]).toMatchObject({
      execPath: serviceNode,
    });
  });

  describe("legacy macOS CA bundle drift check", () => {
    const staleBundleWarning =
      "Gateway service trusts the outdated macOS CA bundle; refreshing the install.";

    async function useRealDarwinResolver() {
      const actual = await vi.importActual<typeof import("../../bootstrap/node-startup-env.js")>(
        "../../bootstrap/node-startup-env.js",
      );
      resolveNodeStartupTlsEnvironmentMock.mockImplementation((params) =>
        actual.resolveNodeStartupTlsEnvironment({ ...params, platform: "darwin" }),
      );
    }

    it("reinstalls a macOS service that still trusts the legacy /etc/ssl/cert.pem bundle", async () => {
      await useRealDarwinResolver();
      loadedService({ environment: { NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem" } });

      await expectReinstall();
      expect(actionState.warnings).toContain(staleBundleWarning);
    });

    it("does not flag an operator-chosen macOS CA bundle", async () => {
      await useRealDarwinResolver();
      loadedService({ environment: { NODE_EXTRA_CA_CERTS: "/opt/corporate-ca.pem" } });

      await runDaemonInstall({ json: true });
      expect(actionState.warnings).not.toContain(staleBundleWarning);
    });
  });

  it("does not reuse stale service control env during forced reinstall", async () => {
    loadedService({
      environment: {
        OPENCLAW_STATE_DIR: "/tmp/openclaw-doctor-manual",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-doctor-manual/openclaw.json",
        OPENCLAW_GATEWAY_TOKEN: "stale-service-token",
        PATH: "/tmp/doctor-bin:/usr/bin",
        NODE_OPTIONS: "--require /tmp/evil.js",
        OPENAI_API_KEY: "service-openai-key",
      },
    });

    delete process.env.OPENAI_API_KEY;
    await expectReinstall({ force: true });

    const env = readFirstInstallPlanArg().env as Record<string, string | undefined>;
    expect(env.OPENAI_API_KEY).toBe("service-openai-key");
    for (const key of [
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "NODE_OPTIONS",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).not.toContain("/tmp/doctor-bin");
  });
});
