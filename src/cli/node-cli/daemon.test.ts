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
const runtimePath = (runtime: "node" | "bun") =>
  path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? `${runtime}.exe` : runtime,
  );
const NODE_RUNTIME_PATH = runtimePath("node");

const mocks = vi.hoisted(() => {
  const service = {
    label: "Node service",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    install: vi.fn<(args: GatewayServiceInstallArgs) => Promise<void>>(),
    isLoaded: vi.fn<() => Promise<boolean>>(),
    readCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(),
    readRuntime: vi.fn<() => Promise<GatewayServiceRuntime>>(),
  };
  return {
    runtime: {
      log: vi.fn<(line: string) => void>(),
      error: vi.fn<(line: string) => void>(),
      writeJson: vi.fn(),
      exit: vi.fn(),
    },
    service,
    emitNodeRuntimeWarning:
      vi.fn<
        typeof import("../../commands/daemon-install-runtime-warning.js").emitNodeRuntimeWarning
      >(),
    loadNodeHostConfig: vi.fn(),
    isSystemdUserServiceAvailable: vi.fn<() => Promise<boolean>>(),
    resolveSystemdUserServiceAccount:
      vi.fn<typeof import("../../daemon/systemd.js").resolveSystemdUserServiceAccount>(),
    readSystemdUserLingerStatus:
      vi.fn<typeof import("../../daemon/systemd.js").readSystemdUserLingerStatus>(),
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
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
vi.mock("../../daemon/node-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/node-service.js")>()),
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
vi.mock("../../node-host/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../node-host/config.js")>()),
  loadNodeHostConfig: mocks.loadNodeHostConfig,
}));
vi.mock("../daemon-cli/lifecycle-core.js", () => ({
  runServiceRestart: mocks.runServiceRestart,
  runServiceStart: mocks.runServiceStart,
  runServiceStop: mocks.runServiceStop,
  runServiceUninstall: mocks.runServiceUninstall,
}));
vi.mock("../../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd.js")>()),
  isSystemdUserServiceAvailable: mocks.isSystemdUserServiceAvailable,
  resolveSystemdUserServiceAccount: mocks.resolveSystemdUserServiceAccount,
  readSystemdUserLingerStatus: mocks.readSystemdUserLingerStatus,
}));

const installedCommand = () => installedPlan().programArguments;

function installedPlan() {
  expect(mocks.service.install).toHaveBeenCalledOnce();
  expect(mocks.runtime.error).not.toHaveBeenCalled();
  return mocks.service.install.mock.calls[0]![0];
}

const useLinuxPlatform = () => vi.spyOn(process, "platform", "get").mockReturnValue("linux");

function runtimeProbe(bunVersion: string | null) {
  return {
    stdout: JSON.stringify({
      nodeVersion: "26.12.1",
      bunVersion,
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    }),
    stderr: "",
  };
}

function runtimePin(executable: string): DaemonRuntimePinSnapshot {
  return { revision: "prior", stored: true, pin: { runtime: "node", path: executable } };
}

function expectJson(payload: object) {
  expect(mocks.runtime.writeJson).toHaveBeenCalledWith(expect.objectContaining(payload));
}

