// Legacy web search migrate — own-property safety proof
// Tests that Object.hasOwn rejects proto-chain apiKey

import { describe, test, expect } from "vitest";
import { listLegacyWebSearchConfigPaths } from "../../../../src/commands/doctor/shared/legacy-web-search-migrate.ts";

describe("listLegacyWebSearchConfigPaths — Object.hasOwn safety", () => {
  test("core semantic: Object.hasOwn rejects proto-inherited apiKey", () => {
    const proto = Object.create({ apiKey: "injected-key" });
    expect("apiKey" in proto).toBe(true);
    expect(Object.hasOwn(proto, "apiKey")).toBe(false);
  });

  test("listLegacyWebSearchConfigPaths — proto-inherited apiKey not detected", () => {
    // tools.web.search with proto-inherited apiKey
    const searchWithProto = Object.create({ apiKey: "injected-key" });
    const raw = { tools: { web: { search: searchWithProto } } };
    const paths = listLegacyWebSearchConfigPaths(raw);
    expect(paths).not.toContain("tools.web.search.apiKey");
  });

  test("listLegacyWebSearchConfigPaths — own apiKey correctly detected", () => {
    const raw = { tools: { web: { search: { apiKey: "real-key" } } } };
    const paths = listLegacyWebSearchConfigPaths(raw);
    expect(paths).toContain("tools.web.search.apiKey");
  });

  test("listLegacyWebSearchConfigPaths — no apiKey returns empty list", () => {
    const raw = { tools: { web: { search: {} } } };
    const paths = listLegacyWebSearchConfigPaths(raw);
    expect(paths).not.toContain("tools.web.search.apiKey");
  });
});
