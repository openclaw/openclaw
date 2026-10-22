import { PassThrough } from "node:stream";
import { select as clackSelect } from "@clack/prompts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as runtimePaths from "../daemon/runtime-paths.js";
import type { GatewayService } from "../daemon/service-types.js";
import { defaultRuntime as runtime } from "../runtime.js";
import { maybeInstallDaemon } from "./configure.daemon.js";

const progressSetLabel = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn());
const resolveGatewayInstallToken = vi.hoisted(() => vi.fn());
const readPin = vi.hoisted(() =>
  vi.fn<typeof import("../daemon/runtime-pin-state.js").readDaemonRuntimePinForInstall>(),
);
// mock-isolation: Service-planning fixtures replace pin admission without opening stores or native locks.
vi.mock("../daemon/runtime-pin-state.js", () => ({
  readDaemonRuntimePinForInstall: readPin,
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, read: () => T): Promise<T> =>
    read(),
}));
const runExec = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec,
}));

const buildGatewayInstallPlan = vi.hoisted(() => vi.fn());
const note = vi.hoisted(() => vi.fn());
const service = vi.hoisted(() => ({
  isLoaded: vi.fn(async () => false),
  hasInstalledDefinition: vi.fn(async () => false),
  readCommand: vi.fn(),
  install: vi.fn<GatewayService["install"]>(async () => {}),
  uninstall: vi.fn(async () => {}),
  restart: vi.fn<() => Promise<{ outcome: "completed" | "scheduled" }>>(),
}));
const select = vi.hoisted(() =>
  vi.fn<(options: { message: string }) => Promise<string | symbol>>(async () => "node"),
);

vi.mock("../cli/progress.js", () => ({
  withProgress: vi.fn(async (_opts, run) => run({ setLabel: progressSetLabel })),
}));

// mock-isolation: Daemon configuration tests use a synthetic install plan and config.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: loadConfig,
  loadConfig,
  captureRuntimeConfigAsyncReader: () => async () => loadConfig(),
}));

// mock-isolation: Supply token-resolution outcomes without reading operator credentials.
vi.mock("./gateway-install-token.js", () => ({ resolveGatewayInstallToken }));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

// mock-isolation: Capture install diagnostics without rendering interactive terminal notes.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

vi.mock("./configure.shared.js", () => ({
  confirm: vi.fn(async () => true),
  select,
}));

vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: vi.fn(() => service),
}));

vi.mock("./systemd-linger.js", () => ({
  ensureSystemdUserLingerInteractive: vi.fn(async () => {}),
}));

function runInstall(daemonRuntime?: Parameters<typeof maybeInstallDaemon>[0]["daemonRuntime"]) {
  return maybeInstallDaemon({ port: 18789, daemonRuntime });
}

function reinstall() {
  service.isLoaded.mockResolvedValue(true);
  select.mockResolvedValueOnce("reinstall");
}

function expectUncalled(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(runtime, "exit").mockImplementation(() => {});
  readPin.mockReturnValue({ revision: "empty", stored: false });
  runExec.mockReset().mockResolvedValue({
    stdout: JSON.stringify({
      nodeVersion: "26.8.1",
      bunVersion: "1.4.3",
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    }),
    stderr: "",
  });
  service.isLoaded.mockResolvedValue(false);
  service.hasInstalledDefinition.mockResolvedValue(false);
  service.readCommand.mockResolvedValue(null);
  service.install.mockResolvedValue(undefined);
  select.mockReset().mockResolvedValue("node");
  service.restart.mockResolvedValue({ outcome: "completed" });
  loadConfig.mockReturnValue({});
  resolveGatewayInstallToken.mockResolvedValue({ warnings: [] });
  buildGatewayInstallPlan.mockResolvedValue({
    programArguments: ["openclaw", "gateway", "run"],
    workingDirectory: "/tmp",
    environment: {},
  });
});

it("blocks reinstall with unresolved auth", async () => {
  reinstall();
  resolveGatewayInstallToken.mockResolvedValue({
    unavailableReason: "gateway.auth.token SecretRef is configured but unresolved (boom).",
    warnings: [],
  });

  expect(await runInstall()).toBe("failed");
  expect(note).toHaveBeenCalledWith(
    "Gateway service install failed: Gateway install blocked: gateway.auth.token SecretRef is configured but unresolved (boom). Fix gateway auth config/token input and rerun configure.",
    "Gateway",
  );
  expectUncalled(buildGatewayInstallPlan, service.install, service.uninstall);
});

it("keeps the installed service when runtime selection is cancelled", async () => {
  reinstall();
  const cancelled = await clackSelect({
    message: "Runtime",
    options: [{ value: "node", label: "Node" }],
    signal: AbortSignal.abort(),
    input: new PassThrough(),
    output: new PassThrough(),
  });
  select.mockResolvedValueOnce(cancelled);
  vi.mocked(runtime.exit).mockImplementationOnce(() => {
    throw new Error("setup cancelled");
  });

  await expect(runInstall()).rejects.toThrow("setup cancelled");

  expect(runtime.exit).toHaveBeenCalledWith(1);
  expectUncalled(service.uninstall, resolveGatewayInstallToken, service.install);
});

