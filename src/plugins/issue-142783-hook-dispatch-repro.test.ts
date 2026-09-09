// Regression coverage for openclaw/openclaw#142783.
//
// [Bug]: Plugin typed hooks (before_prompt_build / agent_end) stop dispatching
// after multi-agent migration -- memory plugins dead.
//
// The reporter's exact deployment (memos-local-plugin registration code, full
// 8-agent config, macOS/launchd, memos SQLite) is not in the issue, so an exact
// end-to-end turn reproduction is impossible offline. This test instead
// exercises the registry-resolution boundary the regression report points at:
//   src/plugins/hook-runner-global-state.ts resolveHookRegistry()
//
// Regression mechanism: commit 02272c345f3 made hook dispatch return the
// active plugin "generation" registry EXCLUSIVELY whenever one is installed,
// and withPluginRuntimeGenerationScope (generation-scope.ts) defaults a
// missing generation registry to an EMPTY registry. A registry-less generation
// therefore hides typed hooks registered at the process root -- even though
// non-hook plugin surfaces (memory prompt sections, tools, HTTP routes) keep
// working because they read the active/root registry. A globally registered
// memory plugin that never makes it into a given generation's own registry is
// thus "dead" for per-turn typed hooks exactly as reported.
import { afterAll, afterEach, expect, it } from "vitest";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "./hook-runner-global.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

const PROBE_PLUGIN_ID = "memos-hook-probe";

function writeProbePlugin() {
  // Mirrors the memos-local-plugin registration surface from the issue:
  // a non-bundled plugin registering typed per-turn conversation hooks.
  return writePlugin({
    id: PROBE_PLUGIN_ID,
    body: `module.exports = {
  id: ${JSON.stringify(PROBE_PLUGIN_ID)},
  register(api) {
    api.on("before_prompt_build", async () => ({ prependContext: "hook-injected" }));
    api.on("agent_end", () => undefined);
    api.on("session_start", () => undefined);
  },
};\n`,
  });
}

function loadRootRegistry() {
  const plugin = writeProbePlugin();
  const config = {
    plugins: {
      allow: [PROBE_PLUGIN_ID],
      entries: {
        [PROBE_PLUGIN_ID]: {
          enabled: true,
          hooks: { allowConversationAccess: true },
        },
      },
      load: { paths: [plugin.file] },
    },
  };
  const workspaceDir = makePluginLoaderTempDir();
  const registry = loadOpenClawPlugins({
    config,
    cache: false,
    workspaceDir,
  });
  return { plugin, registry, workspaceDir };
}

it("dispatches root-registered typed hooks inside generation scopes that select no plugin content (regression for #142783)", async () => {
  useNoBundledPlugins();
  const { registry } = loadRootRegistry();
  const typedHookNames = registry.typedHooks
    .filter((hook) => hook.pluginId === PROBE_PLUGIN_ID)
    .map((hook) => hook.hookName)
    .toSorted();
  expect(typedHookNames).toEqual(["agent_end", "before_prompt_build", "session_start"]);

  initializeGlobalHookRunner(registry);
  const runner = getGlobalHookRunner();
  expect(runner).not.toBeNull();
  expect(runner!.hasHooks("before_prompt_build")).toBe(true);

  const emptyMetadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });
  const runHook = () => runner!.runBeforePromptBuild({ prompt: "p", messages: [] }, {});

  // 1) Baseline: no generation scope -> the root registry is consulted and the
  //    globally-registered typed hook fires (pre-migration behavior).
  expect((await runHook())?.prependContext).toBe("hook-injected");

  // 2) A generation scope with NO pluginRegistry installs the default EMPTY
  //    registry (generation-scope.ts). Because that empty registry selects no
  //    plugin content it must not silence the process-root typed hook -- this
  //    is the regression: before the fix the exclusive empty registry hid it.
  const scopedEmpty = await withPluginRuntimeGenerationScope(
    { metadataSnapshot: emptyMetadataSnapshot },
    runHook,
  );
  expect(scopedEmpty?.prependContext).toBe("hook-injected");

  // 3) An explicitly empty generation registry behaves the same: empty alone is
  //    not an exclusive selection, so root-registered hooks still dispatch.
  const scopedExplicitEmpty = await withPluginRuntimeGenerationScope(
    { metadataSnapshot: emptyMetadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
    runHook,
  );
  expect(scopedExplicitEmpty?.prependContext).toBe("hook-injected");

  // 4) A generation scope that carries the plugin restores dispatch (unchanged).
  const scopedIn = await withPluginRuntimeGenerationScope(
    { metadataSnapshot: emptyMetadataSnapshot, pluginRegistry: registry },
    runHook,
  );
  expect(scopedIn?.prependContext).toBe("hook-injected");

  // 5) After the generation scope ends the root path works again.
  expect((await runHook())?.prependContext).toBe("hook-injected");
});

it("keeps a content-bearing generation registry exclusive so narrow selections do not inherit unrelated root hooks", async () => {
  useNoBundledPlugins();
  const { registry } = loadRootRegistry();

  initializeGlobalHookRunner(registry);
  const runner = getGlobalHookRunner();
  expect(runner).not.toBeNull();

  // A generation that selects a different plugin (materialized owner record,
  // no hook registrations) is an exclusive scope: the memos-style root hook
  // must not fire inside it. This mirrors the fail-closed isolation probes
  // (disabled/errored owners) that must not inherit root hook policy.
  const isolatedRegistry = createEmptyPluginRegistry();
  isolatedRegistry.plugins = [
    createPluginRecord({ id: "other-plugin", name: "Other", status: "loaded" }),
  ];
  const emptyMetadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });
  const isolated = await withPluginRuntimeGenerationScope(
    { metadataSnapshot: emptyMetadataSnapshot, pluginRegistry: isolatedRegistry },
    () => runner!.runBeforePromptBuild({ prompt: "p", messages: [] }, {}),
  );
  expect(isolated?.prependContext).toBeUndefined();
});
