import { expect, it, vi } from "vitest";
import { selectLocalWorkspaceCanonicalPaths } from "./local-workspace-inventory.js";

it("expands shared ancestors with linear path-insertion work", async () => {
  const directories = ["source", "source/a", "source/a/b", "source/a/b/c", "source/a/b/c/d"];
  const files = Array.from({ length: 64 }, (_, index) => `${directories.at(-1)}/${index}.txt`);
  const preparedPaths = new Set(files);
  const observed = vi.spyOn(Set.prototype, "add");
  let paths: Set<string>;
  let insertions: number;
  try {
    paths = await selectLocalWorkspaceCanonicalPaths({
      root: "/unused-prepared-inventory",
      admittedPaths: "[]",
      preparedPaths,
      baselinePaths: new Set(["source/saved/retained.txt"]),
      assertCurrent() {},
    });
    insertions = observed.mock.calls.filter(
      ([value]) => typeof value === "string" && (value === "source" || value.startsWith("source/")),
    ).length;
  } finally {
    observed.mockRestore();
  }
  expect(paths).toEqual(
    new Set([...files, ...directories, "source/saved/retained.txt", "source/saved"]),
  );
  // Each admitted path and directory can enter the inventory and contribute a
  // parent; shared ancestors must not multiply that work by directory depth.
  expect(insertions).toBeLessThanOrEqual(2 * paths.size);
});
