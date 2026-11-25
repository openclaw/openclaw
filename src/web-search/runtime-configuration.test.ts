import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { authProfileRuntimeMode } from "../agents/auth-profiles/runtime-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as authProfileSource from "../agents/auth-profiles/source-check.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { clearActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import {
  createOAuthAuthProfileStore,
  createWebSearchTestProvider,
} from "../test-utils/web-provider-runtime.test-helpers.js";
import {
  hasConfiguredWebSearchProvider as isConfigured,
  prepareWebSearchConfiguration as prepareConfiguration,
} from "./runtime.js";

// mock-isolation: Use fixed discovery policy without opening machine state for provider fixtures.
vi.mock("../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));

const { providersMock } = vi.hoisted(() => ({
  providersMock: vi.fn<() => ReturnType<typeof createWebSearchTestProvider>[]>(() => []),
}));
// mock-isolation: Only local provider descriptors participate in this configuration-presence matrix.
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: providersMock,
  resolveRuntimeWebSearchProviders: providersMock,
}));

const provider = createWebSearchTestProvider({
  pluginId: "custom-search",
  id: "custom",
  credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
  createTool: () => {
    throw new Error("Configuration checks must not construct provider tools");
  },
});
const useProvider = (overrides: Partial<typeof provider> = {}) =>
  providersMock.mockReturnValue([{ ...provider, ...overrides }]);

const emptyStore = (): AuthProfileStore => ({ version: 1, profiles: {} });
const prepare = (authStore?: AuthProfileStore) => prepareConfiguration({ config: {}, authStore });
const agentDir = () => resolveDefaultAgentDir({});
const publish = (store: AuthProfileStore) => setRuntimeAuthProfileStoreSnapshot(store, agentDir());
const oauth = { provider: "xai", profileId: "xai:test", access: "access", refresh: "refresh" };
const oauthStore = () => createOAuthAuthProfileStore(oauth);

beforeEach(() => {
  noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" });
  clearRuntimeConfigSnapshot();
  clearActiveRuntimeWebToolsMetadata();
  providersMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  vi.unstubAllEnvs();
});

it("uses the supplied auth owner only when configuration needs source presence", async () => {
  vi.spyOn(authProfileSource, "hasAnyAuthProfileStoreSourceAsync").mockRejectedValue(
    new Error("Unexpected standalone auth admission"),
  );
  const prepareAuthSource = vi.fn(async () => emptyStore());
  const check = (config = {}) => prepareConfiguration({ config }, prepareAuthSource);
  useProvider({ authProviderId: "xai" });
  await expect(check()).resolves.toBe(false);
  expect(prepareAuthSource).toHaveBeenCalledExactlyOnceWith(agentDir());
  prepareAuthSource.mockClear();
  await expect(check({ tools: { web: { search: { provider: "custom" } } } })).resolves.toBe(true);
  expect(prepareAuthSource).not.toHaveBeenCalled();
});

it("uses published auth stores without cold admission", async () => {
  const sourceProbe = vi.spyOn(authProfileSource, "hasAnyAuthProfileStoreSourceAsync");
  useProvider({ authProviderId: "xai" });
  publish(oauthStore());
  await expect(prepare()).resolves.toBe(true);
  expect(sourceProbe).not.toHaveBeenCalled();
  await expect(authProfileRuntimeMode.run({ kind: "env-only" }, () => prepare())).resolves.toBe(
    false,
  );
  sourceProbe.mockClear();
  publish(emptyStore());
  await expect(prepare()).resolves.toBe(false);
  expect(sourceProbe).not.toHaveBeenCalled();
});

it.each([
  ["absent", undefined, false],
  ["empty", "  ", false],
  ["inline", "test-search-key", true],
  ["unresolved env ref", { source: "env", provider: "default", id: "UNSET_KEY" }, true],
  ["unresolved file ref", { source: "file", provider: "default", id: "/search/key" }, true],
] as const)("distinguishes %s configuration from provider health", (_name, value, configured) => {
  useProvider({ getConfiguredCredentialValue: () => value });
  expect(isConfigured({ config: {}, authStore: emptyStore() })).toBe(configured);
});

it("detects provider-owned env, fallback, and agent OAuth without executing providers", async () => {
  vi.stubEnv("CUSTOM_API_KEY", "test-search-key");
  useProvider();
  expect(await prepare()).toBe(true);
  vi.unstubAllEnvs();
  useProvider({
    getConfiguredCredentialFallback: () => ({ value: "key", path: "fallback.apiKey" }),
  });
  expect(await prepare()).toBe(true);
  useProvider({ authProviderId: "xai" });
  expect(await prepare(oauthStore())).toBe(true);
});

it("does not auto-select key-free providers but preserves explicit selection and unavailable setup", () => {
  useProvider({ requiresCredential: false });
  expect(isConfigured({ config: {} })).toBe(false);
  const config = { tools: { web: { search: { provider: "uninstalled-provider" } } } };
  expect(isConfigured({ config })).toBe(true);
  expect(
    isConfigured({
      config: {},
      runtimeWebSearch: {
        providerSource: "none",
        diagnostics: [
          { code: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK", message: "private diagnostic" },
        ],
      },
    }),
  ).toBe(true);
});
