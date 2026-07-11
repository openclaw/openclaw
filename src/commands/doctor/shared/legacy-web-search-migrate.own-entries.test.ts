// Legacy web search migrate — own-property safety proof
// Tests that Object.hasOwn rejects proto-chain apiKey and provider-map entries

import { describe, test, expect } from "vitest";
import { listLegacyWebSearchConfigPaths } from "../../../../src/commands/doctor/shared/legacy-web-search-migrate.ts";

describe("listLegacyWebSearchConfigPaths — Object.hasOwn safety", () => {
  test("core semantic: Object.hasOwn rejects proto-inherited apiKey", () => {
    const proto = Object.create({ apiKey: "injected-key" });
    expect("apiKey" in proto).toBe(true);
    expect(Object.hasOwn(proto, "apiKey")).toBe(false);
  });

  test("proto-inherited apiKey not detected", () => {
    // tools.web.search with proto-inherited apiKey
    const searchWithProto = Object.create({ apiKey: "injected-key" });
    const raw = { tools: { web: { search: searchWithProto } } };
    const paths = listLegacyWebSearchConfigPaths(raw);
    expect(paths).not.toContain("tools.web.search.apiKey");
  });

  test("own apiKey correctly detected", () => {
    const raw = { tools: { web: { search: { apiKey: "real-key" } } } };
    const paths = listLegacyWebSearchConfigPaths(raw);
    expect(paths).toContain("tools.web.search.apiKey");
  });

  test("no apiKey returns empty list", () => {
    const raw = { tools: { web: { search: {} } } };
    const paths = listLegacyWebSearchConfigPaths(raw);
    expect(paths).not.toContain("tools.web.search.apiKey");
  });

  // --- Provider-map entry guards (search[providerId]) ---
  test("proto-inherited provider entry not listed", () => {
    // search has no own provider entries, only an inherited one via prototype
    const searchWithProtoEntry = Object.create({ brave: { apiKey: "injected" } });
    const raw = { tools: { web: { search: searchWithProtoEntry } } };
    const paths = listLegacyWebSearchConfigPaths(raw);
    expect(paths).not.toContain("tools.web.search.brave.apiKey");
    expect(paths.length).toBe(0);
  });

  test("own provider entry correctly detected", () => {
    const raw = { tools: { web: { search: { brave: { apiKey: "real-brave-key" } } } } };
    const paths = listLegacyWebSearchConfigPaths(raw);
    expect(paths).toContain("tools.web.search.brave.apiKey");
  });
});
