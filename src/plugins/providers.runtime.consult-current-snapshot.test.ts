import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  makePluginMetadataIndex as makeIndex,
  makePluginMetadataManifestRegistry,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

const mocks = vi.hoisted(() => {
  // Shared workers must import the graph after this file's mocks are installed.
  vi.resetModules();
  return { registry: vi.fn(), manifests: vi.fn() };
});
vi.mock("./plugin-registry-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-registry-snapshot.js")>()),
  loadPluginRegistrySnapshotWithMetadata: (params: unknown) => mocks.registry(params),
}));
vi.mock("./manifest-registry-installed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest-registry-installed.js")>()),
  loadPluginManifestRegistryForInstalledIndex: (params: unknown) => mocks.manifests(params),
}));
import { resolveExternalAuthProfilesWithPlugins } from "./provider-runtime.js";
import { isPluginProvidersLoadInFlight } from "./providers.runtime.js";

let request = { config: {}, env: {}, workspaceDir: "/workspace/a" };
function armFallbackLoad(index = makeIndex()) {
  mocks.registry.mockReturnValue({ source: "runtime", snapshot: index, diagnostics: [] });
}
function registerCurrentSnapshot() {
  const index = makeIndex();
  index.policyHash = resolveInstalledPluginIndexPolicyHash(request.config);
  armFallbackLoad(index);
  setCurrentPluginMetadataSnapshot(loadPluginMetadataSnapshot({ ...request, index }), request);
  mocks.registry.mockClear();
  mocks.manifests.mockClear();
}
beforeEach(() => {
  request = { config: {}, env: {}, workspaceDir: "/workspace/a" };
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
  mocks.registry.mockReset();
  const registry = makePluginMetadataManifestRegistry("demo");
  for (const plugin of registry.plugins) {
    plugin.commandAliases = [];
  }
  mocks.manifests.mockReset().mockReturnValue(registry);
});
afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

it.each(["in-flight check", "external auth profiles"])(
  "reuses the current snapshot for %s",
  (consumer) => {
    registerCurrentSnapshot();
    if (consumer === "in-flight check") {
      isPluginProvidersLoadInFlight(request);
      expect(mocks.manifests).not.toHaveBeenCalled();
    } else {
      expect(
        resolveExternalAuthProfilesWithPlugins({
          ...request,
          context: { env: {}, store: { version: 1, profiles: {} } },
        }),
      ).toEqual([]);
    }
    expect(mocks.registry).not.toHaveBeenCalled();
  },
);
it("falls back to a direct disk load without a current snapshot", () => {
  armFallbackLoad();
  isPluginProvidersLoadInFlight(request);
  expect(mocks.registry).toHaveBeenCalled();
});
