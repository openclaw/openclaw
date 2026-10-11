import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createEmptyUninstallActions,
  installHooksFromNpmSpecMock,
  pluginLifecycleGatewayMock,
  pluginsCliRuntimeLogs,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
  resolvePluginLifecycleGatewayMock,
  runPluginsCommand,
} from "./plugins-cli-test-helpers.js";

const boundary = vi.hoisted(() => ({
  foreign: false,
  revoked: false,
  install: vi.fn(),
  policy: vi.fn(),
  uninstall: vi.fn(),
  catalog: vi.fn(),
  persistHook: vi.fn(),
}));

vi.mock("../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-lock.js")>()),
  readActiveGatewayLockIdentity: async () =>
    boundary.foreign ? { pid: 12345, port: 18789, ownerId: "synthetic-owner" } : null,
  acquireGatewayLock: async () => ({
    assertCurrent() {
      if (boundary.revoked) {
        throw new Error("Offline ownership is no longer current");
      }
    },
    release: async () => {},
  }),
}));

// mock-isolation: Exercise the real command ownership decision without opening a worker database.
vi.mock("../infra/gateway-state-owner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-state-owner.js")>()),
  captureGatewayStateOwner: () => undefined,
  tryBorrowGatewayStateOwner: () => undefined,
}));
// mock-isolation: Database settlement is covered by the shared local-state-owner process suite.
vi.mock("../state/openclaw-state-db-async-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-async-lifecycle.js")>()),
  createOpenClawDatabaseMaintenanceScope: () => ({
    run: async (run: () => Promise<unknown>) => run(),
    close: async () => {},
  }),
}));
// mock-isolation: Package leases and artifact effects are downstream of this command boundary.
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  hasPluginLifecycleLease: () => false,
  withPluginLifecycleLease: async (
    _options: unknown,
    run: (lease: { assertOwned: () => void }) => Promise<unknown>,
  ) => run({ assertOwned() {} }),
}));
vi.mock("../plugins/management-mutations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/management-mutations.js")>()),
  installManagedPlugin: (...args: unknown[]) => boundary.install(...args),
  mutateManagedPluginEnabled: (...args: unknown[]) => boundary.policy(...args),
}));
vi.mock("../plugins/management-uninstall.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/management-uninstall.js")>()),
  preparePluginUninstall: async () => ({
    ok: true,
    value: {
      pluginId: "alpha",
      requestedPluginId: "alpha",
      pluginIds: ["alpha"],
      name: "alpha",
      installRecords: {},
      snapshot: { config: {} },
      plan: { actions: createEmptyUninstallActions(), directoryRemoval: null },
    },
  }),
  uninstallPluginWithPolicy: (...args: unknown[]) => boundary.uninstall(...args),
}));
vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    boundary.catalog(...args),
}));
vi.mock("./hook-install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hook-install-persistence.js")>()),
  persistHookPackInstall: (...args: unknown[]) => boundary.persistHook(...args),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeAll(() => {
  // The shared synthetic storage fixture skips custody; this suite exercises the real guard.
  vi.doUnmock("./plugins-local-state.js");
});

beforeEach(() => {
  resetPluginsCliTestState();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-plugin-owner-"));
  boundary.foreign = false;
  boundary.revoked = false;
  boundary.install.mockReset().mockResolvedValue({ plugin: { id: "alpha" }, warnings: [] });
  boundary.policy.mockReset().mockResolvedValue({ pluginId: "alpha", warnings: [] });
  boundary.uninstall.mockReset().mockResolvedValue({ ok: true });
  boundary.persistHook.mockReset().mockResolvedValue({});
  boundary.catalog.mockReset().mockResolvedValue({ source: "bundled-fallback", entries: [] });
});

afterEach(() => vi.unstubAllEnvs());

