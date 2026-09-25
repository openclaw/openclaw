import type { DaemonRuntimePinSnapshot } from "../../daemon/runtime-pin-types.js";
const pinSnapshotMock = vi.hoisted(() =>
  vi.fn<() => DaemonRuntimePinSnapshot>(() => ({ revision: "empty", stored: false })),
);
vi.mock("../../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-pin-state.js")>()),
  readDaemonRuntimePinForInstall: pinSnapshotMock,
}));
// Node daemon tests cover node daemon command runtime behavior and errors.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceInstallArgs,
} from "../../daemon/service-types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  runNodeDaemonInstall,
  runNodeDaemonRestart,
  runNodeDaemonStart,
  runNodeDaemonStatus,
  runNodeDaemonStop,
  runNodeDaemonUninstall,
} from "./daemon.js";

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
  };
});

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

function useLinuxPlatform(): void {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runNodeDaemonInstall", () => {
  beforeEach(() => {
    pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    vi.stubEnv("OPENCLAW_NIX_MODE", undefined);
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
      expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedRuntimePath: mode === "reset" ? undefined : pin,
          tls: true,
          tlsFingerprint: TLS_FINGERPRINT,
        }),
      );
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
      expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            OPENCLAW_WRAPPER: wrapper ?? "/managed/wrapper",
          }),
          pinnedRuntimePath: process.execPath,
          tls: true,
          tlsFingerprint: TLS_FINGERPRINT,
        }),
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
    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "node",
        env: expect.objectContaining({
          OPENCLAW_WRAPPER: undefined,
        }),
      }),
    );
    expect(mocks.service.install).toHaveBeenCalledOnce();
  });

  it.each([
    ["host", { host: "new-gateway.local" }],
    ["port", { port: 19_001 }],
  ])("does not inherit saved TLS when %s explicitly retargets the gateway", async (_name, opts) => {
    await runNodeDaemonInstall({ ...opts, force: true });

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        contextPath: undefined,
        tls: false,
        tlsFingerprint: undefined,
      }),
    );
  });

  it("inherits saved TLS and forwards explicit command restrictions to the install plan", async () => {
    await runNodeDaemonInstall({ force: true, commands: ["fixture.list", "fixture.read"] });

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "saved-gateway.local",
        port: 18789,
        contextPath: "/saved",
        tls: true,
        tlsFingerprint: TLS_FINGERPRINT,
        commands: ["fixture.list", "fixture.read"],
      }),
    );
  });

  it("forwards a full-surface reset when replacing a restricted service", async () => {
    mocks.loadNodeHostConfig.mockResolvedValue({
      gateway: { host: "saved-gateway.local", port: 18789 },
      commands: ["fixture.read"],
    });
    await runNodeDaemonInstall({ force: true, allCommands: true });
    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ allCommands: true, commands: undefined }),
    );
    expect(mocks.service.install).toHaveBeenCalledOnce();
  });

  it.each([
    ["host", { host: "saved-gateway.local" }],
    ["port", { port: 18_789 }],
  ])("keeps saved TLS when explicit %s resolves to the saved endpoint", async (_name, opts) => {
    await runNodeDaemonInstall({ ...opts, force: true });

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        contextPath: "/saved",
        tls: true,
        tlsFingerprint: TLS_FINGERPRINT,
      }),
    );
  });

  it("installs an explicitly plaintext node for a saved TLS gateway", async () => {
    await runNodeDaemonInstall({ force: true, tls: false });

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "saved-gateway.local",
        port: 18789,
        contextPath: "/saved",
        tls: false,
        tlsFingerprint: undefined,
      }),
    );
  });

  it("rejects a TLS fingerprint when installing an explicitly plaintext node", async () => {
    await runNodeDaemonInstall({ force: true, tls: false, tlsFingerprint: TLS_FINGERPRINT });

    expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("--no-tls cannot be combined with --tls-fingerprint"),
    );
  });

  it("rejects an invalid TLS fingerprint before building an install plan", async () => {
    await runNodeDaemonInstall({ force: true, tlsFingerprint: "sha256:abc123" });

    expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid TLS fingerprint"),
    );
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

  it.each([
    ["an invalid explicit port", { port: "abc" }, "Invalid --port"],
    ["an unsupported runtime", { runtime: "deno" }, 'Invalid --runtime (use "node" or "bun"'],
  ])("rejects %s before building an install plan", async (_name, opts, error) => {
    await runNodeDaemonInstall(opts);

    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining(error));
    expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
    expect(mocks.service.install).not.toHaveBeenCalled();
  });

  it("forwards Bun as the explicit node-service runtime", async () => {
    await runNodeDaemonInstall({ runtime: "bun", force: true });

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "bun" }),
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

  it("warns about disabled systemd lingering after a fresh install (text mode)", async () => {
    useLinuxPlatform();
    // isLoaded=true so the service-load verification passes and the linger
    // diagnostic runs on the verified-success path.
    mocks.service.isLoaded.mockResolvedValue(true);
    await runNodeDaemonInstall({ force: true });

    expect(mocks.readSystemdUserLingerStatus).toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("sudo loginctl enable-linger pi"),
    );
  });

  it("checks lingering for the same sudo target user as the systemd service", async () => {
    useLinuxPlatform();
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.resolveSystemdUserServiceAccount.mockReturnValue("debian");
    mocks.readSystemdUserLingerStatus.mockResolvedValue({ user: "debian", linger: "no" });

    await runNodeDaemonInstall({ force: true });

    expect(mocks.resolveSystemdUserServiceAccount).toHaveBeenCalledWith(process.env);
    expect(mocks.readSystemdUserLingerStatus).toHaveBeenCalledWith({
      env: process.env,
      user: "debian",
    });
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("sudo loginctl enable-linger debian"),
    );
  });

  it("includes the linger warning in JSON warnings after a fresh install", async () => {
    useLinuxPlatform();
    mocks.service.isLoaded.mockResolvedValue(true);
    await runNodeDaemonInstall({ force: true, json: true });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        warnings: expect.arrayContaining([expect.stringContaining("enable-linger pi")]),
      }),
    );
  });

  it("warns about disabled lingering on the already-installed short-circuit path", async () => {
    useLinuxPlatform();
    mocks.service.isLoaded.mockResolvedValue(true);
    await runNodeDaemonInstall({ force: false });

    expect(mocks.readSystemdUserLingerStatus).toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("sudo loginctl enable-linger pi"),
    );
  });

  it("does not warn when systemd lingering is already enabled", async () => {
    useLinuxPlatform();
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.readSystemdUserLingerStatus.mockResolvedValue({ user: "pi", linger: "yes" });
    await runNodeDaemonInstall({ force: true });

    expect(mocks.runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("enable-linger"));
  });

  it("does not pollute the failure output when service.install throws", async () => {
    useLinuxPlatform();
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.service.install.mockRejectedValue(new Error("disk full"));
    await runNodeDaemonInstall({ force: true, json: true });

    // install() threw before verification, so onVerified never runs and no
    // linger warning accompanies the install-failure payload.
    const calls = mocks.runtime.writeJson.mock.calls;
    const failurePayload = calls
      .map(([payload]) => payload as { ok?: boolean; error?: string; warnings?: string[] })
      .find((payload) => payload.ok === false);
    expect(failurePayload).toBeDefined();
    expect(failurePayload?.error).toContain("install failed");
    expect(failurePayload?.warnings ?? []).toEqual(
      expect.not.arrayContaining([expect.stringContaining("enable-linger")]),
    );
  });

  it("does not warn when service-load verification fails (regression for #107033 review)", async () => {
    useLinuxPlatform();
    // install() succeeded but the service is not loaded: the linger diagnostic
    // must NOT run, so a failed verification never tells the operator to fix
    // lingering for a service that was not successfully installed.
    mocks.service.isLoaded.mockResolvedValue(false);
    await runNodeDaemonInstall({ force: true, json: true });

    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
    const calls = mocks.runtime.writeJson.mock.calls;
    const failurePayload = calls
      .map(([payload]) => payload as { ok?: boolean; error?: string; warnings?: string[] })
      .find((payload) => payload.ok === false);
    expect(failurePayload).toBeDefined();
    expect(failurePayload?.error).toContain("verification failed");
    expect(failurePayload?.warnings ?? []).toEqual(
      expect.not.arrayContaining([expect.stringContaining("enable-linger")]),
    );
  });

  it("skips the linger check when systemd user services are unavailable", async () => {
    useLinuxPlatform();
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.isSystemdUserServiceAvailable.mockResolvedValue(false);
    await runNodeDaemonInstall({ force: true });

    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves plan, native, and linger warning order (json=%s)",
    async (json) => {
      useLinuxPlatform();
      mocks.service.isLoaded.mockResolvedValue(true);
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

      const warnings = [
        "",
        "repeat",
        "repeat",
        "native warning",
        "Systemd lingering is disabled for pi. The node service will stop when you log out. Run: sudo loginctl enable-linger pi",
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
    pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
    mocks.runServiceRestart.mockReset();
    mocks.runServiceStart.mockReset();
    mocks.runServiceStop.mockReset();
    mocks.runServiceUninstall.mockReset();
  });

  it.each([
    {
      name: "start",
      action: runNodeDaemonStart,
      delegate: mocks.runServiceStart,
      expected: { renderStartHints: expect.any(Function) },
    },
    {
      name: "stop",
      action: runNodeDaemonStop,
      delegate: mocks.runServiceStop,
      expected: {},
    },
    {
      name: "restart",
      action: runNodeDaemonRestart,
      delegate: mocks.runServiceRestart,
      expected: { renderStartHints: expect.any(Function) },
    },
    {
      name: "uninstall",
      action: runNodeDaemonUninstall,
      delegate: mocks.runServiceUninstall,
      expected: {
        stopBeforeUninstall: false,
        assertNotLoadedAfterUninstall: false,
      },
    },
  ])(
    "delegates $name with node-specific service options",
    async ({ action, delegate, expected }) => {
      await action({ json: true });

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
    pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    mocks.service.isLoaded.mockReset().mockResolvedValue(true);
    mocks.service.readCommand.mockReset().mockResolvedValue(null);
    mocks.service.readRuntime.mockReset().mockResolvedValue({ status: "running" });
  });

  it("reports a failed service check instead of claiming the node is not installed", async () => {
    mocks.service.isLoaded.mockRejectedValue(new Error("systemd unavailable"));

    await runNodeDaemonStatus();

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Node service check failed: systemd unavailable",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(stdout()).not.toContain("not loaded");
    expect(stdout()).not.toContain("openclaw node install");
  });

  it("reports a failed service check as JSON without inventing node status", async () => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    const error = new Error(`systemd unavailable: Authorization: Bearer ${secret}`);
    error.name = "ServiceManagerError";
    mocks.service.isLoaded.mockRejectedValue(error);

    await expect(runNodeDaemonStatus({ json: true })).rejects.toThrow(
      "Node service check failed: systemd unavailable",
    );

    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    expect(mocks.runtime.error).not.toHaveBeenCalled();
  });

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

  it("keeps missing service-unit status on stderr and prints recovery hints on stdout", async () => {
    mocks.service.readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });

    await runNodeDaemonStatus();

    expect(stderr()).toContain("Service unit not found.");
    expect(stdout()).toContain("Logs: node service log");
    expect(stdout()).toContain("Restart attempts: node restart log");
    expect(stderr()).not.toContain("Logs: node service log");
    expect(stderr()).not.toContain("Restart attempts: node restart log");
  });

  it("keeps stopped status on stderr and prints recovery hints on stdout", async () => {
    mocks.service.readRuntime.mockResolvedValue({ status: "stopped" });

    await runNodeDaemonStatus();

    expect(stderr()).toContain("Service is loaded but not running.");
    expect(stdout()).toContain("Logs: node service log");
    expect(stdout()).toContain("Restart attempts: node restart log");
    expect(stderr()).not.toContain("Logs: node service log");
    expect(stderr()).not.toContain("Restart attempts: node restart log");
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
