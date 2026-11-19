import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { listWebSearchProvidersAsync } from "./runtime.js";

const discovery = vi.hoisted(() => ({ prepare: vi.fn(), providers: vi.fn(() => []) }));

// mock-isolation: Control discovery preparation ordering without opening machine state.
vi.mock("../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: discovery.prepare,
  readBundledDiscoveryModeMemoized: () => undefined,
}));
// mock-isolation: Discovery ordering uses fixture providers without initializing the plugin loader.
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: discovery.providers,
  resolveRuntimeWebSearchProviders: discovery.providers,
}));

it("prepares persisted discovery policy before selecting runtime providers", async () => {
  const ready = createDeferredCore<() => void>();
  discovery.prepare.mockReturnValue(ready.promise);
  const pending = listWebSearchProvidersAsync({ config: {} });
  expect(discovery.prepare).toHaveBeenCalledOnce();
  expect(discovery.providers).not.toHaveBeenCalled();
  ready.resolve(() => {});
  await expect(pending).resolves.toEqual([]);
  expect(discovery.providers).toHaveBeenCalledOnce();
});