it("rejects picked Node on a Bun-only host before replacing the service", async () => {
  const { buildGatewayInstallPlan: realPlan } = await vi.importActual<
    typeof import("./daemon-install-helpers.js")
  >("./daemon-install-helpers.js");
  const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
  Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.3" });
  const discoverNode = vi
    .spyOn(runtimePaths, "resolvePreferredNodePath")
    .mockResolvedValue(undefined);
  const probeBun = vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockResolvedValue({
    status: "supported",
    version: "1.4.3",
    sqliteVersion: "3.53.4",
    sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    nodeSharedSqlite: false,
  });
  reinstall();
  select.mockResolvedValueOnce("node");
  buildGatewayInstallPlan.mockImplementationOnce(realPlan);
  try {
    await expect(runInstall()).rejects.toThrow("No supported Node runtime was selected");
    expectUncalled(service.install, service.uninstall);
  } finally {
    discoverNode.mockRestore();
    probeBun.mockRestore();
    if (bunVersion) {
      Object.defineProperty(process.versions, "bun", bunVersion);
    } else {
      delete process.versions.bun;
    }
  }
});

it.each([
  ["Failed to connect to bus", true],
  ["read-only file system", false],
] as const)("handles systemd probe failure: %s", async (reason, recoverable) => {
  const message = `systemctl is-enabled unavailable: ${reason}`;
  service.isLoaded.mockRejectedValueOnce(new Error(message));
  if (recoverable) {
    await runInstall();
  } else {
    await expect(runInstall()).rejects.toThrow(message);
  }
  expect(service.install).toHaveBeenCalledTimes(recoverable ? 1 : 0);
});

it("defaults the runtime picker to recorded Bun and honors it", async () => {
  const recordedPath = "/opt/recorded/bin/bun";
  reinstall();
  service.readCommand.mockResolvedValue({
    programArguments: [recordedPath, "/app/openclaw.mjs", "gateway"],
  });
  select.mockResolvedValueOnce("bun");

  expect(await runInstall()).toBe("succeeded");

  expect(select).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Gateway service runtime",
      initialValue: "bun",
    }),
  );
  const plan = buildGatewayInstallPlan.mock.calls[0]?.[0];
  expect(plan).toMatchObject({ runtime: "bun", runtimePath: recordedPath });
  expect(plan?.pinnedRuntimePath).toBeUndefined();
});

it.each([true, false])("offers the service menu only with a definition: %s", async (installed) => {
  service.hasInstalledDefinition.mockResolvedValue(installed);
  select.mockResolvedValueOnce(installed ? "skip" : "node");
  if (installed) {
    readPin.mockImplementation(() => {
      throw new Error("unreadable pin");
    });
  }
  expect(await runInstall()).toBe(installed ? "skipped" : "succeeded");
  expect(
    select.mock.calls.some(([options]) => options.message === "Gateway service already installed"),
  ).toBe(installed);
  expect(service.install).toHaveBeenCalledTimes(installed ? 0 : 1);
  if (installed) {
    expectUncalled(service.restart, readPin, service.readCommand);
  }
});

it("shows restart scheduled when a loaded service defers restart handoff", async () => {
  service.isLoaded.mockResolvedValue(true);
  select.mockResolvedValueOnce("restart");
  service.restart.mockResolvedValueOnce({ outcome: "scheduled" });

  await runInstall();

  expect(service.restart).toHaveBeenCalledTimes(1);
  expectUncalled(readPin, service.readCommand, service.install);
  expect(progressSetLabel).toHaveBeenLastCalledWith("Gateway service restart scheduled.");
});
it.each([undefined, "node"] as const)(
  "carries installed pin intent through setup (explicit=%s)",
  async (daemonRuntime) => {
    const pin = { runtime: "bun", path: "/opt/pinned/bun" } as const;
    const expected = { revision: "installed-pin", stored: true, pin };
    const existingCommand = {
      programArguments: [pin.path, "/app/openclaw.mjs", "gateway"],
      environment: { OPENCLAW_WRAPPER: "/opt/wrapper" },
    };
    service.readCommand.mockResolvedValue(existingCommand);
    readPin.mockReturnValue(expected);
    reinstall();
    await runInstall(daemonRuntime);
    const plan = buildGatewayInstallPlan.mock.calls[0]?.[0];
    expect(plan).toEqual(
      expect.objectContaining({
        runtime: daemonRuntime ?? "bun",
        runtimeExplicit: true,
        pinnedRuntimePath: daemonRuntime ? undefined : pin.path,
        existingCommand,
        env: expect.objectContaining({ OPENCLAW_WRAPPER: "/opt/wrapper" }),
      }),
    );
    expect(plan).not.toHaveProperty("token");
    expect(service.uninstall).not.toHaveBeenCalled();
    expect(service.install.mock.calls[0]?.[0]?.runtimePinUpdate).toEqual({
      expected,
      pin: daemonRuntime ? undefined : pin,
    });
    expect(select).toHaveBeenCalledTimes(1);
  },
);
