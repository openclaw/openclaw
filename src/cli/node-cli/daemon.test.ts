import path from "node:path";
import type { DaemonRuntimePinSnapshot } from "../../daemon/runtime-pin-types.js";
const pinSnapshotMock = vi.hoisted(() =>
  vi.fn<() => DaemonRuntimePinSnapshot>(() => ({ revision: "empty", stored: false })),
);
const pinMigrationMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-pin-state.js")>()),
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, run: () => T) => {
    await pinMigrationMock();
    return run();
  },
  readDaemonRuntimePinForInstall: pinSnapshotMock,
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceInstallArgs,
} from "../../daemon/service-types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { runNodeDaemonInstall, runNodeDaemonLifecycle, runNodeDaemonStatus } from "./daemon.js";

const TLS_FINGERPRINT = "ab".repeat(32);
const NODE_RUNTIME_PATH = path.join(
  path.dirname(process.execPath),
  process.platform === "win32" ? "node.exe" : "node",
);

const mocks = vi.hoisted(() => {
  const service = {
    label: "Node service",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn(),
    install: vi.fn<(args: GatewayServiceInstallArgs) => Promise<void>>(),
    uninstall: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isLoaded: vi.fn(async () => true),
    readCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(async () => null),
    readRuntime: vi.fn<() => Promise<GatewayServiceRuntime>>(async () => ({ status: "running" })),
  };
  return {
    runtime: {
      log: vi.fn<(line: string) => void>(),
      error: vi.fn<(line: string) => void>(),
      writeJson: vi.fn(),
      exit: vi.fn(),
    },
    service,
    emitNodeRuntimeWarning: vi.fn<
      typeof import("../../commands/daemon-install-runtime-warning.js").emitNodeRuntimeWarning
    >(async () => {}),
    loadNodeHostConfig: vi.fn(),
    isSystemdUserServiceAvailable: vi.fn(async () => true),
    resolveSystemdUserServiceAccount: vi.fn<
      typeof import("../../daemon/systemd.js").resolveSystemdUserServiceAccount
    >(() => "pi"),
    readSystemdUserLingerStatus: vi.fn<
      typeof import("../../daemon/systemd.js").readSystemdUserLingerStatus
    >(async () => ({
      user: "pi",
      linger: "no",
    })),
    runServiceRestart: vi.fn(),
    runServiceStart: vi.fn(),
    runServiceStop: vi.fn(),
    runServiceUninstall: vi.fn(),
    runExec: vi.fn(),
  };
});

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: mocks.runExec,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../../daemon/node-service.js", () => ({
  resolveNodeService: () => mocks.service,
}));

vi.mock("../../commands/daemon-install-runtime-warning.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/daemon-install-runtime-warning.js")>()),
  emitNodeRuntimeWarning: mocks.emitNodeRuntimeWarning,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: {
      ...actual,
      access: async () => {},
      stat: async () => ({ isFile: () => true }),
      realpath: async (value: string) => value,
    },
  };
});

vi.mock("../../infra/device-identity-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-identity-async.js")>()),
  loadDeviceIdentityIfPresentAsync: async () => null,
}));

vi.mock("../../node-host/config.js", () => ({
  loadNodeHostConfig: mocks.loadNodeHostConfig,
}));

vi.mock("../daemon-cli/lifecycle-core.js", () => ({
  runServiceRestart: mocks.runServiceRestart,
  runServiceStart: mocks.runServiceStart,
  runServiceStop: mocks.runServiceStop,
  runServiceUninstall: mocks.runServiceUninstall,
}));

vi.mock("../../daemon/runtime-hints.js", () => ({
  buildPlatformRuntimeLogHints: () => [
    "Logs: node service log",
    "Restart attempts: node restart log",
  ],
  buildPlatformServiceStartHints: () => ["openclaw node install", "openclaw node start"],
}));

vi.mock("../../daemon/systemd.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../daemon/systemd.js")>("../../daemon/systemd.js");
  return {
    ...actual,
    isSystemdUserServiceAvailable: mocks.isSystemdUserServiceAvailable,
    resolveSystemdUserServiceAccount: mocks.resolveSystemdUserServiceAccount,
    readSystemdUserLingerStatus: mocks.readSystemdUserLingerStatus,
  };
});

