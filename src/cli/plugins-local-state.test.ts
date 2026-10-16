import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as cli from "./plugins-cli-test-helpers.js";

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
  installManagedPlugin: boundary.install,
  mutateManagedPluginEnabled: boundary.policy,
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
      plan: { actions: cli.createEmptyUninstallActions(), directoryRemoval: null },
    },
  }),
  uninstallPluginWithPolicy: boundary.uninstall,
}));
vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: boundary.catalog,
}));
vi.mock("./hook-install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hook-install-persistence.js")>()),
  persistHookPackInstall: boundary.persistHook,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const run = (...args: string[]) => cli.runPluginsCommand(["plugins", ...args]);

// The shared synthetic storage fixture skips custody; exercise the real guard here.
beforeAll(() => vi.doUnmock("./plugins-local-state.js"));

beforeEach(() => {
  cli.resetPluginsCliTestState();
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
  { args: ["install", "npm:synthetic-plugin", "--force"], effect: boundary.install },
  { args: ["enable", "alpha"], effect: boundary.policy },
  { args: ["disable", "alpha"], effect: boundary.policy },
  { args: ["uninstall", "alpha", "--force"], effect: boundary.uninstall },
  { args: ["registry", "--refresh"], effect: cli.refreshPluginRegistryMock },
  { args: ["update", "--all"], output: "No tracked plugins or hook packs to update." },
  { args: ["marketplace", "entries"], effect: boundary.catalog },
  { args: ["marketplace", "refresh"], effect: boundary.catalog },
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
    await expect(run("enable", "alpha")).rejects.toThrow("Offline ownership is no longer current");
    expect(effect).not.toHaveBeenCalled();
  });

  describe.each([true, false])("foreign state owner=%s", (foreign) => {
    it.each(commands)("authorizes $args", async ({ args, effect, output }) => {
      boundary.foreign = foreign;
      const command = run(...args);
      if (foreign) {
        await expect(command).rejects.toThrow(/stop the Gateway/i);
        expect(cli.pluginsCliRuntimeLogs.join("\n")).not.toContain("No tracked plugins");
      } else {
        await command;
        if (output) {
          expect(cli.pluginsCliRuntimeLogs).toContain(output);
        }
      }
      if (effect) {
        expect(effect).toHaveBeenCalledTimes(foreign ? 0 : 1);
      }
    });
  });

  it.each(commands.slice(0, 4))("keeps the existing $args Gateway route", async ({ args }) => {
    const command = args[0];
    boundary.foreign = true;
    cli.resolvePluginLifecycleGatewayMock.mockResolvedValue(cli.pluginLifecycleGatewayMock);
    cli.pluginLifecycleGatewayMock.mockResolvedValue({
      plugin: { id: "alpha" },
      pluginId: "alpha",
      removed: [],
      runtime: { generation: 2 },
    });
    await run(...args);
    expect(cli.pluginLifecycleGatewayMock.mock.calls[0]?.[0]).toBe(
      `plugins.${command === "enable" || command === "disable" ? "setEnabled" : command}`,
    );
    expect(boundary.install).not.toHaveBeenCalled();
    expect(boundary.policy).not.toHaveBeenCalled();
    expect(boundary.uninstall).not.toHaveBeenCalled();
  });

  it.each([true, false])("guards hook fallback when foreign owner=%s", async (foreign) => {
    boundary.foreign = foreign;
    cli.resolvePluginLifecycleGatewayMock.mockResolvedValue(cli.pluginLifecycleGatewayMock);
    cli.pluginLifecycleGatewayMock.mockRejectedValue(
      Object.assign(new Error("not a plugin"), {
        details: { pluginInstallRejected: true, pluginInstallCode: "missing_openclaw_extensions" },
      }),
    );
    cli.installHooksFromNpmSpecMock.mockResolvedValue({
      ok: true,
      hookPackId: "synthetic-hooks",
      hooks: [],
      targetDir: "/synthetic-hooks",
    });
    const command = run("install", "npm:synthetic-hooks", "--force");
    if (foreign) {
      await expect(command).rejects.toThrow(/stop the Gateway/i);
    } else {
      await command;
    }
    expect(cli.installHooksFromNpmSpecMock).toHaveBeenCalledTimes(foreign ? 0 : 1);
    expect(boundary.persistHook).toHaveBeenCalledTimes(foreign ? 0 : 1);
  });
});
