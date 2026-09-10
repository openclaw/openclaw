import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveModelProviderAuthConfig } from "../agents/model-auth-provider-route.js";
import { resolveConfiguredModelCatalogOverrides } from "../agents/model-catalog-route.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnv } from "../test-utils/env.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { loadPluginManifest } from "./manifest.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createProviderModelCatalogIdNormalizer } from "./provider-model-routes.js";
import { resolveProviderPolicySurface } from "./provider-public-artifacts.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

describe("installed Arcee catalog identity", () => {
  function installed(
    trustedOfficialInstall: boolean,
    run: (root: string, snapshot: PluginMetadataSnapshot) => void,
  ) {
    const root = temporary.make("arcee-installed-policy-");
    const bundled = path.join(root, "bundled");
    const pluginRoot = path.join(root, "installed", "arcee");
    fs.mkdirSync(bundled);
    fs.mkdirSync(pluginRoot, { recursive: true });
    for (const file of ["provider-policy-api.ts", "package.json", "openclaw.plugin.json"]) {
      fs.copyFileSync(
        path.join(process.cwd(), "extensions", "arcee", file),
        path.join(pluginRoot, file),
      );
    }
    const loaded = loadPluginManifest(pluginRoot);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    expect(loaded.manifest.id).toBe("arcee");
    expect(loaded.manifest.providers).toEqual(["arcee"]);
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "arcee",
          origin: "global",
          rootDir: pluginRoot,
          providers: ["arcee"],
          providerAuthAliases: loaded.manifest.providerAuthAliases,
          trustedOfficialInstall,
        },
      ],
    });
    withEnv(
      { OPENCLAW_BUNDLED_PLUGINS_DIR: bundled, OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1" },
      () => {
        withPluginMetadataSnapshotScope(snapshot, () => run(pluginRoot, snapshot));
      },
    );
  }

  it("loads the actual Arcee policy through the existing trusted installed owner", () => {
    installed(true, (rootDir) => {
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "arcee",
            origin: "global",
            rootDir,
            providers: ["arcee"],
            trustedOfficialInstall: true,
          },
        ],
      });
      const surface = resolveProviderPolicySurface("arcee", {
        manifestRegistry: snapshot.manifestRegistry,
      });
      expect(
        surface?.normalizeModelCatalogId?.({
          provider: "arcee",
          modelId: "arcee-ai/trinity-large-thinking",
        }),
      ).toBe("trinity-large-thinking");
    });
  });

  it("uses that installed owner for authored-row identity", () => {
    installed(true, () => {
      expect(
        createProviderModelCatalogIdNormalizer("arcee")("arcee-ai/trinity-large-thinking"),
      ).toBe("trinity-large-thinking");
    });
  });

  it("does not load an untrusted installed owner's identity hook", () => {
    installed(false, () => {
      expect(
        createProviderModelCatalogIdNormalizer("arcee")("arcee-ai/trinity-large-thinking"),
      ).toBe("arcee-ai/trinity-large-thinking");
    });
  });
  it("honors an explicitly empty metadata owner over the ambient installed owner", () => {
    installed(true, () => {
      const empty = createPluginMetadataSnapshotFixture();
      expect(
        createProviderModelCatalogIdNormalizer("arcee", empty)("arcee-ai/trinity-large-thinking"),
      ).toBe("arcee-ai/trinity-large-thinking");
    });
  });

  it("keeps a captured normalizer bound to its prepared owner", () => {
    installed(true, () => {
      const normalize = createProviderModelCatalogIdNormalizer("arcee");
      withPluginMetadataSnapshotScope(createPluginMetadataSnapshotFixture(), () => {
        expect(normalize("arcee-ai/trinity-large-thinking")).toBe("trinity-large-thinking");
      });
    });
  });

  it("uses installed identity for authored catalog and endpoint auth", () => {
    installed(true, (_root, metadataSnapshot) => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            arcee: {
              api: "openai-completions",
              baseUrl: "https://api.arcee.ai/api/v1",
              models: [
                {
                  id: "arcee-ai/trinity-large-thinking",
                  name: "Authored route",
                  baseUrl: "https://openrouter.ai/api/v1",
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 32768,
                  maxTokens: 2048,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      };
      expect(
        resolveConfiguredModelCatalogOverrides({
          cfg,
          entry: { provider: "arcee", id: "trinity-large-thinking" },
        }),
      ).toMatchObject({ name: "Authored route", contextWindow: 32768 });
      const projected = resolveModelProviderAuthConfig({
        config: cfg,
        provider: "arcee",
        modelId: "trinity-large-thinking",
        metadataSnapshot,
      });
      expect(projected.models?.providers?.arcee?.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(cfg.models?.providers?.arcee?.baseUrl).toBe("https://api.arcee.ai/api/v1");
    });
  });
});