const commands = [
  {
    name: "install",
    args: ["install", "npm:synthetic-plugin", "--force"],
    effect: boundary.install,
  },
  { name: "enable", args: ["enable", "alpha"], effect: boundary.policy },
  { name: "disable", args: ["disable", "alpha"], effect: boundary.policy },
  { name: "uninstall", args: ["uninstall", "alpha", "--force"], effect: boundary.uninstall },
  { name: "registry refresh", args: ["registry", "--refresh"], effect: refreshPluginRegistryMock },
  {
    name: "update",
    args: ["update", "--all"],
    output: "No tracked plugins or hook packs to update.",
  },
  { name: "marketplace entries", args: ["marketplace", "entries"], effect: boundary.catalog },
  { name: "marketplace refresh", args: ["marketplace", "refresh"], effect: boundary.catalog },
];

describe("local plugin command ownership", () => {
  it("revalidates ownership immediately before the plugin policy effect", async () => {
    const effect = vi.fn();
    boundary.policy.mockImplementation(async ({ beforePersistentApply }) => {
      await Promise.resolve();
      boundary.revoked = true;
      beforePersistentApply();
      effect();
    });
    await expect(runPluginsCommand(["plugins", "enable", "alpha"])).rejects.toThrow(
      "Offline ownership is no longer current",
    );
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(commands)("refuses $name while another process owns state", async ({ args, effect }) => {
    boundary.foreign = true;
    await expect(runPluginsCommand(["plugins", ...args])).rejects.toThrow(/stop the Gateway/i);
    if (effect) {
      expect(effect).not.toHaveBeenCalled();
    }
    expect(pluginsCliRuntimeLogs.join("\n")).not.toContain("No tracked plugins");
  });

  it.each(commands)("runs $name while the Gateway is stopped", async ({ args, effect, output }) => {
    await runPluginsCommand(["plugins", ...args]);
    if (effect) {
      expect(effect).toHaveBeenCalledOnce();
    }
    if (output) {
      expect(pluginsCliRuntimeLogs).toContain(output);
    }
  });

  it.each(["enable", "disable", "install", "uninstall"])(
    "keeps the existing %s Gateway route",
    async (command) => {
      boundary.foreign = true;
      resolvePluginLifecycleGatewayMock.mockResolvedValue(pluginLifecycleGatewayMock);
      pluginLifecycleGatewayMock.mockResolvedValue({
        plugin: { id: "alpha" },
        pluginId: "alpha",
        removed: [],
        runtime: { generation: 2 },
      });
      await runPluginsCommand([
        "plugins",
        command,
        command === "install" ? "npm:synthetic-plugin" : "alpha",
        ...(["install", "uninstall"].includes(command) ? ["--force"] : []),
      ]);
      expect(pluginLifecycleGatewayMock.mock.calls[0]?.[0]).toBe(
        `plugins.${command === "enable" || command === "disable" ? "setEnabled" : command}`,
      );
      expect(boundary.install).not.toHaveBeenCalled();
      expect(boundary.policy).not.toHaveBeenCalled();
      expect(boundary.uninstall).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])("guards hook fallback when foreign owner=%s", async (foreign) => {
    boundary.foreign = foreign;
    resolvePluginLifecycleGatewayMock.mockResolvedValue(pluginLifecycleGatewayMock);
    pluginLifecycleGatewayMock.mockRejectedValue(
      Object.assign(new Error("not a plugin"), {
        details: { pluginInstallRejected: true, pluginInstallCode: "missing_openclaw_extensions" },
      }),
    );
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: true,
      hookPackId: "synthetic-hooks",
      hooks: [],
      targetDir: "/synthetic-hooks",
    });
    const command = runPluginsCommand(["plugins", "install", "npm:synthetic-hooks", "--force"]);
    if (foreign) {
      await expect(command).rejects.toThrow(/stop the Gateway/i);
      expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
      expect(boundary.persistHook).not.toHaveBeenCalled();
    } else {
      await command;
      expect(installHooksFromNpmSpecMock).toHaveBeenCalledOnce();
      expect(boundary.persistHook).toHaveBeenCalledOnce();
    }
  });
});
