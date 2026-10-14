import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createModelCatalogProviderAliasCanonicalizer", () => {
  it("canonicalizes manifest-owned provider aliases", () => {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
    const canonicalizer = createModelCatalogProviderAliasCanonicalizer({ cfg: {} });

    expect(canonicalizer.ref({ provider: "z.ai", model: "glm-4.7" })).toEqual({
      provider: "zai",
      model: "glm-4.7",
    });
  });

  it("recovers bundled source aliases when stale dist metadata omits them", () => {
    const root = tempDirs.make("openclaw-model-alias-source-");
    const distPluginRoot = path.join(root, "dist", "extensions", "zai");
    const sourcePluginRoot = path.join(root, "extensions", "zai");
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
      cfg: {},
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
  });
});
