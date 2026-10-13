import type { DaemonRuntimePinSnapshot } from "../../daemon/runtime-pin-types.js";
const pinSnapshotMock = vi.hoisted(() =>
  vi.fn<() => DaemonRuntimePinSnapshot>(() => ({ revision: "empty", stored: false })),
);
vi.mock("../../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-pin-state.js")>()),
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

const mocks = vi.hoisted(() => {
  const service = {
    label: "Node service",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn(),
    install: vi.fn(),
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
    buildNodeInstallPlan: vi.fn<
      typeof import("../../commands/node-daemon-install-helpers.js").buildNodeInstallPlan
    >(async () => ({
      programArguments: ["node", "node-host"],
      environment: {},
      environmentValueSources: {},
    })),
    loadNodeHostConfig: vi.fn(),
    isSystemdUserServiceAvailable: vi.fn(async () => true),
    resolveSystemdUserServiceAccount: vi.fn(() => "pi"),
    readSystemdUserLingerStatus: vi.fn(
      async (): Promise<{ user: string; linger: "yes" | "no" }> => ({
        user: "pi",
        linger: "no",
      }),
    ),
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

vi.mock("../../commands/node-daemon-install-helpers.js", () => ({
  buildNodeInstallPlan: mocks.buildNodeInstallPlan,
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

function expectPlan(expected: Record<string, unknown>): void {
  expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(expect.objectContaining(expected));
}

function useLinuxPlatform(): void {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runNodeDaemonInstall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
    vi.stubEnv("OPENCLAW_NIX_MODE", undefined);
    vi.stubEnv("OPENCLAW_WRAPPER", undefined);
    mocks.runExec.mockReset().mockImplementation(async (executable: string) => ({
      stdout: JSON.stringify({
        nodeVersion: "26.8.1",
        bunVersion: /(?:^|[/\\])bun(?:\.exe)?$/i.test(executable) ? "1.4.2" : null,
        sqliteVersion: "3.53.4",
        sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      }),
      stderr: "",
    }));
    mocks.service.readCommand.mockReset().mockResolvedValue(null);
    mocks.service.install.mockReset().mockResolvedValue(undefined);
    mocks.service.isLoaded.mockReset().mockResolvedValue(false);
    mocks.buildNodeInstallPlan.mockReset().mockResolvedValue({
      programArguments: ["node", "node-host"],
      environment: {},
      environmentValueSources: {},
    });
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
        mocks.runExec.mockResolvedValue({
          stdout: JSON.stringify({
            bunVersion: "1.3.0",
            sqliteVersion: "3.53.4",
            sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
          }),
          stderr: "",
        });
      }
      mocks.service.isLoaded.mockResolvedValue(true);
      mocks.service.readCommand.mockResolvedValue({
        programArguments: [recordedPath, "/fixture/openclaw.mjs", "node", "run"],
      });
      await runNodeDaemonInstall({ force: true, runtime });
      const retained = runtime === undefined && probe === "supported";
      expect(mocks.runtime.error).not.toHaveBeenCalled();
      const plan = mocks.buildNodeInstallPlan.mock.calls[0]?.[0];
      expect(plan?.runtime).toBe(runtime ?? (retained ? recorded : "node"));
      expect(plan?.runtimeExplicit).toBe(runtime !== undefined);
      expect(plan?.pinnedRuntimePath).toBeUndefined();
      expect(plan?.runtimePath).toBe(retained ? recordedPath : undefined);
      expect(mocks.service.install).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePinUpdate: { expected: { revision: "empty", stored: false }, pin: undefined },
        }),
      );
    },
  );

  it.each(["preserve", "replace", "reset"] as const)(
    "handles a runtime pin during %s node reinstall",
    async (mode) => {
      const pin = process.execPath;
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
      expectPlan({
        pinnedRuntimePath: mode === "reset" ? undefined : pin,
        tls: true,
        tlsFingerprint: TLS_FINGERPRINT,
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
        pin: { runtime: "node", path: process.execPath },
      });
      await runNodeDaemonInstall({ force: true });
      expect(mocks.runtime.error).not.toHaveBeenCalled();
      expectPlan({
        env: expect.objectContaining({
          OPENCLAW_WRAPPER: wrapper ?? "/managed/wrapper",
        }),
        pinnedRuntimePath: process.execPath,
        tls: true,
        tlsFingerprint: TLS_FINGERPRINT,
      });
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
    expectPlan({
      runtime: "node",
      env: expect.objectContaining({
        OPENCLAW_WRAPPER: undefined,
      }),
    });
    expect(mocks.service.install).toHaveBeenCalledOnce();
  });

  it("inherits saved TLS and forwards explicit command restrictions to the install plan", async () => {
    await runNodeDaemonInstall({ force: true, commands: ["fixture.list", "fixture.read"] });

    expectPlan({
      host: "saved-gateway.local",
      port: 18789,
      contextPath: "/saved",
      tls: true,
      tlsFingerprint: TLS_FINGERPRINT,
      commands: ["fixture.list", "fixture.read"],
    });
  });

  it("forwards a full-surface reset when replacing a restricted service", async () => {
    mocks.loadNodeHostConfig.mockResolvedValue({
      gateway: { host: "saved-gateway.local", port: 18789 },
      commands: ["fixture.read"],
    });
    await runNodeDaemonInstall({ force: true, allCommands: true });
    expectPlan({ allCommands: true, commands: undefined });
    expect(mocks.service.install).toHaveBeenCalledOnce();
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
    expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
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

    expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
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
      expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
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

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledOnce();
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
      mocks.buildNodeInstallPlan.mockImplementationOnce(async ({ warn }) => {
        warn?.("", "ignored plan title");
        warn?.("repeat");
        warn?.("repeat", "another ignored title");
        return { programArguments: ["node", "node-host"], environment: {} };
      });
      mocks.service.install.mockImplementationOnce(async (args: GatewayServiceInstallArgs) => {
        args.warn?.("native warning");
      });
      await runNodeDaemonInstall({ force: true, json });

      expect(mocks.resolveSystemdUserServiceAccount).toHaveBeenCalledWith(process.env);
      expect(mocks.readSystemdUserLingerStatus).toHaveBeenCalledWith({
        env: process.env,
        user: "debian",
      });
      const warnings = [
        "",
        "repeat",
        "repeat",
        "native warning",
        "Systemd lingering is disabled for debian. The node service will stop when you log out. Run: sudo loginctl enable-linger debian",
      ];
      expect(mocks.runtime.log.mock.calls).toEqual(
        json ? [] : warnings.map((message) => [message]),
      );
      expect(mocks.runtime.writeJson.mock.calls.map(([value]) => JSON.stringify(value))).toEqual(
        json
          ? [
              JSON.stringify({
                action: "install",
                ok: true,
                result: "installed",
                service: {
                  label: "Node service",
                  loaded: true,
                  loadedText: "loaded",
                  notLoadedText: "not loaded",
                },
                warnings,
              }),
            ]
          : [],
      );
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
      expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
      expect(mocks.service.install).not.toHaveBeenCalled();
    },
  );

  it("propagates a plan-warning sink failure before native installation", async () => {
    const failure = new Error("output unavailable");
    mocks.runtime.log.mockImplementationOnce(() => {
      throw failure;
    });
    mocks.buildNodeInstallPlan.mockImplementationOnce(async ({ warn }) => {
      warn?.("plan warning", "ignored title");
      return { programArguments: ["node", "node-host"], environment: {} };
    });
    await expect(runNodeDaemonInstall({ force: true })).rejects.toBe(failure);
    expect(mocks.runtime.log.mock.calls).toEqual([["plan warning"]]);
    expect(mocks.service.install).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("converts a native-install warning sink failure without reporting success", async () => {
    useLinuxPlatform();
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.runtime.log.mockImplementationOnce(() => {
      throw new Error("output unavailable");
    });
    mocks.service.install.mockImplementationOnce(async (args: GatewayServiceInstallArgs) => {
      args.warn?.("native warning");
    });
    await runNodeDaemonInstall({ force: true });
    expect(mocks.runtime.log.mock.calls).toEqual([["native warning"]]);
    expect(mocks.runtime.error.mock.calls).toEqual([
      ["Node install failed: Error: output unavailable"],
    ]);
    expect(mocks.runtime.exit.mock.calls).toEqual([[1]]);
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
  });

  it("propagates the final JSON sink failure without a second result", async () => {
    useLinuxPlatform();
    mocks.service.isLoaded.mockResolvedValue(true);
    const failure = new Error("JSON output unavailable");
    mocks.runtime.writeJson.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(runNodeDaemonInstall({ force: true, json: true })).rejects.toBe(failure);
    expect(mocks.service.install).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    expect(mocks.runtime.log).not.toHaveBeenCalled();
  });
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