beforeEach(() => {
  vi.resetAllMocks();
  pinSnapshotMock.mockReturnValue({ revision: "empty", stored: false });
});

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
    pinMigrationMock.mockResolvedValue(undefined);
    vi.stubEnv("OPENCLAW_NIX_MODE", undefined);
    vi.stubEnv("OPENCLAW_WRAPPER", undefined);
    mocks.runExec.mockImplementation(async (executable: string) =>
      runtimeProbe(/(?:^|[/\\])bun(?:\.exe)?$/i.test(executable) ? "1.4.3" : null),
    );
    mocks.service.readCommand.mockResolvedValue(null);
    mocks.service.install.mockResolvedValue(undefined);
    mocks.service.isLoaded.mockImplementation(
      async () => mocks.service.install.mock.calls.length > 0,
    );
    mocks.emitNodeRuntimeWarning.mockResolvedValue(undefined);
    process.argv = [process.execPath, "/opt/openclaw/dist/index.js"];
    mocks.loadNodeHostConfig.mockResolvedValue({
      gateway: {
        host: "saved-gateway.local",
        port: 18789,
        contextPath: "/saved",
        tls: true,
        tlsFingerprint: TLS_FINGERPRINT,
      },
      commands: ["fixture.read"],
    });
    mocks.isSystemdUserServiceAvailable.mockResolvedValue(true);
    mocks.resolveSystemdUserServiceAccount.mockReturnValue("pi");
    mocks.readSystemdUserLingerStatus.mockResolvedValue({ user: "pi", linger: "no" });
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
        mocks.runExec.mockImplementation(async (executable: string) =>
          runtimeProbe(executable === recordedPath ? "1.3.0" : null),
        );
      }
      mocks.service.isLoaded.mockResolvedValue(true);
      mocks.service.readCommand.mockResolvedValue({ programArguments: [recordedPath] });
      await runNodeDaemonInstall({ force: true, runtime });
      const retained = runtime === undefined && probe === "supported";
      const command = installedCommand();
      if (retained) {
        expect(command[0]).toBe(recordedPath);
      } else {
        expect(command[0]).not.toBe(recordedPath);
        expect(command[0]).toMatch(runtime === "bun" ? /bun(?:\.exe)?$/ : /node(?:\.exe)?$/);
      }
      expect(installedPlan().runtimePinUpdate).toEqual({
        expected: { revision: "empty", stored: false },
        pin: undefined,
      });
    },
  );

  it.each(["preserve", "replace", "reset"] as const)(
    "handles a runtime pin during %s node reinstall",
    async (mode) => {
      const runtime = mode === "replace" ? "bun" : "node";
      const pin = runtimePath(runtime);
      const snapshot = runtimePin(mode === "preserve" ? pin : "/removed/node");
      mocks.service.isLoaded.mockResolvedValueOnce(false).mockResolvedValue(true);
      pinSnapshotMock.mockReturnValue(snapshot);
      await runNodeDaemonInstall({
        force: true,
        ...(mode === "replace" ? { runtime, runtimePath: pin } : {}),
        ...(mode === "reset" ? { runtime: "node" } : {}),
      });
      if (mode === "reset") {
        expect(installedCommand()[0]).not.toBe("/removed/node");
        expect(installedCommand()[0]).toMatch(/node(?:\.exe)?$/);
      } else {
        expect(installedCommand()[0]).toBe(pin);
      }
      expect(installedPlan().runtimePinUpdate).toEqual({
        expected: runtimePin(mode === "preserve" ? pin : "/removed/node"),
        pin: mode === "reset" ? undefined : { runtime, path: pin },
      });
      if (mode !== "reset" && process.platform !== "win32") {
        expect(installedPlan().environment?.PATH?.split(":")[0]).toBe(path.dirname(pin));
      }
    },
  );

  it.each([
    [undefined, "/managed/wrapper"],
    ["", "/managed/wrapper"],
    ["/invoked/wrapper", "/managed/wrapper"],
    [undefined, undefined],
  ])("selects wrapper %s with managed wrapper %s", async (wrapper, managed) => {
    vi.stubEnv("OPENCLAW_WRAPPER", wrapper);
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.service.readCommand.mockResolvedValue({
      programArguments: ["/override/wrapper", "node", "run"],
      environment: { OPENCLAW_WRAPPER: "/override/wrapper" },
      managedDefinition: {
        programArguments: [managed ?? "node", "node", "run"],
        environment: managed ? { OPENCLAW_WRAPPER: managed } : {},
      },
    });
    if (managed) {
      pinSnapshotMock.mockReturnValue(runtimePin(NODE_RUNTIME_PATH));
    }
    await runNodeDaemonInstall({ force: true });
    const selected = wrapper ?? managed;
    if (selected === undefined) {
      expect(installedCommand()[0]).not.toBe("/override/wrapper");
    } else {
      expect(installedCommand()[0]).toBe(
        selected === "" ? NODE_RUNTIME_PATH : path.resolve(selected),
      );
    }
    expect(installedPlan().env.OPENCLAW_WRAPPER).toBe(selected);
  });

  it.each([false, true])("forwards saved TLS and command selection (all=%s)", async (all) => {
    await runNodeDaemonInstall({
      force: true,
      ...(all ? { allCommands: true } : { commands: ["fixture.list"] }),
    });
    const command = installedCommand();
    const endpoint = ["--host", "saved-gateway.local", "--port", "18789"];
    const selection = all ? ["--all-commands"] : ["--commands", "fixture.list"];
    expect(command).toEqual(
      expect.arrayContaining([
        ...endpoint,
        ...selection,
        "--tls",
        "--tls-fingerprint",
        TLS_FINGERPRINT,
        "--context-path",
        "/saved",
      ]),
    );
    if (all) {
      expect(command).not.toContain("--commands");
    } else {
      expect(command).not.toContain("--all-commands");
    }
  });

  it("installs unpaired Gateway credentials with their file-backed source metadata", async () => {
    await withEnvAsync(
      { OPENCLAW_GATEWAY_TOKEN: "node-token", OPENCLAW_GATEWAY_PASSWORD: "node-password" },
      () => runNodeDaemonInstall({ force: true }),
    );
    const plan = installedPlan();
    expect(plan.environment?.OPENCLAW_GATEWAY_TOKEN).toBe("node-token");
    expect(plan.environment?.OPENCLAW_GATEWAY_PASSWORD).toBe("node-password");
    expect(plan.environmentValueSources).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "file",
      OPENCLAW_GATEWAY_PASSWORD: "file", // pragma: allowlist secret
      CF_ACCESS_CLIENT_ID: "file",
      CF_ACCESS_CLIENT_SECRET: "file", // pragma: allowlist secret
    });
  });

  it.each([
    [{ tls: false, tlsFingerprint: TLS_FINGERPRINT }, "--no-tls cannot be combined"],
    [{ tlsFingerprint: "sha256:abc123" }, "Invalid TLS fingerprint"],
    [{ port: "abc" }, "Invalid --port"],
    [{ runtime: "deno" }, "Invalid --runtime"],
    [{}, "Runtime pin inspection failed"],
    [{ tls: false }, "Cloudflare Access credentials require --tls"],
  ] as const)("rejects installation: %j / %s", async (opts, error) => {
    if (error === "Runtime pin inspection failed") {
      pinMigrationMock.mockRejectedValueOnce(
        new Error("Runtime pin migration pending; run openclaw doctor."),
      );
    }
    if (error === "Cloudflare Access credentials require --tls") {
      mocks.loadNodeHostConfig.mockResolvedValue({
        gateway: {
          host: "saved-gateway.local",
          port: 18789,
          cloudflareAccess: {
            clientId: "$CF_ACCESS_CLIENT_ID",
            clientSecret: "$CF_ACCESS_CLIENT_SECRET",
          },
        },
      });
    }
    await runNodeDaemonInstall({ ...opts, force: true });
    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining(error));
    expect(mocks.service.install).not.toHaveBeenCalled();
  });

  it.each([
    [{ OPENCLAW_NIX_MODE: "1" }, false, false],
    [{ OPENCLAW_NIX_MODE: "1" }, true, false],
    [{ OPENCLAW_SUPERVISOR_MODE: "external" }, true, true],
    [{ OPENCLAW_STATE_DIR: "/tmp/openclaw-node-custom-state" }, true, true],
  ] as const)("applies Node install policy for %j (json=%s)", async (env, json, allowed) => {
    await withEnvAsync(env, () => runNodeDaemonInstall({ json }));
    expect(mocks.service.install).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) {
      expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    } else {
      expect(mocks.runtime.exit).not.toHaveBeenCalled();
    }
    if (json) {
      expectJson({ ok: allowed });
    } else {
      expect(mocks.runtime.error).toHaveBeenCalledWith(
        "Nix mode detected; service install is disabled.",
      );
    }
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
    expectJson({ ok: false, error: expect.stringContaining(error) });
    expect(JSON.stringify(mocks.runtime.writeJson.mock.calls)).not.toContain("enable-linger");
  });

  it.each([
    { force: true, json: false },
    { force: true, json: true },
    { force: false, json: false },
    { force: false, json: true },
  ])("orders node install advice (force=$force, json=$json)", async ({ force, json }) => {
    useLinuxPlatform();
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.emitNodeRuntimeWarning.mockImplementationOnce(async ({ warn }) => {
      warn?.("plan warning");
    });
    mocks.service.install.mockImplementationOnce(async (args) => {
      args.warn?.("native warning");
    });
    await runNodeDaemonInstall({ force, json });
    const warning =
      "Systemd lingering is disabled for pi. The node service will stop when you log out. Run: sudo loginctl enable-linger pi";
    const message = force
      ? expect.stringContaining("Service command:")
      : "Node service already loaded.";
    const warnings = force ? ["plan warning", "native warning", warning] : [warning];
    if (json) {
      expectJson({
        ok: true,
        result: force ? "installed" : "already-installed",
        message,
        warnings,
      });
    } else {
      const lines = force
        ? ["plan warning", message, "native warning", warning]
        : [warning, message, "Reinstall with: openclaw node install --force"];
      expect(mocks.runtime.log.mock.calls).toEqual(lines.map((line) => [line]));
    }
    expect(mocks.service.install).toHaveBeenCalledTimes(force ? 1 : 0);
  });
});

