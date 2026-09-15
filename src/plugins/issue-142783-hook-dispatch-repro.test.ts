// Coverage for openclaw/openclaw#142783.
//
// [Bug]: Plugin typed hooks (before_prompt_build / agent_end) stop dispatching
// after multi-agent migration -- memory plugins dead.
//
// Mechanism: hook dispatch returns the active plugin "generation" registry
// EXCLUSIVELY whenever one is installed, and withPluginRuntimeGenerationScope
// (generation-scope.ts) used to default a missing generation registry to an
// EMPTY registry. A registry-less generation therefore hid typed hooks
// registered at the process root -- while non-hook plugin surfaces (memory
// prompt sections, tools, HTTP routes) kept working because they read the
// active/root registry.
//
// The two cases must stay distinct:
//   * a generation that CARRIES NO registry is a registry-less run; the empty
//     registry is only a placeholder, so process-root typed hooks must keep
//     dispatching (the regression above);
//   * a generation that CARRIES a registry -- including an explicitly empty
//     selection such as `plugins.enabled=false -> onlyPluginIds: []` -- is an
//     authoritative selection and stays exclusive.
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

it("dispatches root-registered typed hooks inside registry-less generation scopes (regression for #142783)", async () => {
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

  // 2) A generation scope with NO pluginRegistry is the registry-less run the
  //    reporter hit. It must not install the placeholder empty registry as the
  //    generation selection, so the process-root typed hook keeps dispatching.
  const scopedRegistryLess = await withPluginRuntimeGenerationScope(
    { metadataSnapshot: emptyMetadataSnapshot },
    runHook,
  );
  expect(scopedRegistryLess?.prependContext).toBe("hook-injected");

  // 3) A generation scope that carries the plugin registry dispatches too.
  const scopedIn = await withPluginRuntimeGenerationScope(
    { metadataSnapshot: emptyMetadataSnapshot, pluginRegistry: registry },
    runHook,
  );
  expect(scopedIn?.prependContext).toBe("hook-injected");

  // 4) After the generation scope ends the root path works again.
  expect((await runHook())?.prependContext).toBe("hook-injected");
});

it("keeps an explicitly empty generation selection exclusive", async () => {
  useNoBundledPlugins();
  const { registry } = loadRootRegistry();

  initializeGlobalHookRunner(registry);
  const runner = getGlobalHookRunner();
  expect(runner).not.toBeNull();

  // `plugins.enabled=false` resolves to an explicit empty selection. Empty is a
  // decision, not a missing inheritance: the retained root registration must not
  // execute inside this generation and receive its prompt/conversation event.
  const explicitlyEmpty = await withPluginRuntimeGenerationScope(
    {
      metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
      pluginRegistry: createEmptyPluginRegistry(),
    },
    () => runner!.runBeforePromptBuild({ prompt: "p", messages: [] }, {}),
  );
  expect(explicitlyEmpty).toBeUndefined();

  // The root registration is still intact outside that generation.
  expect(
    (await runner!.runBeforePromptBuild({ prompt: "p", messages: [] }, {}))?.prependContext,
  ).toBe("hook-injected");
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
