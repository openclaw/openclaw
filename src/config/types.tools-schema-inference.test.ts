import { describe, expect, it } from "vitest";
import type { ToolsConfig } from "./types.tools.js";

describe("schema-derived tool config types", () => {
  it("preserves partial web authoring inputs across parsed-schema inference", () => {
    const configs = [
      {},
      { search: {} },
      { search: { openaiCodex: { allowedDomains: [" example.com ", ""] } } },
      { fetch: { headers: { "X-Routing-Target": "internal" } } },
    ] satisfies NonNullable<ToolsConfig["web"]>[];

    expect(configs).toHaveLength(4);
  });
});