it.each([
  ["start", mocks.runServiceStart],
  ["stop", mocks.runServiceStop],
  ["restart", mocks.runServiceRestart],
  ["uninstall", mocks.runServiceUninstall],
] as const)("delegates %s with node-specific service options", async (name, delegate) => {
  await runNodeDaemonLifecycle(name, { json: true });

  expect(delegate).toHaveBeenCalledWith(
    expect.objectContaining({
      serviceNoun: "Node",
      service: mocks.service,
      opts: { json: true },
      ...(name === "uninstall"
        ? { stopBeforeUninstall: false, assertNotLoadedAfterUninstall: false }
        : {}),
    }),
  );
});

describe("runNodeDaemonStatus", () => {
  function output(stream: "log" | "error"): string {
    return mocks.runtime[stream].mock.calls.map(([line]) => line).join("\n");
  }

  beforeEach(() => {
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.service.readCommand.mockResolvedValue(null);
    mocks.service.readRuntime.mockResolvedValue({ status: "running" });
  });

  it.each([
    { layer: "service", json: false },
    { layer: "service", json: true },
    { layer: "runtime", json: true },
  ])("reports $layer inspection failure (json=$json)", async ({ layer, json }) => {
    const error = new Error(
      layer === "service" && json
        ? "systemd unavailable: Authorization: Bearer sk-abcdefghijklmnopqrstuv"
        : "systemd unavailable",
    );
    error.name = "InspectionError";
    if (layer === "runtime") {
      mocks.service.readRuntime.mockRejectedValue(error);
      await runNodeDaemonStatus({ json });
      expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
        service: expect.objectContaining({
          runtime: { status: "unknown", detail: "systemd unavailable" },
        }),
      });
      expect(JSON.stringify(mocks.runtime.writeJson.mock.calls)).not.toContain(error.name);
      return;
    }
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
      expect(output("log")).not.toContain("not loaded");
      expect(output("log")).not.toContain("openclaw node install");
    }
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it.each([
    { missingUnit: true, error: "Service unit not found." },
    { missingUnit: undefined, error: "Service is loaded but not running." },
  ])("keeps $error on stderr and recovery hints on stdout", async ({ missingUnit, error }) => {
    useLinuxPlatform();
    mocks.service.readRuntime.mockResolvedValue({ status: "stopped", missingUnit });
    await runNodeDaemonStatus();
    expect(output("error")).toContain(error);
    for (const hint of ["Logs: journalctl --user -u", "Restart attempts:"]) {
      expect(output("log")).toContain(hint);
      expect(output("error")).not.toContain(hint);
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
    };
    mocks.service.readCommand.mockResolvedValue(command);
    await runNodeDaemonStatus({ json: true });
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      service: expect.objectContaining({
        command: expect.objectContaining({
          environment: { OPENCLAW_PROFILE: "work" },
        }),
      }),
    });
    const payload = JSON.stringify(mocks.runtime.writeJson.mock.calls[0]?.[0]);
    expect(payload).not.toMatch(
      /gateway-token|gateway-password|managed-base-token|managedDefinition|managedOverrides/,
    );
  });
});
