import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeProbeOutput } from "../cli/daemon-cli/install.test-helpers.js";
import type { GatewayServiceInstallArgs } from "../daemon/service-types.js";
import type * as DeviceAuthStoreModule from "../infra/device-auth-store.js";
import type * as DeviceIdentityModule from "../infra/device-identity-async.js";
import type * as NodeHostConfigModule from "../node-host/config.js";
import { withEnvAsync } from "../test-utils/env.js";

const {
  runExec,
  access,
  stat,
  loadNodeHostConfig,
  loadDeviceIdentityIfPresentAsync,
  loadDeviceAuthTokenReadOnly,
  serviceInstall,
} = vi.hoisted(() => ({
  runExec: vi.fn(),
  access: vi.fn(),
  stat: vi.fn(),
  loadNodeHostConfig: vi.fn(),
  loadDeviceIdentityIfPresentAsync: vi.fn(),
  loadDeviceAuthTokenReadOnly: vi.fn(),
  serviceInstall: vi.fn<(args: GatewayServiceInstallArgs) => Promise<void>>(),
}));
vi.mock("../daemon/node-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/node-service.js")>()),
  resolveNodeService: () => ({
    label: "Node service",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    readCommand: async () => null,
    isLoaded: async () => true,
    install: serviceInstall,
  }),
}));
vi.mock("../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-pin-state.js")>()),
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, run: () => T) => run(),
  readDaemonRuntimePinForInstall: () => ({ revision: "empty", stored: false }),
}));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
}));
vi.mock("../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd.js")>()),
  isSystemdUserServiceAvailable: async () => false,
}));
vi.mock("../process/exec.js", () => ({ runExec }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: { ...actual, access, stat, realpath: async (value: string) => value },
  };
});
vi.mock("../node-host/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeHostConfigModule>()),
  loadNodeHostConfig,
}));
vi.mock("../infra/device-identity-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DeviceIdentityModule>()),
  loadDeviceIdentityIfPresentAsync,
}));
vi.mock("../infra/device-auth-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DeviceAuthStoreModule>()),
  loadDeviceAuthTokenReadOnly,
}));

import { runNodeDaemonInstall } from "../cli/node-cli/daemon.js";

const originalExecPath = process.execPath;
const originalArgv = process.argv;
beforeEach(() => {
  process.execPath = "/fixture/bun";
  process.argv = [process.execPath, path.resolve("/opt/openclaw/dist/index.js")];
  access.mockImplementation(async (value: string) => {
    if (
      value === "/usr/bin/node" ||
      value === process.argv[1] ||
      value === "/opt/openclaw/openclaw.mjs" ||
      value === "/opt/openclaw-wrapper"
    ) {
      return;
    }
    throw new Error("ENOENT");
  });
  stat.mockResolvedValue({ isFile: () => true });
  runExec.mockResolvedValue({
    stdout: JSON.stringify({
      nodeVersion: "26.12.1",
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      nodeSharedSqlite: false,
    }),
    stderr: "",
  });
  loadNodeHostConfig.mockResolvedValue(null);
  loadDeviceIdentityIfPresentAsync.mockResolvedValue(null);
  loadDeviceAuthTokenReadOnly.mockResolvedValue(null);
  serviceInstall.mockResolvedValue(undefined);
});
afterEach(() => {
  process.execPath = originalExecPath;
  process.argv = originalArgv;
  vi.resetAllMocks();
});

async function install(env: Record<string, string | undefined> = {}, authFromEnv = false) {
  await withEnvAsync({ OPENCLAW_NIX_MODE: undefined, OPENCLAW_WRAPPER: undefined, ...env }, () =>
    runNodeDaemonInstall({
      host: "gateway.example",
      port: 18789,
      runtime: "node",
      authFromEnv,
      force: true,
      json: true,
    }),
  );
  const args = serviceInstall.mock.calls[0]?.[0];
  if (!args) {
    throw new Error("Node service was not installed");
  }
  return args;
}

describe.skipIf(process.platform === "win32")("node-host runtime install boundary", () => {
  it.each([false, true])(
    "persists ambient auth only when explicitly selected for a paired node (explicit=%s)",
    async (explicit) => {
      runExec.mockResolvedValue(nodeProbeOutput("26.12.1"));
      loadNodeHostConfig.mockResolvedValue({
        version: 1,
        nodeId: "paired-node",
        gateway: { host: "gateway.example", port: 18789 },
      });
      loadDeviceIdentityIfPresentAsync.mockResolvedValue({ deviceId: "paired-device" });
      loadDeviceAuthTokenReadOnly.mockResolvedValue({ token: "paired-node-token" });
      const plan = await install(
        {
          OPENCLAW_GATEWAY_TOKEN: "unrelated-gateway-token",
          OPENCLAW_GATEWAY_PASSWORD: "unrelated-gateway-password",
        },
        explicit,
      );
      expect(plan.environment?.OPENCLAW_GATEWAY_TOKEN).toBe(
        explicit ? "unrelated-gateway-token" : undefined,
      );
      expect(plan.environment?.OPENCLAW_GATEWAY_PASSWORD).toBe(
        explicit ? "unrelated-gateway-password" : undefined,
      );
      expect(plan.programArguments.includes("--auth-from-env")).toBe(explicit);
    },
  );
});
