import { describe, expect, it } from "vitest";
import {
  buildWebProviderSnapshotCacheKey,
  fingerprintWebProviderResolutionConfig,
  mapRegistryProviders,
} from "./web-provider-resolution-shared.js";

describe("web-provider-resolution-shared", () => {
  it("distinguishes explicit empty plugin scopes in cache keys", () => {
    const unscoped = buildWebProviderSnapshotCacheKey({
      envKey: "demo",
    });
    const scopedEmpty = buildWebProviderSnapshotCacheKey({
      envKey: "demo",
      onlyPluginIds: [],
    });

    expect(scopedEmpty).not.toBe(unscoped);
  });

  it("treats explicit empty plugin scopes as scoped-empty when mapping providers", () => {
    const providers = mapRegistryProviders({
      entries: [
        {
          pluginId: "alpha",
          provider: { id: "alpha-provider" },
        },
        {
          pluginId: "beta",
          provider: { id: "beta-provider" },
        },
      ],
      onlyPluginIds: [],
      sortProviders: (values) => values,
    });

    expect(providers).toEqual([]);
  });

  it("produces equal fingerprints for equal-content configs with different key insertion order (greptile P2 on #73847)", () => {
    const aFirst = fingerprintWebProviderResolutionConfig({
      plugins: {
        entries: {
          alpha: { enabled: true, config: { x: 1, y: 2 } },
          beta: { enabled: false },
        },
      },
    } as never);
    const reordered = fingerprintWebProviderResolutionConfig({
      plugins: {
        entries: {
          beta: { enabled: false },
          alpha: { config: { y: 2, x: 1 }, enabled: true },
        },
      },
    } as never);

    expect(aFirst).toBe(reordered);
    expect(aFirst).not.toBe("");
  });

  it("produces different fingerprints for genuinely different configs (regression for #73847)", () => {
    const enabled = fingerprintWebProviderResolutionConfig({
      plugins: { entries: { alpha: { enabled: true } } },
    } as never);
    const disabled = fingerprintWebProviderResolutionConfig({
      plugins: { entries: { alpha: { enabled: false } } },
    } as never);

    expect(enabled).not.toBe(disabled);
  });

  it("returns empty fingerprint when no config is supplied (regression for #73847)", () => {
    expect(fingerprintWebProviderResolutionConfig(undefined)).toBe("");
  });

  it("includes the config-content fingerprint in the cache key (regression for #73730)", () => {
    const enabledKey = buildWebProviderSnapshotCacheKey({
      envKey: "demo",
      config: { plugins: { entries: { alpha: { enabled: true } } } } as never,
    });
    const disabledKey = buildWebProviderSnapshotCacheKey({
      envKey: "demo",
      config: { plugins: { entries: { alpha: { enabled: false } } } } as never,
    });

    expect(enabledKey).not.toBe(disabledKey);
  });
});
