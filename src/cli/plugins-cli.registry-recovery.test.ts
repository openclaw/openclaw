import fs from "node:fs";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { createConfigIO } from "../config/io.factory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readPersistedInstalledPluginIndexRowSync } from "../plugins/installed-plugin-index-record-state.js";
import { readPersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerPluginsCli } from "./plugins-cli.js";
import { registerPreActionHooks } from "./program/preaction.js";

const output = vi.hoisted(() => ({ writeJson: vi.fn() }));
vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return { ...actual, defaultRuntime: { ...actual.defaultRuntime, writeJson: output.writeJson } };
});

afterEach(() => {
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  vi.clearAllMocks();
});

async function refreshRegistry(withBootstrap = false) {
  const program = new Command().name("openclaw");
  const argv = ["plugins", "registry", "--refresh", "--json"];
  const previousArgv = process.argv;
  try {
    if (withBootstrap) {
      process.argv = ["node", "openclaw", ...argv];
      registerPreActionHooks(program, "test");
    }
    registerPluginsCli(program);
    await program.parseAsync(argv, { from: "user" });
  } finally {
    process.argv = previousArgv;
  }
}

describe("plugins registry recovery", () => {
  it("imports legacy-only installation ownership through the registered bootstrap before refresh", async () => {
    await withOpenClawTestState({ label: "registry-cli-legacy" }, async (state) => {
      const bundled = state.path("empty-bundled");
      const rootDir = state.path("linked-plugin");
      fs.mkdirSync(bundled);
      fs.mkdirSync(rootDir);
      state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = bundled;
      state.applyEnv();
      const plugin = createColdPluginFixture({ rootDir, pluginId: "demo" });
      const records = { demo: { source: "path", sourcePath: rootDir, installPath: rootDir } };
      const legacyPath = await state.writeJson("plugins/installs.json", { records });
      await state.writeConfig({
        plugins: { allow: ["demo"], load: { paths: [] }, entries: { demo: { enabled: true } } },
      });
      const configBytes = fs.readFileSync(state.configPath, "utf8");
      const legacyBytes = fs.readFileSync(legacyPath, "utf8");
      expect(readPersistedInstalledPluginIndexSync()).toBeNull();

      await refreshRegistry(true);

      expect(output.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ refreshed: true, state: "fresh" }),
      );
      const persisted = readPersistedInstalledPluginIndexSync();
      expect(persisted?.installRecords).toEqual(records);
      expect(persisted?.plugins.find((entry) => entry.pluginId === "demo")?.source).toBe(
        plugin.runtimeSource,
      );
      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(fs.readFileSync(`${legacyPath}.migrated`, "utf8")).toBe(legacyBytes);
      expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBytes);
      expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
    });
  });

  it("replaces a stale config-selected source with its managed owner without activating either", async () => {
    await withOpenClawTestState({ label: "registry-cli-recovery" }, async (state) => {
      const bundled = state.path("empty-bundled");
      const oldRoot = state.path("old-checkout-plugin");
      fs.mkdirSync(bundled);
      fs.mkdirSync(oldRoot);
      state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = bundled;
      state.applyEnv();
      const old = createColdPluginFixture({ rootDir: oldRoot, pluginId: "demo" });
      const managedRoot = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "@example/demo",
        pluginId: "demo",
        version: "2.0.0",
      });
      const managed = createColdPluginFixture({
        rootDir: managedRoot,
        pluginId: "demo",
        packageName: "@example/demo",
        packageVersion: "2.0.0",
      });
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: {
            main: { workspace: state.workspaceDir },
            other: { workspace: state.path("other-workspace") },
          },
        },
        plugins: { allow: ["demo"], load: { paths: [] }, entries: { demo: { enabled: true } } },
      };
      await state.writeConfig(config);
      const configBytes = fs.readFileSync(state.configPath, "utf8");
      const io = createConfigIO({ observe: false });
      const core = await createConfigIO({
        observe: false,
        pluginValidation: "core-only",
      }).readConfigFileSnapshot();
      expect(core.valid).toBe(true);
      const records = {
        demo: { source: "npm" as const, spec: "@example/demo@2.0.0", installPath: managedRoot },
      };
      // An older source remains on disk after the operator switches to a managed package.
      // The persisted projection still selects it even though current load.paths is empty.
      await seedInstalledPluginIndex(records, {
        config: core.runtimeConfig,
        workspaceDir: state.workspaceDir,
        candidates: [
          { idHint: "demo", source: old.runtimeSource, rootDir: oldRoot, origin: "config" },
        ],
      });
      const before = await io.readConfigFileSnapshot();
      expect(before.valid).toBe(false);
      expect(before.issues).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining(
            'plugin id "demo" is present in multiple agent workspaces',
          ),
        }),
      );

      await refreshRegistry();

      expect(output.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ refreshed: true, state: "fresh" }),
      );
      const persisted = readPersistedInstalledPluginIndexSync();
      expect(persisted?.installRecords).toEqual(records);
      expect(persisted?.plugins.find((plugin) => plugin.pluginId === "demo")).toMatchObject({
        source: managed.runtimeSource,
        origin: "global",
      });
      expect((await io.readConfigFileSnapshot()).valid).toBe(true);
      expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBytes);
      expect(fs.existsSync(old.runtimeMarker)).toBe(false);
      expect(fs.existsSync(managed.runtimeMarker)).toBe(false);
    });
  });

  it("retains an invalid legacy installation ledger without replacing the registry", async () => {
    await withOpenClawTestState({ label: "registry-cli-invalid-ledger" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      await seedInstalledPluginIndex({}, { config: { plugins: { enabled: false } } });
      const before = readPersistedInstalledPluginIndexRowSync({});
      const legacyPath = await state.writeText("plugins/installs.json", "{ broken");

      await expect(refreshRegistry(true)).rejects.toThrow(
        "Plugin installation metadata migration did not complete",
      );

      expect(readPersistedInstalledPluginIndexRowSync({})).toEqual(before);
      expect(fs.readFileSync(legacyPath, "utf8")).toBe("{ broken");
      expect(output.writeJson).not.toHaveBeenCalled();
    });
  });

  it("does not publish refresh success after lease revocation during inspection", async () => {
    await withOpenClawTestState({ label: "registry-cli-revoked" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const configBytes = fs.readFileSync(state.configPath, "utf8");
      const controller = new AbortController();
      const registry = await import("../plugins/plugin-registry.js");
      const inspect = registry.inspectPluginRegistry;
      const inspection = vi
        .spyOn(registry, "inspectPluginRegistry")
        .mockImplementationOnce(async (params) => {
          const result = await inspect(params);
          controller.abort();
          return result;
        });
      try {
        await expect(
          withPluginLifecycleLease({ signal: controller.signal }, () => refreshRegistry()),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });

        expect(inspection).toHaveBeenCalledOnce();
        expect(readPersistedInstalledPluginIndexSync()).not.toBeNull();
        expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBytes);
        expect(output.writeJson).not.toHaveBeenCalled();
      } finally {
        inspection.mockRestore();
      }
    });
  });

  it("repairs registry metadata without accepting invalid plugin configuration", async () => {
    await withOpenClawTestState({ label: "registry-cli-plugin-config" }, async (state) => {
      const rootDir = state.path("plugin");
      fs.mkdirSync(rootDir);
      const plugin = createColdPluginFixture({
        rootDir,
        pluginId: "demo",
        manifest: { configSchema: { type: "object", additionalProperties: false } },
      });
      await state.writeConfig({
        plugins: {
          allow: ["demo"],
          load: { paths: [rootDir] },
          entries: { demo: { enabled: true, config: { unexpected: true } } },
        },
      });
      const configBytes = fs.readFileSync(state.configPath, "utf8");

      await refreshRegistry();

      expect(output.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ refreshed: true, state: "fresh" }),
      );
      const snapshot = await createConfigIO({ observe: false }).readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues).toContainEqual(
        expect.objectContaining({ path: "plugins.entries.demo.config" }),
      );
      expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBytes);
      expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
    });
  });

  it.each([
    { label: "malformed JSON", raw: "{ broken", issue: /JSON5/ },
    { label: "invalid core schema", raw: '{"gateway":{"port":"invalid"}}', issue: /gateway.port/ },
  ])("refuses $label before replacing the registry", async ({ raw, issue }) => {
    await withOpenClawTestState({ label: "registry-cli-invalid-core" }, async (state) => {
      await seedInstalledPluginIndex({}, { config: { plugins: { enabled: false } } });
      const before = readPersistedInstalledPluginIndexRowSync({});
      const legacyPath = await state.writeJson("plugins/installs.json", {
        records: { legacy: { source: "path" } },
      });
      const legacyBytes = fs.readFileSync(legacyPath, "utf8");
      fs.writeFileSync(state.configPath, raw);

      await expect(refreshRegistry()).rejects.toThrow(issue);

      expect(readPersistedInstalledPluginIndexRowSync({})).toEqual(before);
      expect(fs.readFileSync(state.configPath, "utf8")).toBe(raw);
      expect(fs.readFileSync(legacyPath, "utf8")).toBe(legacyBytes);
      expect(output.writeJson).not.toHaveBeenCalled();
    });
  });
});
