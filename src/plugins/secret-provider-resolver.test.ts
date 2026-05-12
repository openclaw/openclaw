import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";

const { loadEntriesMock, contractMock, isEnabledMock } = vi.hoisted(() => ({
  loadEntriesMock: vi.fn(),
  contractMock: vi.fn(),
  isEnabledMock: vi.fn(),
}));

vi.mock("./secret-provider-public-artifacts.js", () => ({
  loadBundledSecretProviderEntriesFromDir: loadEntriesMock,
}));

vi.mock("./contracts/registry.js", () => ({
  resolveBundledPluginIdForSecretProviderSource: contractMock,
}));

vi.mock("./plugin-registry-snapshot.js", () => ({
  isPluginEnabled: isEnabledMock,
}));

import {
  _resetSecretProviderResolverCache,
  resolveBundledSecretProviderForSource,
} from "./secret-provider-resolver.js";

const enabledConfig = { plugins: { enabled: true } } as unknown as OpenClawConfig;

describe("resolveBundledSecretProviderForSource", () => {
  beforeEach(() => {
    _resetSecretProviderResolverCache();
    loadEntriesMock.mockReset();
    contractMock.mockReset();
    isEnabledMock.mockReset();
    // Default: assume the owning plugin is enabled. Activation-specific tests
    // override this.
    isEnabledMock.mockReturnValue(true);
  });

  it("returns undefined when no bundled plugin owns the source", async () => {
    contractMock.mockReturnValue(undefined);
    const out = await resolveBundledSecretProviderForSource("nonexistent", enabledConfig);
    expect(out).toBeUndefined();
    expect(loadEntriesMock).not.toHaveBeenCalled();
  });

  it("loads, validates, and caches a matching artifact", async () => {
    contractMock.mockReturnValue("secrets-fakecloud");
    const fakeEntry = {
      id: "fakecloud",
      pluginId: "secrets-fakecloud",
      label: "Fake Cloud",
      resolve: vi.fn(),
    };
    loadEntriesMock.mockReturnValue([fakeEntry]);

    const a = await resolveBundledSecretProviderForSource("fakecloud", enabledConfig);
    const b = await resolveBundledSecretProviderForSource("fakecloud", enabledConfig);
    expect(a).toBe(fakeEntry);
    expect(b).toBe(fakeEntry);
    // Cache hit: only one call to load entries.
    expect(loadEntriesMock).toHaveBeenCalledTimes(1);
  });

  it("_resetSecretProviderResolverCache forces a fresh load", async () => {
    contractMock.mockReturnValue("secrets-fakecloud");
    loadEntriesMock.mockReturnValue([
      { id: "fakecloud", pluginId: "secrets-fakecloud", label: "Fake", resolve: vi.fn() },
    ]);

    await resolveBundledSecretProviderForSource("fakecloud", enabledConfig);
    expect(loadEntriesMock).toHaveBeenCalledTimes(1);

    _resetSecretProviderResolverCache();
    await resolveBundledSecretProviderForSource("fakecloud", enabledConfig);
    expect(loadEntriesMock).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when artifact does not include the requested source id", async () => {
    contractMock.mockReturnValue("secrets-fakecloud");
    loadEntriesMock.mockReturnValue([
      { id: "other", pluginId: "secrets-fakecloud", label: "x", resolve: vi.fn() },
    ]);
    const out = await resolveBundledSecretProviderForSource("fakecloud", enabledConfig);
    expect(out).toBeUndefined();
  });

  it("propagates loader errors with plugin context", async () => {
    contractMock.mockReturnValue("secrets-broken");
    loadEntriesMock.mockImplementation(() => {
      throw new Error("Unable to initialize secret providers for plugin secrets-broken");
    });
    await expect(resolveBundledSecretProviderForSource("broken", enabledConfig)).rejects.toThrow(
      /secrets-broken/,
    );
  });

  it("returns undefined when the loader returns null (no artifact present)", async () => {
    contractMock.mockReturnValue("secrets-no-artifact");
    loadEntriesMock.mockReturnValue(null);
    const out = await resolveBundledSecretProviderForSource("noart", enabledConfig);
    expect(out).toBeUndefined();
  });

  describe("activation gate", () => {
    it("returns undefined when the owning plugin is disabled (denylist, default-off, etc.)", async () => {
      contractMock.mockReturnValue("secrets-fakecloud");
      isEnabledMock.mockReturnValue(false);

      const out = await resolveBundledSecretProviderForSource("fakecloud", enabledConfig);
      expect(out).toBeUndefined();
      // Disabled plugins must not have their artifact loaded — that's the
      // whole security boundary the gate protects.
      expect(loadEntriesMock).not.toHaveBeenCalled();
      // And the disabled state is not cached, so flipping the plugin to
      // enabled later must work (covered in a separate test).
      expect(isEnabledMock).toHaveBeenCalledWith({
        pluginId: "secrets-fakecloud",
        config: enabledConfig,
      });
    });

    it("does not cache the disabled state — re-enabling the plugin lets it resolve", async () => {
      contractMock.mockReturnValue("secrets-fakecloud");
      const fakeEntry = {
        id: "fakecloud",
        pluginId: "secrets-fakecloud",
        label: "Fake",
        resolve: vi.fn(),
      };
      loadEntriesMock.mockReturnValue([fakeEntry]);

      // Round 1: plugin disabled.
      isEnabledMock.mockReturnValueOnce(false);
      const first = await resolveBundledSecretProviderForSource("fakecloud", enabledConfig);
      expect(first).toBeUndefined();
      expect(loadEntriesMock).not.toHaveBeenCalled();

      // Round 2: plugin re-enabled. Same source must now resolve, proving
      // round 1 didn't poison the cache with a disabled-state sentinel.
      isEnabledMock.mockReturnValueOnce(true);
      const second = await resolveBundledSecretProviderForSource("fakecloud", enabledConfig);
      expect(second).toBe(fakeEntry);
      expect(loadEntriesMock).toHaveBeenCalledTimes(1);
    });

    it("rechecks activation on cache hits (artifact cached, activation re-evaluated)", async () => {
      contractMock.mockReturnValue("secrets-fakecloud");
      const fakeEntry = {
        id: "fakecloud",
        pluginId: "secrets-fakecloud",
        label: "Fake",
        resolve: vi.fn(),
      };
      loadEntriesMock.mockReturnValue([fakeEntry]);

      // First call: enabled → loads + caches the artifact.
      isEnabledMock.mockReturnValueOnce(true);
      const first = await resolveBundledSecretProviderForSource("fakecloud", enabledConfig);
      expect(first).toBe(fakeEntry);
      expect(loadEntriesMock).toHaveBeenCalledTimes(1);

      // Second call: plugin now disabled (e.g. operator denylisted it). Cache
      // hit must NOT bypass the activation re-check.
      isEnabledMock.mockReturnValueOnce(false);
      const second = await resolveBundledSecretProviderForSource("fakecloud", enabledConfig);
      expect(second).toBeUndefined();
      // Artifact still only loaded once — we recheck activation, not reload.
      expect(loadEntriesMock).toHaveBeenCalledTimes(1);

      // Third call: re-enabled — cache + activation both pass.
      isEnabledMock.mockReturnValueOnce(true);
      const third = await resolveBundledSecretProviderForSource("fakecloud", enabledConfig);
      expect(third).toBe(fakeEntry);
      expect(loadEntriesMock).toHaveBeenCalledTimes(1);
    });

    it("forwards the runtime config to isPluginEnabled so denylist/entry/allow checks see the right state", async () => {
      contractMock.mockReturnValue("secrets-fakecloud");
      loadEntriesMock.mockReturnValue([
        { id: "fakecloud", pluginId: "secrets-fakecloud", label: "Fake", resolve: vi.fn() },
      ]);
      const customConfig = {
        plugins: { enabled: true, deny: ["secrets-fakecloud"] },
      } as unknown as OpenClawConfig;

      await resolveBundledSecretProviderForSource("fakecloud", customConfig);
      expect(isEnabledMock).toHaveBeenCalledWith({
        pluginId: "secrets-fakecloud",
        config: customConfig,
      });
    });
  });
});
