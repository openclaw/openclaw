import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { templateContainedRelativePath } from "./path-containment.js";

describe("templateContainedRelativePath", () => {
  const root = resolve(sep, "template-root");

  it("returns native relative paths only for strict descendants", () => {
    expect(templateContainedRelativePath(root, root)).toBeUndefined();
    expect(templateContainedRelativePath(root, join(root, "file.md"))).toBe("file.md");
    expect(templateContainedRelativePath(root, join(root, "nested", "file.md"))).toBe(
      join("nested", "file.md"),
    );
  });

  it.each([
    ["parent", join(root, "..", "outside.md")],
    ["prefix sibling", join(`${root}-sibling`, "file.md")],
  ])("rejects %s paths", (_name, target) => {
    expect(templateContainedRelativePath(root, target)).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("rejects cross-drive and cross-UNC paths", () => {
    expect(templateContainedRelativePath("C:\\root", "D:\\root\\file.md")).toBeUndefined();
    expect(
      templateContainedRelativePath("\\\\server\\share\\root", "\\\\other\\share\\root\\file.md"),
    ).toBeUndefined();
  });
});
