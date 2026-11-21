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
import { pinConfigDir } from "../utils.js";
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

  function prepare(cfg: OpenClawConfig, opts?: Parameters<typeof prepareInternalHooks>[2]) {
    return prepareInternalHooks(cfg, tmpDir, opts);
  }

  async function load(cfg: OpenClawConfig, opts?: Parameters<typeof prepareInternalHooks>[2]) {
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
    managedHooksDir = path.join(tmpDir, "managed", "hooks");
    pinConfigDir({ OPENCLAW_STATE_DIR: path.dirname(managedHooksDir) });
    vi.stubEnv("OPENCLAW_BUNDLED_HOOKS_DIR", "/nonexistent/bundled/hooks");
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  function writeHook(
    name: string,
    {
      sourceDir = managedHooksDir,
      handlerCode,
      message = name,
      ...metadata
    }: Partial<OpenClawHookMetadata> & {
      sourceDir?: string;
      handlerCode?: string;
      message?: string;
    } = {},
  ) {
    const hookDir = path.join(sourceDir, name);
    writeHookFixture(
      hookDir,
      `---\nname: ${name}\nmetadata: ${JSON.stringify({ openclaw: { events: ["command:new"], ...metadata } })}\n---\n`,
      handlerCode ??
        `export default async function(event) { event.messages.push(${JSON.stringify(message)}); }\n`,
      "handler.js",
    );
    return hookDir;
  }

  function hookConfig(
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
    pinConfigDir();
    vi.unstubAllGlobals();
  });

  it("skips hook discovery until internal hooks are configured", async () => {
    for (const cfg of [
      {} satisfies OpenClawConfig,
      { hooks: {} } satisfies OpenClawConfig,
      { hooks: { internal: {} } } satisfies OpenClawConfig,
    ]) {
      const count = await load(cfg);
      expect(count).toBe(0);
    }
  });

  it("registers unknown event keys anyway (advisory warning, not a load failure)", async () => {
    writeHook("typo-hook", {
      events: ["command:nwe", "command:new"],
    });

    const count = await load(hookConfig(["typo-hook"]));

    expect(count).toBe(1);
    expect(hasInternalHookListeners("command", "nwe")).toBe(true);
    expect(hasInternalHookListeners("command", "new")).toBe(true);
    await expectMessages(["typo-hook"]);
  });

  it("keeps committed hooks serving while replacement imports are pending", async () => {
    writeHook("original");
    await load(hookConfig([], true));
    const importStarted = createDeferredCore();
    const releaseImport = createDeferredCore();
    vi.stubGlobal("openclawHookImportGate", {
      started: importStarted.resolve,
      wait: releaseImport.promise,
    });
    writeHook("replacement", {
      handlerCode:
        'globalThis.openclawHookImportGate.started(); await globalThis.openclawHookImportGate.wait; export default async function(event) { event.messages.push("replacement"); }',
    });
    const loading = prepare(hookConfig(["replacement"]));
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

  it.each(["import", "missing handler", "escaped handler", "descriptor", "oversized", "invalid"])(
    "retains active handlers after %s failure during sibling reload",
    async (failure) => {
      const extraDir = path.join(tmpDir, "extra-hooks");
      const original = writeHook("original", {
        sourceDir: extraDir,
        hookKey: "selected-name",
      });
      const config = hookConfig(["selected-name", "sibling"], undefined, [extraDir]);
      await load(config);
      await expectMessages(["original"]);
      const handler = path.join(original, "handler.js");
      const descriptor = path.join(original, "HOOK.md");
      if (failure === "import") {
        await fs.writeFile(handler, 'throw new Error("candidate import failed");');
      } else if (failure === "missing handler" || failure === "escaped handler") {
        await fs.unlink(handler);
        if (failure === "escaped handler") {
          const outside = path.join(tmpDir, "outside.js");
          await fs.writeFile(outside, "export default async function() {}");
          await fs.symlink(outside, handler);
        }
      } else if (failure === "descriptor") {
        await fs.unlink(descriptor);
      } else {
        await fs.writeFile(
          descriptor,
          failure === "oversized"
            ? "x".repeat(1024 * 1024 + 1)
            : "---\nname: original\nmetadata: {invalid\n---\n",
        );
      }
      writeHook("sibling", { sourceDir: extraDir });
      await expect(load(config)).rejects.toThrow();
      await expectMessages(["original"]);
    },
  );

  it("keeps managed code over a workspace collision, even after the losing handler disappears", async () => {
    writeHook("valid");
    const losing = writeHook("valid", {
      sourceDir: path.join(tmpDir, "hooks"),
      message: "workspace-override",
    });
    const config = { browser: { enabled: false }, ...hookConfig(["valid"]) };
    await expect(load(config)).resolves.toBe(1);
    await expectMessages(["valid"]);
    await fs.unlink(path.join(losing, "handler.js"));
    await expect(load(config)).resolves.toBe(1);
    await expectMessages(["valid"]);
  });

  it.each(["ineligible", "disable", "install removal"])(
    "preserves source precedence through %s of a missing winning hook",
    async (removal) => {
      const bundled = path.join(tmpDir, "bundled");
      const extraDir = path.join(tmpDir, "extra");
      vi.stubEnv("OPENCLAW_BUNDLED_HOOKS_DIR", bundled);
      writeHook("original", { sourceDir: bundled, hookKey: "lower-name", message: "lower" });
      const original = writeHook("original", {
        sourceDir: extraDir,
        hookKey: "selected-name",
        requires: { config: ["browser.enabled"] },
      });
      const config: OpenClawConfig = {
        browser: { enabled: removal !== "ineligible" },
        ...hookConfig(
          removal === "install removal" ? ["lower-name"] : ["lower-name", "selected-name"],
          undefined,
          [extraDir],
        ),
      };
      const state = await import("./installs.js");
      const installed =
        removal === "install removal"
          ? vi.spyOn(state, "readHookInstallsAsync").mockResolvedValue({
              pack: { source: "path", hooks: ["selected-name"] },
            })
          : undefined;
      await expect(load(config)).resolves.toBe(removal === "ineligible" ? 0 : 1);
      await expectMessages(removal === "ineligible" ? [] : ["original"]);
      if (removal === "ineligible") {
        await fs.unlink(path.join(original, "handler.js"));
      } else {
        await fs.rm(original, { recursive: true });
      }
      writeHook("sibling");
      installed?.mockResolvedValue({});
      const entries = {
        ...config.hooks?.internal?.entries,
        ...(removal === "disable" ? { "selected-name": { enabled: false } } : {}),
        sibling: { enabled: true },
      };
      await load({ ...config, hooks: { internal: { ...config.hooks?.internal, entries } } });
      await expectMessages(removal === "install removal" ? ["lower", "sibling"] : ["sibling"]);
    },
  );

  it("commits disable and re-enable for registered internal hook listeners", async () => {
    const handler = vi.fn();
    registerInternalHook("command:new", handler);
    for (const enabled of [false, true]) {
      const prepared = await prepare(hookConfig([], enabled));
      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
      expect(handler).toHaveBeenCalledTimes(1);
      prepared.commit();
      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
      expect(handler).toHaveBeenCalledTimes(enabled ? 2 : 1);
    }
  });

  it.each(["before preparation", "after preparation", "after shutdown"])(
    "keeps deferred startup from overwriting ownership transferred %s",
    async (transfer) => {
      await drainGlobalSingletonLifecycleState("restart");
      const handler = vi.fn();
      registerInternalHook("command:new", handler);
      const disable = () => load({ hooks: { internal: { enabled: false } } });
      if (transfer === "before preparation") {
        await disable();
      }
      const startup = await prepare(hookConfig([], true));
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
      writeHook("original");
      await load(hookConfig([], true));
      const originalEvent = createInternalHookEvent("command", "new", "test-session");
      const dispatch = triggerInternalHook(originalEvent);
      try {
        await started.promise;
        writeHook("replacement");
        await load(hookConfig(["replacement"], change !== "disable"));
      } finally {
        release.resolve();
        await dispatch;
      }
      expect(originalEvent.messages).toEqual(["original"]);
      await expectMessages(change === "disable" ? [] : ["replacement"]);
    },
  );

  it("keeps configured hooks across plugin cleanup and retires them on Gateway restart", async () => {
    writeHook("managed");
    await load(hookConfig([], true));
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
    writeHook("bad-export", {
      handlerCode: 'export default "not a function";\n',
    });

    writeHook("valid", {
      export: "myHandler",
      handlerCode: 'export const myHandler = async (event) => { event.messages.push("valid"); };\n',
    });
    const count = await load(hookConfig(["bad-export", "valid"], true), {
      failureMode: "best-effort",
    });
    expect(count).toBe(1);
    await expectMessages(["valid"]);
  });

  it("keeps workspace hooks disabled by default until explicitly enabled", async () => {
    writeHook("workspace-hook", { sourceDir: path.join(tmpDir, "hooks") });

    const disabledCount = await load(hookConfig([], true));
    expect(disabledCount).toBe(0);
    expect(hasInternalHookListeners("command", "new")).toBe(false);

    const enabledCount = await load(hookConfig(["workspace-hook"], true));
    expect(enabledCount).toBe(1);

    await expectMessages(["workspace-hook"]);
  });

  describe("bundle plugin hooks", () => {
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
      const bundleRoot = path.join(tmpDir, ".openclaw", "extensions", "sample-bundle");
      await writeBundleFiles(bundleRoot, {
        [`.${format}-plugin/plugin.json`]: JSON.stringify({
          name: "Sample Bundle",
          hooks: declaredRoot,
        }),
      });
      writeHook("bundle-hook", {
        sourceDir: path.join(bundleRoot, "hooks"),
        message: "bundle-hook-ok",
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
      const snapshot = loadPluginMetadataSnapshot({
        config,
        workspaceDir: tmpDir,
        env: process.env,
      });
      const publish = gateway ? setGatewayPluginMetadataSnapshot : setCurrentPluginMetadataSnapshot;
      publish(snapshot, { config, workspaceDir: tmpDir });
    }

    function expectBundleEntry(config: OpenClawConfig) {
      expect(
        loadWorkspaceHookEntries(tmpDir, { config }).map(({ hook }) => [
          hook.name,
          hook.source,
          hook.pluginId,
        ]),
      ).toEqual([["bundle-hook", "openclaw-plugin", "sample-bundle"]]);
    }

    function projectBundleComponents(pluginId: string, config: OpenClawConfig) {
      const metadata = loadPluginMetadataSnapshot({
        config,
        workspaceDir: tmpDir,
        env: process.env,
      });
      const manifest = metadata.manifestRegistry.plugins.find(({ id }) => id === pluginId);
      if (!manifest) {
        throw new Error(`Expected bundle manifest for ${pluginId}`);
      }
      const { declared } = buildPluginCapabilitySummary({ manifest, origin: manifest.origin });
      return projectInstalledPluginComponents({ manifest, declared });
    }

    it.each([
      { format: "codex", withJsonHooks: false, root: "hooks", supported: ["hooks"] },
      { format: "claude", withJsonHooks: false, root: "hooks", supported: ["hooks"] },
      { format: "claude", withJsonHooks: true, root: "hooks", supported: ["hooks"] },
      { format: "claude", withJsonHooks: false, root: "hooks/bundle-hook", supported: [] },
    ])(
      "matches $format hook components to discovery for $root with JSON hooks $withJsonHooks",
      async ({ format, withJsonHooks, root, supported }) => {
        await writeBundleHookFixture(format, withJsonHooks, root);
        const config = createConfig(true);
        if (supported.length > 0) {
          expectBundleEntry(config);
        } else {
          expect(loadWorkspaceHookEntries(tmpDir, { config })).toHaveLength(0);
        }

        expect(projectBundleComponents("sample-bundle", config)).toMatchObject({
          mapped: supported.length > 0 ? ["hooks"] : [],
          hooks: supported,
          unavailable: { capabilities: supported.length > 0 ? [] : ["hooks"] },
        });
      },
    );

    it.each([false, true])(
      "reuses published inventory through policy commits (gateway=%s)",
      async (gateway) => {
        await writeBundleHookFixture();
        const config = createConfig(true);
        publishSnapshot(config, gateway);
        const registry = await import("../plugins/manifest-registry-installed.js");
        const scan = vi.spyOn(registry, "loadPluginManifestRegistryForInstalledIndex");
        expectBundleEntry(config);
        expectBundleEntry(config);
        if (gateway) {
          const initial = await prepare(config);
          expect(initial.loadedCount).toBe(1);
          initial.commit();
          for (const enabled of [false, true]) {
            const candidate = await prepare(createConfig(enabled));
            expect(candidate.loadedCount).toBe(enabled ? 1 : 0);
            await expectMessages(enabled ? [] : ["bundle-hook-ok"]);
            candidate.commit();
            await expectMessages(enabled ? ["bundle-hook-ok"] : []);
          }
        }
        expect(scan).not.toHaveBeenCalled();
      },
    );

    it.each(["root", "descriptor"])(
      "retains a selected plugin hook after losing its %s until the plugin is disabled",
      async (failure) => {
        const bundleRoot = await writeBundleHookFixture();
        const config = createConfig(true);
        publishSnapshot(config);
        (await prepare(config)).commit();
        const hookRoot = path.join(bundleRoot, "hooks");
        await fs.rm(failure === "root" ? hookRoot : path.join(hookRoot, "bundle-hook", "HOOK.md"), {
          recursive: true,
        });

        await expect(prepare(config)).rejects.toThrow();
        await expectMessages(["bundle-hook-ok"]);
        (await prepare(createConfig(false))).commit();
        await expectMessages([]);
      },
    );

    it("does not treat Claude hooks.json bundles as OpenClaw hook packs", async () => {
      const bundleRoot = path.join(tmpDir, ".openclaw", "extensions", "claude-bundle");
      await writeBundleFiles(bundleRoot, {
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "Claude Bundle",
          hooks: [{ type: "command" }],
        }),
        "hooks/hooks.json": '{"hooks":[]}',
      });
      const config = createConfig(true, "claude-bundle");
      const entries = loadWorkspaceHookEntries(tmpDir, { config });
      expect(entries).toHaveLength(0);

      expect(projectBundleComponents("claude-bundle", config)).toMatchObject({
        mapped: [],
        hooks: [],
        unavailable: { capabilities: ["hooks"] },
      });
    });
  });
});