vi.mock("../../../packages/terminal-core/src/theme.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../packages/terminal-core/src/theme.js")
  >("../../../packages/terminal-core/src/theme.js");
  return {
    ...actual,
    colorize: (_rich: boolean, _theme: unknown, text: string) => text,
  };
});

vi.mock("../daemon-cli/shared.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon-cli/shared.js")>("../daemon-cli/shared.js");
  return {
    ...actual,
    createCliStatusTextStyles: () => ({
      rich: false,
      label: (text: string) => text,
      accent: (text: string) => text,
      infoText: (text: string) => text,
      okText: (text: string) => text,
      warnText: (text: string) => text,
      errorText: (text: string) => text,
    }),
    formatRuntimeStatus: (runtime: GatewayServiceRuntime | undefined) => runtime?.status ?? "",
    resolveRuntimeStatusColor: () => "",
  };
});

function installedCommand(): string[] {
  const args = mocks.service.install.mock.calls[0]?.[0];
  if (!args) {
    throw new Error("Node service was not installed");
  }
  return args.programArguments;
}

function useLinuxPlatform(): void {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runNodeDaemonInstall", () => {
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
    pinMigrationMock.mockReset().mockResolvedValue(undefined);
    vi.stubEnv("OPENCLAW_NIX_MODE", undefined);
    vi.stubEnv("OPENCLAW_WRAPPER", undefined);
    mocks.runExec.mockReset().mockImplementation(async (executable: string) => ({
      stdout: JSON.stringify({
        nodeVersion: "26.8.1",
        bunVersion: /(?:^|[/\\])bun(?:\.exe)?$/i.test(executable) ? "1.4.3" : null,
        sqliteVersion: "3.53.4",
        sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      }),
      stderr: "",
    }));
    mocks.service.readCommand.mockReset().mockResolvedValue(null);
    mocks.service.install.mockReset().mockResolvedValue(undefined);
    mocks.service.isLoaded
      .mockReset()
      .mockImplementation(async () => mocks.service.install.mock.calls.length > 0);
    mocks.emitNodeRuntimeWarning.mockReset().mockResolvedValue(undefined);
    process.argv = [process.execPath, "/opt/openclaw/dist/index.js"];
    mocks.loadNodeHostConfig.mockReset().mockResolvedValue({
      gateway: {
        host: "saved-gateway.local",
        port: 18789,
        contextPath: "/saved",
        tls: true,
        tlsFingerprint: TLS_FINGERPRINT,
      },
    });
    mocks.isSystemdUserServiceAvailable.mockReset().mockResolvedValue(true);
    mocks.resolveSystemdUserServiceAccount.mockReset().mockReturnValue("pi");
    mocks.readSystemdUserLingerStatus.mockReset().mockResolvedValue({
      user: "pi",
      linger: "no",
    });
  });

  it("reports pending runtime-pin migration before reading intent or installing", async () => {
    pinMigrationMock.mockRejectedValueOnce(
      new Error("Runtime pin migration pending; run openclaw doctor."),
    );

    await runNodeDaemonInstall({ force: true });

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Runtime pin inspection failed: Runtime pin migration pending; run openclaw doctor.",
    );
    expect(pinSnapshotMock).not.toHaveBeenCalled();
    expect(mocks.service.install).not.toHaveBeenCalled();
  });

  it.each([
    { recorded: "node", runtime: undefined, probe: "supported" },
    { recorded: "bun", runtime: undefined, probe: "supported" },
    { recorded: "bun", runtime: "node", probe: "supported" },
    { recorded: "bun", runtime: "bun", probe: "supported" },
    { recorded: "bun", runtime: undefined, probe: "unsupported" },
  ] as const)(
    "reinstalls recorded $recorded ($probe) with runtime=$runtime without a pin",
    async ({ recorded, runtime, probe }) => {
      const recordedPath = `/opt/recorded/bin/${recorded}`;
      if (probe === "unsupported") {
        mocks.runExec.mockImplementation(async (executable: string) => ({
          stdout: JSON.stringify({
            nodeVersion: "26.8.1",
            bunVersion: executable === recordedPath ? "1.3.0" : null,
            sqliteVersion: "3.53.4",
            sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
          }),
          stderr: "",
        }));
      }
      mocks.service.isLoaded.mockResolvedValue(true);
      mocks.service.readCommand.mockResolvedValue({
        programArguments: [recordedPath, "/fixture/openclaw.mjs", "node", "run"],
      });
      await runNodeDaemonInstall({ force: true, runtime });
      const retained = runtime === undefined && probe === "supported";
      expect(mocks.runtime.error).not.toHaveBeenCalled();
      const command = installedCommand();
      if (retained) {
        expect(command[0]).toBe(recordedPath);
      } else {
        expect(command[0]).not.toBe(recordedPath);
        expect(command[0]).toMatch(runtime === "bun" ? /bun(?:\.exe)?$/ : /node(?:\.exe)?$/);
      }
      expect(mocks.service.install.mock.calls[0]?.[0].runtimePinUpdate).toEqual({
        expected: { revision: "empty", stored: false },
        pin: undefined,
      });
    },
  );

  it.each(["preserve", "replace", "reset"] as const)(
    "handles a runtime pin during %s node reinstall",
    async (mode) => {
      const pin = NODE_RUNTIME_PATH;
      mocks.service.isLoaded.mockResolvedValueOnce(false).mockResolvedValue(true);
      mocks.service.readCommand.mockResolvedValue({
        programArguments: [pin, "/fixture/openclaw.mjs", "node", "run"],
      });
      pinSnapshotMock.mockReturnValue({
        revision: "prior",
        stored: true,
        pin: { runtime: "node", path: mode === "preserve" ? pin : "/removed/node" },
      });
      await runNodeDaemonInstall({
        force: true,
        ...(mode === "replace" ? { runtimePath: pin } : {}),
        ...(mode === "reset" ? { runtime: "node" } : {}),
      });
      expect(mocks.runtime.error).not.toHaveBeenCalled();
      if (mode === "reset") {
        expect(installedCommand()[0]).not.toBe("/removed/node");
        expect(installedCommand()[0]).toMatch(/node(?:\.exe)?$/);
      } else {
        expect(installedCommand()[0]).toBe(pin);
      }
      expect(installedCommand()).toEqual(
        expect.arrayContaining(["--tls", "--tls-fingerprint", TLS_FINGERPRINT]),
      );
      expect(mocks.service.install.mock.calls[0]?.[0].runtimePinUpdate).toEqual({
        expected: {
          revision: "prior",
          stored: true,
          pin: { runtime: "node", path: mode === "preserve" ? pin : "/removed/node" },
        },
        pin: mode === "reset" ? undefined : { runtime: "node", path: pin },
      });
      expect(mocks.service.install).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, "", "/invoked/wrapper"])(
    "preserves managed wrapper ownership with invocation value %s",
    async (wrapper) => {
      vi.stubEnv("OPENCLAW_WRAPPER", wrapper);
      mocks.service.isLoaded.mockResolvedValue(true);
      mocks.service.readCommand.mockResolvedValue({
        programArguments: ["/override/wrapper", "node", "run"],
        environment: {
          OPENCLAW_WRAPPER: "/override/wrapper",
        },
        managedDefinition: {
          programArguments: ["/managed/wrapper", "node", "run"],
          environment: {
            OPENCLAW_WRAPPER: "/managed/wrapper",
          },
        },
      });
      pinSnapshotMock.mockReturnValue({
        revision: "prior",
        stored: true,
        pin: { runtime: "node", path: NODE_RUNTIME_PATH },
      });
      await runNodeDaemonInstall({ force: true });
      expect(mocks.runtime.error).not.toHaveBeenCalled();
      expect(installedCommand()[0]).toBe(
        wrapper === "" ? NODE_RUNTIME_PATH : path.resolve(wrapper ?? "/managed/wrapper"),
      );
      expect(installedCommand()).toEqual(
        expect.arrayContaining(["--tls", "--tls-fingerprint", TLS_FINGERPRINT]),
      );
      expect(mocks.service.install.mock.calls[0]?.[0].env.OPENCLAW_WRAPPER).toBe(
        wrapper ?? "/managed/wrapper",
      );
      expect(mocks.service.install).toHaveBeenCalledOnce();
    },
  );

  it("does not adopt an override-only pin or wrapper into the managed node service", async () => {
    vi.stubEnv("OPENCLAW_WRAPPER", undefined);
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.service.readCommand.mockResolvedValue({
      programArguments: ["/override/wrapper", "node", "run"],
      environment: {
        OPENCLAW_WRAPPER: "/override/wrapper",
      },
      managedDefinition: { programArguments: ["node", "node", "run"], environment: {} },
    });
    await runNodeDaemonInstall({ force: true });
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(installedCommand()[0]).not.toBe("/override/wrapper");
    expect(mocks.service.install.mock.calls[0]?.[0].env.OPENCLAW_WRAPPER).toBeUndefined();
    expect(mocks.service.install).toHaveBeenCalledOnce();
  });

  it("installs saved TLS and explicit command restrictions", async () => {
    await runNodeDaemonInstall({ force: true, commands: ["fixture.list", "fixture.read"] });

    expect(installedCommand().slice(2)).toEqual([
      "node",
      "run",
      "--host",
      "saved-gateway.local",
      "--port",
      "18789",
      "--tls",
      "--tls-fingerprint",
      TLS_FINGERPRINT,
      "--context-path",
      "/saved",
      "--commands",
      "fixture.list,fixture.read",
    ]);
  });

  it("forwards a full-surface reset when replacing a restricted service", async () => {
    mocks.loadNodeHostConfig.mockResolvedValue({
      gateway: { host: "saved-gateway.local", port: 18789 },
      commands: ["fixture.read"],
    });
    await runNodeDaemonInstall({ force: true, allCommands: true });
    expect(installedCommand()).toContain("--all-commands");
    expect(installedCommand()).not.toContain("--commands");
    expect(mocks.service.install).toHaveBeenCalledOnce();
  });

  it.each(["node", "bun"] as const)(
    "keeps the selected %s toolchain on the installed service PATH",
    async (runtime) => {
      const runtimePath = path.join(
        path.dirname(process.execPath),
        process.platform === "win32" ? `${runtime}.exe` : runtime,
      );
      await runNodeDaemonInstall({ force: true, runtime, runtimePath, commands: ["fixture.read"] });
      expect(installedCommand()[0]).toBe(runtimePath);
      expect(installedCommand()).toEqual(expect.arrayContaining(["--commands", "fixture.read"]));
      if (process.platform !== "win32") {
        expect(mocks.service.install.mock.calls[0]?.[0].environment?.PATH?.split(":")[0]).toBe(
          path.dirname(runtimePath),
        );
      }
    },
  );

  it("installs unpaired Gateway credentials with their file-backed source metadata", async () => {
    await withEnvAsync(
      { OPENCLAW_GATEWAY_TOKEN: "node-token", OPENCLAW_GATEWAY_PASSWORD: "node-password" },
      () => runNodeDaemonInstall({ force: true }),
    );
    const plan = mocks.service.install.mock.calls[0]?.[0];
    expect(plan?.environment?.OPENCLAW_GATEWAY_TOKEN).toBe("node-token");
    expect(plan?.environment?.OPENCLAW_GATEWAY_PASSWORD).toBe("node-password");
    expect(plan?.description).toBe("OpenClaw Node Host");
    expect(plan?.environmentValueSources).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "file",
      OPENCLAW_GATEWAY_PASSWORD: "file", // pragma: allowlist secret
      CF_ACCESS_CLIENT_ID: "file",
      CF_ACCESS_CLIENT_SECRET: "file", // pragma: allowlist secret
    });
  });

  it.each([
    {
      opts: { tls: false, tlsFingerprint: TLS_FINGERPRINT },
      error: "--no-tls cannot be combined with --tls-fingerprint",
    },
    { opts: { tlsFingerprint: "sha256:abc123" }, error: "Invalid TLS fingerprint" },
    { opts: { port: "abc" }, error: "Invalid --port" },
    { opts: { runtime: "deno" }, error: 'Invalid --runtime (use "node" or "bun"' },
  ])("rejects invalid install options $opts before building a plan", async ({ opts, error }) => {
    await runNodeDaemonInstall({ ...opts, force: true });
    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining(error));
    expect(mocks.service.install).not.toHaveBeenCalled();
  });

  it("rejects Access credentials before installing a plaintext node service", async () => {
    mocks.loadNodeHostConfig.mockResolvedValue({
      gateway: {
        host: "saved-gateway.local",
        port: 18789,
        tls: false,
        cloudflareAccess: {
          clientId: "$CF_ACCESS_CLIENT_ID",
          clientSecret: "$CF_ACCESS_CLIENT_SECRET",
        },
      },
    });

    await runNodeDaemonInstall({ force: true });

    expect(mocks.service.install).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Cloudflare Access credentials require --tls for the node Gateway connection",
    );
  });

  it.each([false, true])(
    "rejects Nix installs before config or service inspection (json=%s)",
    async (json) => {
      await withEnvAsync({ OPENCLAW_NIX_MODE: "1" }, async () => {
        await runNodeDaemonInstall({ json, force: true });
      });

      const message = "Nix mode detected; service install is disabled.";
      expect(mocks.runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(mocks.loadNodeHostConfig).not.toHaveBeenCalled();
      expect(mocks.service.isLoaded).not.toHaveBeenCalled();
      expect(mocks.service.install).not.toHaveBeenCalled();
      expect(mocks.runtime.log).not.toHaveBeenCalled();
      if (json) {
        expect(mocks.runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ action: "install", ok: false, error: message }),
        );
        expect(mocks.runtime.error).not.toHaveBeenCalled();
      } else {
        expect(mocks.runtime.error).toHaveBeenCalledExactlyOnceWith(message);
        expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      restriction: "external Gateway supervision",
      env: { OPENCLAW_SUPERVISOR_MODE: "external" },
    },
    {
      restriction: "noncanonical Gateway state",
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-node-custom-state" },
    },
  ])("does not apply $restriction to Node installation", async ({ env }) => {
    mocks.service.isLoaded.mockResolvedValueOnce(false).mockResolvedValue(true);

    await withEnvAsync(env, async () => {
      await runNodeDaemonInstall({ json: true });
    });

    expect(mocks.service.install).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "install",
        ok: true,
        result: "installed",
        service: expect.objectContaining({ label: "Node service", loaded: true }),
      }),
    );
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it.each(["enabled", "unavailable"])("omits linger warnings when %s", async (state) => {
    useLinuxPlatform();
    mocks.service.isLoaded.mockResolvedValue(true);
    if (state === "enabled") {
      mocks.readSystemdUserLingerStatus.mockResolvedValue({ user: "pi", linger: "yes" });
    } else {
      mocks.isSystemdUserServiceAvailable.mockResolvedValue(false);
    }
    await runNodeDaemonInstall({ force: true });
    expect(mocks.runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("enable-linger"));
    if (state === "unavailable") {
      expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
    }
  });

  it.each([
    { loaded: true, error: "install failed" },
    { loaded: false, error: "verification failed" },
  ])("does not add linger advice after $error (#107033)", async ({ loaded, error }) => {
    useLinuxPlatform();
    mocks.service.isLoaded.mockResolvedValue(loaded);
    if (loaded) {
      mocks.service.install.mockRejectedValue(new Error("disk full"));
    }
    await runNodeDaemonInstall({ force: true, json: true });
    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining(error),
      }),
    );
    expect(JSON.stringify(mocks.runtime.writeJson.mock.calls)).not.toContain("enable-linger");
  });

  it.each([false, true])(
    "preserves plan, native, and linger warning order (json=%s)",
    async (json) => {
      useLinuxPlatform();
      mocks.service.isLoaded.mockResolvedValue(true);
      mocks.resolveSystemdUserServiceAccount.mockReturnValue("debian");
      mocks.readSystemdUserLingerStatus.mockResolvedValue({ user: "debian", linger: "no" });
      mocks.emitNodeRuntimeWarning.mockImplementationOnce(async ({ warn }) => {
        warn?.("", "ignored plan title");
        warn?.("repeat");
        warn?.("repeat", "another ignored title");
      });
      mocks.service.install.mockImplementationOnce(async (args: GatewayServiceInstallArgs) => {
        args.warn?.("native warning");
      });
      await runNodeDaemonInstall({ force: true, json });

      expect(mocks.resolveSystemdUserServiceAccount).toHaveBeenCalledOnce();
      expect(mocks.resolveSystemdUserServiceAccount.mock.calls[0]?.[0] === process.env).toBe(true);
      expect(mocks.readSystemdUserLingerStatus).toHaveBeenCalledOnce();
      const lingerOptions = mocks.readSystemdUserLingerStatus.mock.calls[0]?.[0];
      expect(lingerOptions?.env === process.env).toBe(true);
      expect(lingerOptions?.user).toBe("debian");
      const warnings = [
        "",
        "repeat",
        "repeat",
        "native warning",
        "Systemd lingering is disabled for debian. The node service will stop when you log out. Run: sudo loginctl enable-linger debian",
      ];
      expect(mocks.runtime.log.mock.calls).toEqual(
        json
          ? []
          : [
              [""],
              ["repeat"],
              ["repeat"],
              [expect.stringContaining("Service command:")],
              ["native warning"],
              [warnings[4]],
            ],
      );
      if (json) {
        expect(mocks.runtime.writeJson).toHaveBeenCalledExactlyOnceWith({
          action: "install",
          ok: true,
          result: "installed",
          warnings,
          message: expect.stringContaining("Service command:"),
          service: {
            label: "Node service",
            loaded: true,
            loadedText: "loaded",
            notLoadedText: "not loaded",
          },
        });
      } else {
        expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
      }
      expect(mocks.runtime.error).not.toHaveBeenCalled();
      expect(mocks.runtime.exit).not.toHaveBeenCalled();
      expect(mocks.service.install).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "orders linger warning, already-installed result, and reinstall hint (json=%s)",
    async (json) => {
      useLinuxPlatform();
      mocks.service.isLoaded.mockResolvedValue(true);
      await runNodeDaemonInstall({ json });
      const warning =
        "Systemd lingering is disabled for pi. The node service will stop when you log out. Run: sudo loginctl enable-linger pi";
      const message = "Node service already loaded.";
      expect(mocks.runtime.log.mock.calls).toEqual(
        json ? [] : [[warning], [message], ["Reinstall with: openclaw node install --force"]],
      );
      expect(mocks.runtime.writeJson.mock.calls.map(([value]) => JSON.stringify(value))).toEqual(
        json
          ? [
              JSON.stringify({
                action: "install",
                ok: true,
                result: "already-installed",
                message,
                service: {
                  label: "Node service",
                  loaded: true,
                  loadedText: "loaded",
                  notLoadedText: "not loaded",
                },
                warnings: [warning],
              }),
            ]
          : [],
      );
      expect(mocks.service.install).not.toHaveBeenCalled();
    },
  );
});

