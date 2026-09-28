// Gateway install output contracts use the real install, shared-context and response owners.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServiceEnvironment } from "../../daemon/service-env.js";
import type { GatewayServiceInstallArgs } from "../../daemon/service-types.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { systemdManagerVersionProbe } from "../../daemon/systemd-user-bus.test-support.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { captureEnv } from "../../test-utils/env.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();
const busctl = vi.hoisted(() =>
  vi.fn<typeof import("../../daemon/systemd-exec.js").execBusctlUser>(),
);
vi.mock("../../daemon/systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-exec.js")>()),
  execBusctlUser: busctl,
}));
vi.mock("../../daemon/systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-system.js")>()),
  assertNoSystemSystemdOwnership: async () => {},
}));

const serviceMock = vi.hoisted(() => ({
  label: "Gateway",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  stage: vi.fn(async (_opts?: { environment?: Record<string, string | undefined> }) => {}),
  install: vi.fn(async (_opts?: GatewayServiceInstallArgs) => {}),
  uninstall: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  restart: vi.fn(async () => {}),
  isLoaded: vi.fn(async () => false),
  readDefinitionMutationCapability: vi.fn<
    (args?: {
      env?: NodeJS.ProcessEnv;
      environment?: NodeJS.ProcessEnv;
    }) => Promise<import("../../daemon/service-types.js").ServiceDefinitionMutationCapability>
  >(async (_args?: { env?: NodeJS.ProcessEnv; environment?: NodeJS.ProcessEnv }) => ({
    kind: "writable" as const,
  })),
  readCommand: vi.fn<
    typeof import("../../daemon/systemd-service-files.js").readSystemdServiceExecStart
  >(async () => null),
  readRuntime: vi.fn(async () => ({ status: "stopped" as const })),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => serviceMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

const systemNodeInfo = vi.hoisted(() =>
  vi.fn<typeof import("../../daemon/runtime-paths.js").resolveSystemNodeInfo>(),
);
vi.mock("../../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-paths.js")>()),
  resolveSystemNodeInfo: systemNodeInfo,
}));

const daemonExec = await import("../../daemon/exec-file.js");
const { runDaemonInstall } = await import("./install.js");
const { clearConfigCache, clearRuntimeConfigSnapshot, readConfigFileSnapshot } =
  await import("../../config/config.js");

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function createInstalledServiceCommand() {
  // An installed service has already observed its config; include that health store in snapshots.
  await readConfigFileSnapshot();
  const programArguments = ["openclaw", "gateway", "run"];
  const environment = buildServiceEnvironment({
    env: process.env,
    port: 18789,
    execPath: programArguments[0],
  });
  return {
    programArguments,
    // Service readers return only persisted strings, including the host's required TLS CA bundle.
    environment: Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
}

describe("runDaemonInstall integration", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let accountHome: string;
  let tempHome: string;
  let configPath: string;

  beforeAll(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "DBUS_SESSION_BUS_ADDRESS",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]);
    accountHome = await makeTempWorkspace("openclaw-daemon-install-int-");
    tempHome = path.join(accountHome, ".openclaw");
    await fs.mkdir(tempHome);
    configPath = path.join(tempHome, "openclaw.json");
    process.env.HOME = accountHome;
    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(accountHome, "bus")}`;
    process.env.OPENCLAW_STATE_DIR = tempHome;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
  });

  afterAll(async () => {
    envSnapshot.restore();
    await fs.rm(accountHome, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Output contracts control host inventory, not the real warning or response owners.
    systemNodeInfo.mockResolvedValue({
      path: "/fixture/system/node",
      status: "supported",
      version: "26.8.2",
      sqliteVersion: "3.53.4",
      nodeSharedSqlite: false,
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    });
    mockSystemAccountHome();
    vi.spyOn(daemonExec, "execFileUtf8").mockImplementation(systemdManagerVersionProbe);
    resetRuntimeCapture();
    clearRuntimeConfigSnapshot();
    // Keep these defined-but-empty so dotenv won't repopulate from local .env.
    process.env.OPENCLAW_GATEWAY_TOKEN = "";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "";
    serviceMock.isLoaded.mockResolvedValue(false);
    serviceMock.install.mockReset();
    serviceMock.install.mockResolvedValue(undefined);
    serviceMock.readDefinitionMutationCapability.mockReset();
    serviceMock.readDefinitionMutationCapability.mockResolvedValue({ kind: "writable" });
    serviceMock.readCommand.mockReset();
    serviceMock.readCommand.mockResolvedValue(null);
    await fs.writeFile(configPath, JSON.stringify({}, null, 2));
    clearConfigCache();
  });

  it.each([false, true])(
    "orders Gateway mode warning, installed result, and reinstall hint (json=%s)",
    async (json) => {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          gateway: { auth: { mode: "token", token: "existing-token" } },
        }),
      );
      clearConfigCache();
      serviceMock.isLoaded.mockResolvedValue(true);
      serviceMock.readCommand.mockResolvedValue(await createInstalledServiceCommand());

      await runDaemonInstall({ json });

      const warning = "No gateway.mode found. Set gateway.mode=local for managed gateway install.";
      const message = "Gateway service already loaded.";
      expect(runtimeLogs).toEqual(
        json
          ? [
              JSON.stringify(
                {
                  action: "install",
                  ok: true,
                  result: "already-installed",
                  message,
                  service: {
                    label: "Gateway",
                    loaded: true,
                    loadedText: "loaded",
                    notLoadedText: "not loaded",
                  },
                  warnings: [warning],
                },
                null,
                2,
              ),
            ]
          : [warning, message, "Reinstall with: openclaw gateway install --force"],
      );
      expect(runtimeErrors).toEqual([]);
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect((await readJson(configPath)).gateway).toEqual({
        mode: "local",
        auth: { mode: "token", token: "existing-token" },
      });
    },
  );

  it.each([false, true])(
    "preserves empty and duplicate native Gateway install warnings (json=%s)",
    async (json) => {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          gateway: { mode: "local", auth: { mode: "token", token: "existing-token" } },
        }),
      );
      clearConfigCache();
      serviceMock.isLoaded.mockResolvedValueOnce(false).mockResolvedValue(true);
      serviceMock.install.mockImplementationOnce(async (args) => {
        args?.warn?.("");
        args?.warn?.("repeat");
        args?.warn?.("repeat");
      });

      await runDaemonInstall({ json, force: true });

      const warnings = ["", "repeat", "repeat"];
      const message =
        "Gateway service installed. Runtime readiness has not been checked; startup may still be in progress. Check with openclaw gateway status and openclaw health.";
      expect(runtimeLogs).toEqual(
        json
          ? [
              JSON.stringify(
                {
                  action: "install",
                  ok: true,
                  result: "installed",
                  message,
                  service: {
                    label: "Gateway",
                    loaded: true,
                    loadedText: "loaded",
                    notLoadedText: "not loaded",
                  },
                  warnings,
                },
                null,
                2,
              ),
            ]
          : [...warnings, message],
      );
      expect(runtimeErrors).toEqual([]);
      expect(serviceMock.install).toHaveBeenCalledOnce();
    },
  );
});
