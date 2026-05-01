import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { resolveBundledProviderPolicySurface } from "./provider-public-artifacts.js";

describe("provider public artifacts", () => {
  afterEach(() => {
    vi.doUnmock("./bundled-dir.js");
    vi.doUnmock("./public-surface-loader.js");
    vi.resetModules();
  });

  it("loads a lightweight bundled provider policy artifact smoke", () => {
    const surface = resolveBundledProviderPolicySurface("openai");
    expect(surface?.normalizeConfig).toBeTypeOf("function");

    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      models: [],
    };
    expect(
      surface?.normalizeConfig?.({
        provider: "openai",
        providerConfig,
      }),
    ).toBe(providerConfig);
  });

  it("resolves multi-provider policy artifacts by manifest-owned provider id", async () => {
    const bundledPluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provider-policy-"));
    const pluginDir = path.join(bundledPluginsDir, "openai");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({ providers: ["openai", "openai-codex"] }),
    );

    const resolveThinkingProfile = vi.fn(({ modelId }: { modelId: string }) => ({
      levels: modelId === "gpt-5.5" ? [{ id: "xhigh" }] : [{ id: "low" }],
    }));
    const loadBundledPluginPublicArtifactModuleSync = vi.fn(({ dirName }: { dirName: string }) => {
      if (dirName !== "openai") {
        throw new Error(`Unable to resolve bundled plugin public surface ${dirName}`);
      }
      return { resolveThinkingProfile };
    });

    vi.doMock("./bundled-dir.js", () => ({
      resolveBundledPluginsDir: () => bundledPluginsDir,
    }));
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleSync,
    }));
    vi.resetModules();

    try {
      const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
        typeof import("./provider-public-artifacts.js")
      >(import.meta.url, "./provider-public-artifacts.js?scope=provider-alias");

      const surface = resolvePolicySurface("openai-codex");

      expect(surface?.resolveThinkingProfile).toBeTypeOf("function");
      expect(loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
        dirName: "openai",
        artifactBasename: "provider-policy-api.js",
      });
      expect(
        surface
          ?.resolveThinkingProfile?.({
            provider: "openai-codex",
            modelId: "gpt-5.5",
          })
          ?.levels.map((level) => level.id),
      ).toContain("xhigh");
      expect(
        surface
          ?.resolveThinkingProfile?.({
            provider: "openai-codex",
            modelId: "gpt-4.1",
          })
          ?.levels.map((level) => level.id),
      ).not.toContain("xhigh");
    } finally {
      fs.rmSync(bundledPluginsDir, { force: true, recursive: true });
    }
  });

  it("loads provider policy surfaces without package-manager repair", async () => {
    const loadBundledPluginPublicArtifactModuleSync = vi.fn(() => ({
      normalizeConfig: (ctx: { providerConfig: ModelProviderConfig }) => ctx.providerConfig,
    }));
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleSync,
    }));
    vi.resetModules();

    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=no-runtime-deps");

    const surface = resolvePolicySurface("openai");
    expect(surface?.normalizeConfig).toBeTypeOf("function");
    expect(loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "openai",
      artifactBasename: "provider-policy-api.js",
    });
  });
});