describe("node daemon lifecycle adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
    mocks.runServiceRestart.mockReset();
    mocks.runServiceStart.mockReset();
    mocks.runServiceStop.mockReset();
    mocks.runServiceUninstall.mockReset();
  });

  it.each([
    {
      name: "start",
      delegate: mocks.runServiceStart,
      expected: { renderStartHints: expect.any(Function) },
    },
    {
      name: "stop",
      delegate: mocks.runServiceStop,
      expected: {},
    },
    {
      name: "restart",
      delegate: mocks.runServiceRestart,
      expected: { renderStartHints: expect.any(Function) },
    },
    {
      name: "uninstall",
      delegate: mocks.runServiceUninstall,
      expected: {
        stopBeforeUninstall: false,
        assertNotLoadedAfterUninstall: false,
      },
    },
  ] as const)(
    "delegates $name with node-specific service options",
    async ({ name, delegate, expected }) => {
      await runNodeDaemonLifecycle(name, { json: true });

      expect(delegate).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceNoun: "Node",
          service: mocks.service,
          opts: { json: true },
          ...expected,
        }),
      );
    },
  );
});

describe("runNodeDaemonStatus", () => {
  function stdout(): string {
    return mocks.runtime.log.mock.calls.map(([line]) => line).join("\n");
  }

  function stderr(): string {
    return mocks.runtime.error.mock.calls.map(([line]) => line).join("\n");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
    mocks.service.isLoaded.mockReset().mockResolvedValue(true);
    mocks.service.readCommand.mockReset().mockResolvedValue(null);
    mocks.service.readRuntime.mockReset().mockResolvedValue({ status: "running" });
  });

  it.each([false, true])(
    "reports a failed service check without inventing status (json=%s)",
    async (json) => {
      const error = new Error(
        json
          ? "systemd unavailable: Authorization: Bearer sk-abcdefghijklmnopqrstuv"
          : "systemd unavailable",
      );
      error.name = "ServiceManagerError";
      mocks.service.isLoaded.mockRejectedValue(error);
      if (json) {
        await expect(runNodeDaemonStatus({ json })).rejects.toThrow(
          "Node service check failed: systemd unavailable",
        );
        expect(mocks.runtime.exit).not.toHaveBeenCalled();
        expect(mocks.runtime.error).not.toHaveBeenCalled();
      } else {
        await runNodeDaemonStatus();
        expect(mocks.runtime.error).toHaveBeenCalledWith(
          "Node service check failed: systemd unavailable",
        );
        expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
        expect(stdout()).not.toContain("not loaded");
        expect(stdout()).not.toContain("openclaw node install");
      }
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    },
  );

  it("reports an unknown runtime when runtime inspection fails", async () => {
    const error = new Error("permission denied");
    error.name = "RuntimeInspectionError";
    mocks.service.readRuntime.mockRejectedValue(error);

    await runNodeDaemonStatus({ json: true });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      service: expect.objectContaining({
        runtime: { status: "unknown", detail: "permission denied" },
      }),
    });
    expect(JSON.stringify(mocks.runtime.writeJson.mock.calls)).not.toContain(error.name);
  });

  it.each([
    { missingUnit: true, error: "Service unit not found." },
    { missingUnit: undefined, error: "Service is loaded but not running." },
  ])("keeps $error on stderr and recovery hints on stdout", async ({ missingUnit, error }) => {
    mocks.service.readRuntime.mockResolvedValue({ status: "stopped", missingUnit });
    await runNodeDaemonStatus();
    expect(stderr()).toContain(error);
    for (const hint of ["Logs: node service log", "Restart attempts: node restart log"]) {
      expect(stdout()).toContain(hint);
      expect(stderr()).not.toContain(hint);
    }
  });

  it("redacts service credentials from JSON status output", async () => {
    const command: GatewayServiceCommandConfig = {
      programArguments: ["node", "node-host"],
      environment: {
        OPENCLAW_PROFILE: "work",
        OPENCLAW_GATEWAY_TOKEN: "gateway-token",
        OPENCLAW_GATEWAY_PASSWORD: "gateway-password",
      },
      managedDefinition: {
        programArguments: ["node", "node-host"],
        environment: { OPENCLAW_GATEWAY_TOKEN: "managed-base-token" },
      },
      managedOverrides: { launcher: "command", environment: { keys: ["OPENCLAW_GATEWAY_TOKEN"] } },
      definitionPaths: ["/etc/systemd/user/node-definition.conf"],
      environmentValueSources: { OPENCLAW_PROFILE: "file" },
      reloadPending: true,
    };
    mocks.service.readCommand.mockResolvedValue(command);

    await runNodeDaemonStatus({ json: true });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      service: expect.objectContaining({
        command: expect.objectContaining({
          environment: { OPENCLAW_PROFILE: "work" },
          definitionPaths: command.definitionPaths,
          environmentValueSources: command.environmentValueSources,
          reloadPending: true,
        }),
      }),
    });
    const payload = JSON.stringify(mocks.runtime.writeJson.mock.calls[0]?.[0]);
    expect(payload).not.toContain("gateway-token");
    expect(payload).not.toContain("gateway-password");
    expect(payload).not.toContain("managed-base-token");
    expect(payload).not.toContain("managedDefinition");
    expect(payload).not.toContain("managedOverrides");
    expect(command.environment?.OPENCLAW_GATEWAY_TOKEN).toBe("gateway-token");
    expect(command.managedDefinition).toBeDefined();
    expect(command.managedOverrides).toBeDefined();
  });
});
