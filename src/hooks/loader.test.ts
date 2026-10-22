import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { buildPluginCapabilitySummary } from "../plugins/capability-summary.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { projectInstalledPluginComponents } from "../plugins/installed-plugin-components.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { writeHookFixture } from "./hook-fixture.test-support.js";
import {
  clearInternalHooks,
  hasInternalHookListeners,
  triggerInternalHook,
  createInternalHookEvent,
  registerInternalHook,
  setInternalHooksEnabled,
} from "./internal-hooks.js";
import { prepareInternalHooks } from "./loader.js";
import type { OpenClawHookMetadata } from "./types.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("loader", () => {
  let tmpDir: string;
  let managedHooksDir: string;
  let options: { managedHooksDir: string; bundledHooksDir: string };

  function prepare(
    cfg: OpenClawConfig,
    opts: Parameters<typeof prepareInternalHooks>[2] = options,
  ) {
    return prepareInternalHooks(cfg, tmpDir, opts);
  }

  async function commitPreparedHooks(
    cfg: OpenClawConfig,
    opts: Parameters<typeof prepareInternalHooks>[2] = options,
  ) {
    const prepared = await prepare(cfg, opts);
    prepared.commit();
    return prepared.loadedCount;
  }

  async function expectMessages(messages: string[]) {
    const event = createInternalHookEvent("command", "new", "test-session");
    await triggerInternalHook(event);
    expect(event.messages).toEqual(messages);
  }

  beforeEach(() => {
    clearInternalHooks();
    setInternalHooksEnabled(true);
    tmpDir = tempDirs.make("openclaw-hooks-loader-");
    managedHooksDir = path.join(tmpDir, "managed-hooks");
    options = { managedHooksDir, bundledHooksDir: "/nonexistent/bundled/hooks" };
    vi.stubEnv("OPENCLAW_BUNDLED_HOOKS_DIR", options.bundledHooksDir);
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  function writeDiscoveredHook(
    hookName: string,
    params: {
      sourceDir?: string;
      handlerCode?: string;
      events?: string[];
      exportName?: string;
      hookKey?: string;
      requires?: OpenClawHookMetadata["requires"];
    } = {},
  ): string {
    const hookDir = path.join(params.sourceDir ?? managedHooksDir, hookName);
    const metadata = {
      events: params.events ?? ["command:new"],
      ...(params.exportName ? { export: params.exportName } : {}),
      ...(params.hookKey ? { hookKey: params.hookKey } : {}),
      ...(params.requires ? { requires: params.requires } : {}),
    };
    writeHookFixture(
      hookDir,
      `---\nname: ${hookName}\ndescription: ${hookName} test hook\nmetadata: ${JSON.stringify({ openclaw: metadata })}\n---\n\n# ${hookName}`,
      params.handlerCode ??
        `export default async function(event) { event.messages.push("${hookName}"); }\n`,
      "handler.js",
    );
    return hookDir;
  }

  function createHooksConfig(
    names: string[] = [],
    enabled?: boolean,
    extraDirs?: string[],
  ): OpenClawConfig {
    return {
      hooks: {
        internal: {
          enabled,
          entries: Object.fromEntries(names.map((name) => [name, { enabled: true }])),
          ...(extraDirs ? { load: { extraDirs } } : {}),
        },
      },
    };
  }

  afterEach(async () => {
    clearInternalHooks();
    setInternalHooksEnabled(true);
    loggingState.rawConsole = null;
    setLoggerOverride(null);
    setCurrentPluginMetadataSnapshot(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("skips hook discovery until internal hooks are configured", async () => {
    for (const cfg of [
      {} satisfies OpenClawConfig,
      { hooks: {} } satisfies OpenClawConfig,
      { hooks: { internal: {} } } satisfies OpenClawConfig,
    ]) {
      const count = await commitPreparedHooks(cfg);
      expect(count).toBe(0);
    }
  });

  it("registers unknown event keys anyway (advisory warning, not a load failure)", async () => {
    writeDiscoveredHook("typo-hook", {
      events: ["command:nwe", "command:new"],
    });

    const count = await commitPreparedHooks(createHooksConfig(["typo-hook"]));

    expect(count).toBe(1);
    expect(hasInternalHookListeners("command", "nwe")).toBe(true);
    expect(hasInternalHookListeners("command", "new")).toBe(true);
    await expectMessages(["typo-hook"]);
  });

  it("retains the committed hook generation after failed import", async () => {
    const handlerCode = 'throw new Error("candidate import failed");';
    writeDiscoveredHook("original");
    await commitPreparedHooks(createHooksConfig(["original"]));
    writeDiscoveredHook("replacement");
    writeDiscoveredHook("broken", { handlerCode });

    await expect(
      commitPreparedHooks(createHooksConfig(["replacement", "broken"])),
    ).rejects.toThrow();

    await expectMessages(["original"]);
  });

  it("keeps committed hooks serving while replacement imports are pending", async () => {
    writeDiscoveredHook("original");
    await commitPreparedHooks(createHooksConfig([], true));
    const importStarted = createDeferredCore();
    const releaseImport = createDeferredCore();
    vi.stubGlobal("openclawHookImportGate", {
      started: importStarted.resolve,
      wait: releaseImport.promise,
    });
    writeDiscoveredHook("replacement", {
      handlerCode:
        'globalThis.openclawHookImportGate.started(); await globalThis.openclawHookImportGate.wait; export default async function(event) { event.messages.push("replacement"); }',
    });
    const loading = prepare(createHooksConfig(["replacement"]));
    try {
      await importStarted.promise;
      await expectMessages(["original"]);
    } finally {
      releaseImport.resolve();
      await loading;
    }
    const prepared = await loading;
    await expectMessages(["original"]);
    prepared.commit();
    await expectMessages(["replacement"]);
  });

  it.each(["missing", "outside hook directory"])(
    "retains active handlers when a selected handler becomes %s before sibling reload",
    async (failure) => {
      const hookDir = writeDiscoveredHook("original");
      const config = createHooksConfig(["original"]);
      await commitPreparedHooks(config);
      await expectMessages(["original"]);

      const handlerPath = path.join(hookDir, "handler.js");
      await fs.unlink(handlerPath);
      if (failure === "outside hook directory") {
        const outside = path.join(tmpDir, "outside.js");
        await fs.writeFile(outside, "export default async function() {}\n");
        await fs.symlink(outside, handlerPath);
      }
      writeDiscoveredHook("sibling");
      await expect(
        commitPreparedHooks(createHooksConfig(["original", "sibling"])),
      ).rejects.toThrow();
      await expectMessages(["original"]);
    },
  );

  it.each(["descriptor", "oversized metadata", "invalid metadata"])(
    "retains active handlers when its configured source loses %s before sibling reload",
    async (failure) => {
      const extraDir = path.join(tmpDir, "extra-hooks");
      const original = writeDiscoveredHook("original", {
        sourceDir: extraDir,
        hookKey: "selected-name",
      });
      const sourceOptions = { managedHooksDir: path.join(tmpDir, "managed-none") };
      const config = createHooksConfig(["selected-name"], undefined, [extraDir]);
      await commitPreparedHooks(config, sourceOptions);
      await expectMessages(["original"]);

      if (failure === "descriptor") {
        await fs.unlink(path.join(original, "HOOK.md"));
      } else {
        await fs.writeFile(
          path.join(original, "HOOK.md"),
          failure === "oversized metadata"
            ? "x".repeat(1024 * 1024 + 1)
            : "---\nname: original\nmetadata: {invalid\n---\n",
        );
      }
      writeDiscoveredHook("sibling", { sourceDir: extraDir });
      await expect(commitPreparedHooks(config, sourceOptions)).rejects.toThrow();
      await expectMessages(["original"]);
    },
  );

  it("ignores a missing handler for a collision loser during atomic reload", async () => {
    writeDiscoveredHook("valid");
    const broken = writeDiscoveredHook("valid", { sourceDir: path.join(tmpDir, "hooks") });
    await fs.unlink(path.join(broken, "handler.js"));

    await expect(
      commitPreparedHooks({ browser: { enabled: false }, ...createHooksConfig(["valid"]) }),
    ).resolves.toBe(1);
    await expectMessages(["valid"]);
  });

  it("does not activate a shadowed hook when its ineligible override loses its handler", async () => {
    const bundledHooksDir = path.join(tmpDir, "bundled-hooks");
    const sourceOptions = { bundledHooksDir, managedHooksDir };
    writeDiscoveredHook("overridden", {
      sourceDir: bundledHooksDir,
      hookKey: "bundled-selection",
      handlerCode: 'export default async function(event) { event.messages.push("bundled"); }',
    });
    const overriding = writeDiscoveredHook("overridden", {
      hookKey: "managed-selection",
      requires: { config: ["browser.enabled"] },
    });
    const entries = {
      "bundled-selection": { enabled: true },
      "managed-selection": { enabled: true },
    };
    const config: OpenClawConfig = {
      browser: { enabled: false },
      hooks: { internal: { entries } },
    };
    await expect(commitPreparedHooks(config, sourceOptions)).resolves.toBe(0);
    await expectMessages([]);

    await fs.unlink(path.join(overriding, "handler.js"));
    writeDiscoveredHook("sibling");
    await commitPreparedHooks(
      {
        ...config,
        hooks: { internal: { entries: { ...entries, sibling: { enabled: true } } } },
      },
      sourceOptions,
    );
    await expectMessages(["sibling"]);
  });

  it.each(["disable", "install removal"])(
    "accepts intentional %s after a winning source disappears",
    async (removal) => {
      const bundledHooksDir = path.join(tmpDir, "bundled-hooks");
      const extraDir = path.join(tmpDir, "extra-hooks");
      const sourceOptions = { bundledHooksDir, managedHooksDir };
      writeDiscoveredHook("original", {
        sourceDir: bundledHooksDir,
        hookKey: "lower-name",
        handlerCode: 'export default async function(event) { event.messages.push("lower"); }',
      });
      const original = writeDiscoveredHook("original", {
        sourceDir: extraDir,
        hookKey: "selected-name",
        requires: { config: ["browser.enabled"] },
      });
      const config: OpenClawConfig = {
        browser: { enabled: true },
        ...createHooksConfig(
          removal === "install removal" ? ["lower-name"] : ["lower-name", "selected-name"],
          undefined,
          [extraDir],
        ),
      };
      const state = await import("./installs.js");
      const installed = vi.spyOn(state, "readHookInstallsAsync");
      installed.mockResolvedValue(
        removal === "install removal" ? { pack: { source: "path", hooks: ["selected-name"] } } : {},
      );
      try {
        await commitPreparedHooks(config, sourceOptions);
        await fs.rm(original, { recursive: true });
        writeDiscoveredHook("sibling");
        const entries: Record<string, { enabled?: boolean }> = {
          ...config.hooks?.internal?.entries,
          sibling: { enabled: true },
        };
        if (removal === "disable") {
          entries["selected-name"] = { enabled: false };
        }
        if (removal === "install removal") {
          installed.mockResolvedValue({});
        }
        const next: OpenClawConfig = {
          ...config,
          hooks: { internal: { ...config.hooks?.internal, entries } },
        };
        await commitPreparedHooks(next, sourceOptions);
        await expectMessages(removal === "disable" ? ["sibling"] : ["lower", "sibling"]);
      } finally {
        installed.mockRestore();
      }
    },
  );

  it("commits disable and re-enable for registered internal hook listeners", async () => {
    const handler = vi.fn();
    registerInternalHook("command:new", handler);
    const disabled = await prepare(createHooksConfig([], false));
    await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
    expect(handler).toHaveBeenCalledTimes(1);
    disabled.commit();
    await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
    expect(handler).toHaveBeenCalledTimes(1);

    const enabled = await prepare(createHooksConfig([], true));
    await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
    expect(handler).toHaveBeenCalledTimes(1);
    enabled.commit();
    await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each(["before preparation", "after preparation", "after shutdown"])(
    "keeps deferred startup from overwriting ownership transferred %s",
    async (transfer) => {
      await drainGlobalSingletonLifecycleState("restart");
      const handler = vi.fn();
      registerInternalHook("command:new", handler);
      const disable = () => commitPreparedHooks({ hooks: { internal: { enabled: false } } });
      if (transfer === "before preparation") {
        await disable();
      }
      const startup = await prepare(createHooksConfig([], true));
      if (transfer === "after preparation") {
        await disable();
      } else if (transfer === "after shutdown") {
        await drainGlobalSingletonLifecycleState("restart");
        await disable();
      }

      expect(startup.commit({ initial: true })).toBe(false);
      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(["replacement", "disable"])(
    "finishes an admitted event's original handlers across %s",
    async (change) => {
      const started = createDeferredCore();
      const release = createDeferredCore();
      registerInternalHook("command", async () => {
        started.resolve();
        await release.promise;
      });
      writeDiscoveredHook("original");
      await commitPreparedHooks(createHooksConfig([], true));
      const originalEvent = createInternalHookEvent("command", "new", "test-session");
      const dispatch = triggerInternalHook(originalEvent);
      try {
        await started.promise;
        writeDiscoveredHook("replacement");
        await commitPreparedHooks(
          createHooksConfig(["replacement"], change !== "disable"),
          options,
        );
      } finally {
        release.resolve();
        await dispatch;
      }
      expect(originalEvent.messages).toEqual(["original"]);
      await expectMessages(change === "disable" ? [] : ["replacement"]);
    },
  );

  it("keeps configured hooks across plugin cleanup and retires them on Gateway restart", async () => {
    writeDiscoveredHook("managed");
    await commitPreparedHooks(createHooksConfig([], true), { managedHooksDir });
    const unrelated = vi.fn();
    registerInternalHook("command:new", unrelated);

    await drainGlobalSingletonLifecycleState("plugin-registry");
    await expectMessages(["managed"]);
    expect(unrelated).toHaveBeenCalledTimes(1);

    await drainGlobalSingletonLifecycleState("restart");
    await expectMessages([]);
    expect(unrelated).toHaveBeenCalledTimes(2);
  });

  it("skips invalid handlers while preserving a named-export sibling during best-effort startup", async () => {
    writeDiscoveredHook("bad-export", {
      handlerCode: 'export default "not a function";\n',
    });

    writeDiscoveredHook("valid", {
      exportName: "myHandler",
      handlerCode: 'export const myHandler = async (event) => { event.messages.push("valid"); };\n',
    });
    const count = await commitPreparedHooks(createHooksConfig(["bad-export", "valid"], true), {
      ...options,
      failureMode: "best-effort",
    });
    expect(count).toBe(1);
    await expectMessages(["valid"]);
  });

  it("keeps workspace hooks disabled by default until explicitly enabled", async () => {
    writeDiscoveredHook("workspace-hook", { sourceDir: path.join(tmpDir, "hooks") });

    const disabledCount = await commitPreparedHooks(createHooksConfig([], true));
    expect(disabledCount).toBe(0);
    expect(hasInternalHookListeners("command", "new")).toBe(false);

    const enabledCount = await commitPreparedHooks(createHooksConfig(["workspace-hook"], true));
    expect(enabledCount).toBe(1);

    await expectMessages(["workspace-hook"]);
  });

  it("keeps managed hooks active when a workspace hook reuses the same name", async () => {
    writeDiscoveredHook("session-memory", {
      handlerCode: 'export default async function(event) { event.messages.push("managed"); }\n',
    });
    writeDiscoveredHook("session-memory", {
      sourceDir: path.join(tmpDir, "hooks"),
      handlerCode:
        'export default async function(event) { event.messages.push("workspace-override"); }\n',
    });

    const count = await commitPreparedHooks(createHooksConfig(["session-memory"], true), {
      managedHooksDir,
    });
    expect(count).toBe(1);

    await expectMessages(["managed"]);
  });

  describe("bundle plugin hooks", () => {
    let workspaceDir: string;
    beforeEach(() => {
      workspaceDir = tmpDir;
    });
    async function writeBundleFiles(root: string, files: Record<string, string>) {
      for (const [relative, content] of Object.entries(files)) {
        const file = path.join(root, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content, "utf-8");
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
      });
      writeDiscoveredHook("bundle-hook", {
        sourceDir: path.join(bundleRoot, "hooks"),
        handlerCode:
          'export default async (event) => { event.messages.push("bundle-hook-ok"); };\n',
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

    function expectBundleEntry(bundleRoot: string, config: OpenClawConfig) {
      expect(loadWorkspaceHookEntries(workspaceDir, { config })).toEqual([
        expect.objectContaining({
          hook: expect.objectContaining({
            name: "bundle-hook",
            source: "openclaw-plugin",
            pluginId: "sample-bundle",
            baseDir: fsSync.realpathSync.native(path.join(bundleRoot, "hooks", "bundle-hook")),
          }),
          metadata: expect.objectContaining({ events: ["command:new"] }),
        }),
      ]);
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
        if (supported.length > 0) {
          expectBundleEntry(bundleRoot, config);
        } else {
          expect(loadWorkspaceHookEntries(workspaceDir, { config })).toHaveLength(0);
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
      const scanManifests = vi.spyOn(
        manifestRegistry,
        "loadPluginManifestRegistryForInstalledIndex",
      );

      for (let iteration = 0; iteration < 2; iteration += 1) {
        expectBundleEntry(bundleRoot, config);
      }

      expect(scanManifests).not.toHaveBeenCalled();
    });

    it("commits candidate plugin hook policy from the immutable Gateway inventory", async () => {
      await writeBundleHookFixture();
      const config = createConfig(true);
      publishSnapshot(config);
      const manifestRegistry = await import("../plugins/manifest-registry-installed.js");
      const scanManifests = vi.spyOn(
        manifestRegistry,
        "loadPluginManifestRegistryForInstalledIndex",
      );
      const initial = await prepareInternalHooks(config, workspaceDir);
      expect(initial.loadedCount).toBe(1);
      initial.commit();

      for (const enabled of [false, true]) {
        const candidate = await prepareInternalHooks(createConfig(enabled), workspaceDir);
        expect(candidate.loadedCount).toBe(enabled ? 1 : 0);
        await expectMessages(enabled ? [] : ["bundle-hook-ok"]);
        candidate.commit();
        await expectMessages(enabled ? ["bundle-hook-ok"] : []);
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
        await fs.rm(failure === "root" ? hookRoot : path.join(hookRoot, "bundle-hook", "HOOK.md"), {
          recursive: true,
        });

        await expect(prepareInternalHooks(config, workspaceDir)).rejects.toThrow();
        await expectMessages(["bundle-hook-ok"]);
        (await prepareInternalHooks(createConfig(false), workspaceDir)).commit();
        await expectMessages([]);
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
});
