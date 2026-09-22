import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("createModelCatalogProviderAliasCanonicalizer", () => {
  it("canonicalizes manifest-owned provider aliases in configured rows", () => {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));

    const canonicalizer = createModelCatalogProviderAliasCanonicalizer({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "z.ai/glm-4.7" },
            models: {
              "z.ai/glm-4.7": { alias: "GLM" },
            },
          },
        },
        models: { providers: {} },
      },
    });

    expect(canonicalizer.ref({ provider: "z.ai", model: "glm-4.7" })).toEqual({
      provider: "zai",
      model: "glm-4.7",
    });
  });

  it("recovers bundled source aliases when stale dist metadata omits them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-alias-source-"));
    try {
      const distPluginRoot = path.join(root, "dist", "extensions", "zai");
      const sourcePluginRoot = path.join(root, "extensions", "zai");
      fs.mkdirSync(distPluginRoot, { recursive: true });
      fs.mkdirSync(sourcePluginRoot, { recursive: true });
      fs.writeFileSync(
        path.join(sourcePluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: "zai",
          configSchema: { type: "object" },
          providers: ["zai"],
          modelCatalog: {
            aliases: {
              "z.ai": { provider: "zai" },
            },
          },
        }),
        "utf8",
      );

      const canonicalizer = createModelCatalogProviderAliasCanonicalizer({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "z.ai/glm-4.7" },
            },
          },
          models: { providers: {} },
        },
        metadataSnapshot: {
          manifestRegistry: {
            diagnostics: [],
            plugins: [
              {
                id: "zai",
                origin: "bundled",
                rootDir: distPluginRoot,
                source: path.join(distPluginRoot, "index.js"),
                providers: ["zai"],
                channels: [],
                cliBackends: [],
                skills: [],
                hooks: [],
                modelCatalog: { providers: {}, discovery: { zai: "static" } },
                manifestPath: path.join(distPluginRoot, "openclaw.plugin.json"),
              },
            ],
          },
        },
      });

      expect(canonicalizer.ref({ provider: "z.ai", model: "glm-4.7" })).toEqual({
        provider: "zai",
        model: "glm-4.7",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
