import { afterEach, describe, expect, it } from "vitest";
import type { SearchProviderPlugin } from "../../plugins/types.js";
import {
  clearSearchProviders,
  getSearchProvider,
  hasSearchProvider,
  listSearchProviders,
  registerSearchProvider,
  unregisterSearchProvider,
} from "./search-providers.js";

function stubProvider(id: string, label?: string): SearchProviderPlugin {
  return {
    id,
    label: label ?? `${id} provider`,
    async search(params) {
      return {
        query: params.query,
        provider: id,
        results: [],
      };
    },
  };
}

describe("search-providers registry", () => {
  afterEach(() => {
    clearSearchProviders();
  });

  it("registers and retrieves a provider", () => {
    const provider = stubProvider("acme");
    registerSearchProvider(provider);
    expect(getSearchProvider("acme")).toBe(provider);
    expect(hasSearchProvider("acme")).toBe(true);
  });

  it("performs case-insensitive lookup", () => {
    const provider = stubProvider("MySearch");
    registerSearchProvider(provider);
    expect(getSearchProvider("mysearch")).toBe(provider);
    expect(getSearchProvider("MYSEARCH")).toBe(provider);
    expect(getSearchProvider("  MySearch  ")).toBe(provider);
  });

  it("unregisters a provider", () => {
    registerSearchProvider(stubProvider("temp"));
    expect(unregisterSearchProvider("temp")).toBe(true);
    expect(hasSearchProvider("temp")).toBe(false);
    expect(unregisterSearchProvider("temp")).toBe(false);
  });

  it("lists all registered providers", () => {
    registerSearchProvider(stubProvider("alpha"));
    registerSearchProvider(stubProvider("beta"));
    const list = listSearchProviders();
    expect(list).toContain("alpha");
    expect(list).toContain("beta");
    expect(list).toHaveLength(2);
  });

  it("rejects duplicate registration", () => {
    registerSearchProvider(stubProvider("dup"));
    expect(() => registerSearchProvider(stubProvider("dup"))).toThrow(
      'Search provider "dup" is already registered',
    );
  });

  it("rejects empty id", () => {
    expect(() => registerSearchProvider(stubProvider(""))).toThrow(
      "Search provider must have a non-empty id",
    );
    expect(() => registerSearchProvider(stubProvider("   "))).toThrow(
      "Search provider must have a non-empty id",
    );
  });

  it("returns undefined for unregistered provider", () => {
    expect(getSearchProvider("nonexistent")).toBeUndefined();
  });

  it("clearSearchProviders removes all entries", () => {
    registerSearchProvider(stubProvider("a"));
    registerSearchProvider(stubProvider("b"));
    clearSearchProviders();
    expect(listSearchProviders()).toHaveLength(0);
  });
});
