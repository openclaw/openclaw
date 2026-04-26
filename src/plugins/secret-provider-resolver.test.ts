import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadEntriesMock, contractMock } = vi.hoisted(() => ({
  loadEntriesMock: vi.fn(),
  contractMock: vi.fn(),
}));

vi.mock("./secret-provider-public-artifacts.js", () => ({
  loadBundledSecretProviderEntriesFromDir: loadEntriesMock,
}));

vi.mock("./contracts/registry.js", () => ({
  resolveBundledPluginIdForSecretProviderSource: contractMock,
}));

import {
  _resetSecretProviderResolverCache,
  resolveBundledSecretProviderForSource,
} from "./secret-provider-resolver.js";

describe("resolveBundledSecretProviderForSource", () => {
  beforeEach(() => {
    _resetSecretProviderResolverCache();
    loadEntriesMock.mockReset();
    contractMock.mockReset();
  });

  it("returns undefined when no bundled plugin owns the source", async () => {
    contractMock.mockReturnValue(undefined);
    const out = await resolveBundledSecretProviderForSource("nonexistent");
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

    const a = await resolveBundledSecretProviderForSource("fakecloud");
    const b = await resolveBundledSecretProviderForSource("fakecloud");
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

    await resolveBundledSecretProviderForSource("fakecloud");
    expect(loadEntriesMock).toHaveBeenCalledTimes(1);

    _resetSecretProviderResolverCache();
    await resolveBundledSecretProviderForSource("fakecloud");
    expect(loadEntriesMock).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when artifact does not include the requested source id", async () => {
    contractMock.mockReturnValue("secrets-fakecloud");
    loadEntriesMock.mockReturnValue([
      { id: "other", pluginId: "secrets-fakecloud", label: "x", resolve: vi.fn() },
    ]);
    const out = await resolveBundledSecretProviderForSource("fakecloud");
    expect(out).toBeUndefined();
  });

  it("propagates loader errors with plugin context", async () => {
    contractMock.mockReturnValue("secrets-broken");
    loadEntriesMock.mockImplementation(() => {
      throw new Error("Unable to initialize secret providers for plugin secrets-broken");
    });
    await expect(resolveBundledSecretProviderForSource("broken")).rejects.toThrow(/secrets-broken/);
  });

  it("returns undefined when the loader returns null (no artifact present)", async () => {
    contractMock.mockReturnValue("secrets-no-artifact");
    loadEntriesMock.mockReturnValue(null);
    const out = await resolveBundledSecretProviderForSource("noart");
    expect(out).toBeUndefined();
  });
});
