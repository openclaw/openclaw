import { expect, it, vi } from "vitest";

vi.mock("acorn", () => {
  throw new Error("Package-map helpers must not acquire the source parser");
});

it("keeps package-map and captured URL helpers independent of source parsing", async () => {
  const { capturedPluginModuleUrl, createPluginPackageMapReferences } =
    await import("./plugin-source-references.js");
  expect(
    capturedPluginModuleUrl("/captured/entry.js", "./entry.js?generation=1", ["node", "import"])
      .search,
  ).toBe("?generation=1");
  const references = createPluginPackageMapReferences();
  references.recordMissingTarget("/captured/missing.js");
  expect(references.hasMissingTarget("/captured/missing.js")).toBe(true);
});
