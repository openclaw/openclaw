import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";

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
});
