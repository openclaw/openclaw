import { afterEach, describe, expect, it } from "vitest";
import { mergeScopedSearchConfig } from "../agents/tools/web-search-provider-config.js";
import {
  clearTrustedLegacyWebSearchPluginKeysForTest,
  markLegacyWebSearchPluginKeyTrusted,
  ToolsSchema,
} from "./zod-schema.agent-runtime.js";

function hasLegacyWebSearchIssue(
  result: ReturnType<typeof ToolsSchema.safeParse>,
  key: string,
): boolean {
  if (result.success) {
    return false;
  }
  return result.error.issues.some(
    (issue) =>
      issue.message.includes("legacy web_search provider config") &&
      issue.path.join(".") === `web.search.${key}`,
  );
}

describe("tools.web.search legacy provider key validation + plugin compatibility shim", () => {
  afterEach(() => {
    clearTrustedLegacyWebSearchPluginKeysForTest();
  });

  it("rejects a hand-written legacy provider record (no installed plugin claiming the key)", () => {
    const result = ToolsSchema.safeParse({
      web: { search: { provider: "perplexity", perplexity: { apiKey: "secret" } } },
    });
    expect(result.success).toBe(false);
    expect(hasLegacyWebSearchIssue(result, "perplexity")).toBe(true);
  });

  it("accepts the injected shape after the plugin compatibility shim marks the key as trusted", () => {
    markLegacyWebSearchPluginKeyTrusted("perplexity");

    const result = ToolsSchema.safeParse({
      web: { search: { provider: "perplexity", perplexity: { apiKey: "secret" } } },
    });
    expect(result.success).toBe(true);
  });

  it("still rejects other legacy keys when only one plugin is trusted (no over-trust spillover)", () => {
    markLegacyWebSearchPluginKeyTrusted("perplexity");

    const result = ToolsSchema.safeParse({
      web: { search: { provider: "brave", brave: { apiKey: "secret" } } },
    });
    expect(result.success).toBe(false);
    expect(hasLegacyWebSearchIssue(result, "brave")).toBe(true);
  });

  it("end-to-end: mergeScopedSearchConfig writing a plugin key unblocks the validator for the same key (#86779)", () => {
    const before = ToolsSchema.safeParse({
      web: { search: { provider: "perplexity", perplexity: { apiKey: "k" } } },
    });
    expect(before.success).toBe(false);

    mergeScopedSearchConfig({ provider: "perplexity" }, "perplexity", { apiKey: "k" });

    const after = ToolsSchema.safeParse({
      web: { search: { provider: "perplexity", perplexity: { apiKey: "k" } } },
    });
    expect(after.success).toBe(true);
  });

  it("merge is a no-op for trust registration when pluginConfig is missing", () => {
    mergeScopedSearchConfig({ provider: "perplexity" }, "perplexity", undefined);

    const result = ToolsSchema.safeParse({
      web: { search: { provider: "perplexity", perplexity: { apiKey: "k" } } },
    });
    expect(result.success).toBe(false);
    expect(hasLegacyWebSearchIssue(result, "perplexity")).toBe(true);
  });

  it("non-record values under a legacy key are accepted as before (only plain objects trigger the legacy check)", () => {
    const result = ToolsSchema.safeParse({
      web: { search: { provider: "perplexity", perplexity: "string-not-record" } },
    });
    expect(result.success).toBe(true);
  });

  it("clearTrustedLegacyWebSearchPluginKeysForTest reverts to strict rejection", () => {
    markLegacyWebSearchPluginKeyTrusted("perplexity");
    expect(
      ToolsSchema.safeParse({
        web: { search: { provider: "perplexity", perplexity: { apiKey: "k" } } },
      }).success,
    ).toBe(true);

    clearTrustedLegacyWebSearchPluginKeysForTest();
    expect(
      ToolsSchema.safeParse({
        web: { search: { provider: "perplexity", perplexity: { apiKey: "k" } } },
      }).success,
    ).toBe(false);
  });
});
