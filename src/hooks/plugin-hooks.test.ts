import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildPluginCapabilitySummary } from "../plugins/capability-summary.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { projectInstalledPluginComponents } from "../plugins/installed-plugin-components.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  setInternalHooksEnabled,
  triggerInternalHook,
} from "./internal-hooks.js";
import { prepareInternalHooks } from "./loader.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

describe("bundle plugin hooks", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";

  beforeAll(async () => {
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-hooks-"));
  });

  beforeEach(async () => {
    clearInternalHooks();
    setInternalHooksEnabled(true);
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fsp.mkdir(workspaceDir, { recursive: true });
    vi.stubEnv("OPENCLAW_BUNDLED_HOOKS_DIR", "/nonexistent/bundled/hooks");
  });

  afterEach(() => {
    setCurrentPluginMetadataSnapshot(undefined);
    vi.restoreAllMocks();
    clearInternalHooks();
    setInternalHooksEnabled(true);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function writeBundleFiles(root: string, files: Record<string, string>) {
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(root, relative);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, content, "utf-8");
    }
  }

  async function writeBundleHookFixture(
    format = "codex",
    withJsonHooks = false,
    declaredRoot = "hooks",
  ): Promise<string> {
    const bundleRoot = path.join(workspaceDir, ".openclaw", "extensions", "sample-bundle");
    await writeBundleFiles(bundleRoot, {
      [`.${format}-plugin/plugin.json`]: JSON.stringify({
        name: "Sample Bundle",
        hooks: declaredRoot,
      }),
      "hooks/bundle-hook/HOOK.md":
        '---\nname: bundle-hook\ndescription: "Bundle hook"\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n\n# Bundle hook\n',
      "hooks/bundle-hook/handler.js":
        'export default async function(event) { event.messages.push("bundle-hook-ok"); }\n',
    });
    if (withJsonHooks) {
      await writeBundleFiles(bundleRoot, { "hooks/hooks.json": '{"hooks":[]}' });
    }
    return bundleRoot;
  }

  function createConfig(enabled: boolean, pluginId = "sample-bundle"): OpenClawConfig {
    return {
      hooks: { internal: { enabled: true } },
      plugins: { entries: { [pluginId]: { enabled } } },
    };
  }

  function publishSnapshot(config: OpenClawConfig, gateway = true) {
    const snapshot = loadPluginMetadataSnapshot({ config, workspaceDir, env: process.env });
    const publish = gateway ? setGatewayPluginMetadataSnapshot : setCurrentPluginMetadataSnapshot;
    publish(snapshot, { config, workspaceDir });
  }

  async function expectHookMessages(messages: string[]) {
    const event = createInternalHookEvent("command", "new", "test-session");
    await triggerInternalHook(event);
    expect(event.messages).toEqual(messages);
  }

  function requireOnlyHookEntry(entries: ReturnType<typeof loadWorkspaceHookEntries>) {
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) {
      throw new Error("Expected bundled hook entry");
    }
    return entry;
  }

  function projectBundleComponents(pluginId: string, config: OpenClawConfig) {
    const metadata = loadPluginMetadataSnapshot({ config, workspaceDir, env: process.env });
    const manifest = metadata.manifestRegistry.plugins.find(({ id }) => id === pluginId);
    if (!manifest) {
      throw new Error(`Expected bundle manifest for ${pluginId}`);
    }
    const { declared } = buildPluginCapabilitySummary({ manifest, origin: manifest.origin });
    return { declared, components: projectInstalledPluginComponents({ manifest, declared }) };
  }

  it.each([
    { format: "codex", withJsonHooks: false, root: "hooks", supported: ["hooks"] },
    { format: "claude", withJsonHooks: false, root: "hooks", supported: ["hooks"] },
    { format: "claude", withJsonHooks: true, root: "hooks", supported: ["hooks"] },
    { format: "claude", withJsonHooks: false, root: "hooks/bundle-hook", supported: [] },
  ])(
    "matches $format hook components to discovery for $root with JSON hooks $withJsonHooks",
    async ({ format, withJsonHooks, root, supported }) => {
      const bundleRoot = await writeBundleHookFixture(format, withJsonHooks, root);
      const config = createConfig(true);
      const entries = loadWorkspaceHookEntries(workspaceDir, { config });

      if (supported.length > 0) {
        const entry = requireOnlyHookEntry(entries);
        expect(entry.hook).toMatchObject({
          name: "bundle-hook",
          source: "openclaw-plugin",
          pluginId: "sample-bundle",
          baseDir: fs.realpathSync.native(path.join(bundleRoot, "hooks", "bundle-hook")),
        });
        expect(entry.metadata?.events).toEqual(["command:new"]);
      } else {
        expect(entries).toHaveLength(0);
      }

      const { declared, components } = projectBundleComponents("sample-bundle", config);
      expect(declared.hooks).toEqual(withJsonHooks ? [root, "hooks/hooks.json"] : [root]);
      expect(components).toMatchObject({
        mapped: supported.length > 0 ? ["hooks"] : [],
        hooks: supported,
        unavailable: { capabilities: supported.length > 0 ? [] : ["hooks"] },
      });
    },
  );

  it("reuses published plugin metadata without rescanning manifests", async () => {
    const bundleRoot = await writeBundleHookFixture();
    const config = createConfig(true);
    publishSnapshot(config, false);
    const manifestRegistry = await import("../plugins/manifest-registry-installed.js");
    const scanManifests = vi.spyOn(manifestRegistry, "loadPluginManifestRegistryForInstalledIndex");

    for (let iteration = 0; iteration < 2; iteration += 1) {
      const entry = requireOnlyHookEntry(loadWorkspaceHookEntries(workspaceDir, { config }));
      expect(entry.hook).toMatchObject({
        name: "bundle-hook",
        source: "openclaw-plugin",
        pluginId: "sample-bundle",
        baseDir: fs.realpathSync.native(path.join(bundleRoot, "hooks", "bundle-hook")),
      });
    }

    expect(scanManifests).not.toHaveBeenCalled();
  });

  it("commits candidate plugin hook policy from the immutable Gateway inventory", async () => {
    await writeBundleHookFixture();
    const config = createConfig(true);
    publishSnapshot(config);
    const manifestRegistry = await import("../plugins/manifest-registry-installed.js");
    const scanManifests = vi.spyOn(manifestRegistry, "loadPluginManifestRegistryForInstalledIndex");
    const initial = await prepareInternalHooks(config, workspaceDir);
    expect(initial.loadedCount).toBe(1);
    initial.commit();

    for (const enabled of [false, true]) {
      const candidate = await prepareInternalHooks(createConfig(enabled), workspaceDir);
      expect(candidate.loadedCount).toBe(enabled ? 1 : 0);
      await expectHookMessages(enabled ? [] : ["bundle-hook-ok"]);
      candidate.commit();
      await expectHookMessages(enabled ? ["bundle-hook-ok"] : []);
    }
    expect(scanManifests).not.toHaveBeenCalled();
  });

  it.each(["root", "descriptor"])(
    "retains a selected plugin hook after losing its %s until the plugin is disabled",
    async (failure) => {
      const bundleRoot = await writeBundleHookFixture();
      const config = createConfig(true);
      publishSnapshot(config);
      (await prepareInternalHooks(config, workspaceDir)).commit();
      const hookRoot = path.join(bundleRoot, "hooks");
      await fsp.rm(failure === "root" ? hookRoot : path.join(hookRoot, "bundle-hook", "HOOK.md"), {
        recursive: true,
      });

      await expect(prepareInternalHooks(config, workspaceDir)).rejects.toThrow();
      await expectHookMessages(["bundle-hook-ok"]);
      (await prepareInternalHooks(createConfig(false), workspaceDir)).commit();
      await expectHookMessages([]);
    },
  );

  it("does not treat Claude hooks.json bundles as OpenClaw hook packs", async () => {
    const bundleRoot = path.join(workspaceDir, ".openclaw", "extensions", "claude-bundle");
    await writeBundleFiles(bundleRoot, {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "Claude Bundle",
        hooks: [{ type: "command" }],
      }),
      "hooks/hooks.json": '{"hooks":[]}',
    });
    const config = createConfig(true, "claude-bundle");
    const entries = loadWorkspaceHookEntries(workspaceDir, { config });
    expect(entries).toHaveLength(0);

    const { declared, components } = projectBundleComponents("claude-bundle", config);
    expect(declared.hooks).toEqual(["hooks/hooks.json"]);
    expect(components).toMatchObject({
      mapped: [],
      hooks: [],
      unavailable: { capabilities: ["hooks"] },
    });
  });
});
