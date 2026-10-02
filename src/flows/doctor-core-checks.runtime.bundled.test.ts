// Validate authored catalog rows and complete static provider configurations.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { buildManifestModelProviderConfig } from "../plugin-sdk/provider-catalog-shared.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const extensionsDir = path.join(repoRoot, "extensions");

describe("doctor bundled provider catalog validation", () => {
  it("normalizes every catalog without dropping rows and validates static providers", () => {
    const errors: string[] = [];

    for (const extension of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!extension.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(extensionsDir, extension.name, "openclaw.plugin.json");
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        id?: string;
        providers?: string[];
        modelCatalog?: { providers?: Record<string, unknown> };
      };
      const normalized = normalizeModelCatalog(manifest.modelCatalog, {
        ownedProviders: new Set(manifest.providers),
      });
      for (const [providerId, catalog] of Object.entries(manifest.modelCatalog?.providers ?? {})) {
        if (!manifest.providers?.includes(providerId)) {
          continue;
        }
        try {
          const rawCatalog = asOptionalRecord(catalog);
          const rawModels = rawCatalog?.models;
          if (!Array.isArray(rawModels)) {
            throw new Error("Manifest catalog normalization dropped a provider or model row");
          }
          const normalizedProvider = normalized?.providers?.[providerId];
          // The normalizer intentionally omits providers with no models or credential ownership.
          if (
            !normalizedProvider &&
            rawModels.length === 0 &&
            rawCatalog?.authScope === undefined
          ) {
            continue;
          }
          const models = normalizedProvider?.models;
          if (!Array.isArray(models) || models.length !== rawModels.length) {
            throw new Error("Manifest catalog normalization dropped a provider or model row");
          }
          // Decision-only rows have no conversational provider config. Still validate
          // every row above, and chat rows in mixed catalogs below.
          const chatModels = models.filter((model) => model.inference?.chat !== false);
          // Runtime catalogs supply endpoints; empty catalogs only declare credential
          // ownership. Discovery converts only populated static catalogs into configs.
          const discovery = normalized?.discovery?.[providerId];
          if (chatModels.length > 0 && discovery !== "runtime" && discovery !== "refreshable") {
            buildManifestModelProviderConfig({
              providerId,
              catalog: { ...asOptionalRecord(catalog), models: chatModels },
            });
          }
        } catch (error) {
          errors.push(`${manifest.id ?? extension.name}/${providerId}: ${String(error)}`);
        }
      }
    }

    expect(errors).toEqual([]);
  });
});
