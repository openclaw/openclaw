import fs from "node:fs/promises";
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { observationPrefixKind } from "./fs-observation-root.js";

it("uses filesystem alias semantics without following symbolic prefixes", async () => {
  await withTestDir({ prefix: "observation-prefix-" }, async (directory) => {
    await fs.mkdir(path.join(directory, "MixedCase"));
    await fs.writeFile(path.join(directory, "MixedCase", "item"), "file");
    await fs.symlink(
      path.join(directory, "MixedCase"),
      path.join(directory, "LinkName"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const authority = await root(directory, { symlinks: "reject" });
    const signal = new AbortController().signal;
    expect(await observationPrefixKind(authority, "MixedCase", signal)).toBe("directory");
    expect(await observationPrefixKind(authority, path.join("MixedCase", "item"), signal)).toBe(
      "other",
    );
    expect(await observationPrefixKind(authority, "LinkName", signal)).toBe("symlink");
    // Detect actual volume semantics, not an OS approximation. A case-sensitive
    // Windows directory must not inherit the usual Windows folded-name behavior.
    const folds = await fs.lstat(path.join(directory, "mixedcase")).then(
      () => true,
      () => false,
    );
    expect(await observationPrefixKind(authority, "mixedcase", signal)).toBe(
      folds ? "directory" : "missing",
    );
    expect(await observationPrefixKind(authority, "linkname", signal)).toBe(
      folds ? "symlink" : "missing",
    );
    await fs.rename(directory, directory + "-retired");
    try {
      await fs.mkdir(directory);
      await expect(observationPrefixKind(authority, "MixedCase", signal)).rejects.toThrow();
    } finally {
      await fs.rm(directory + "-retired", { recursive: true });
    }
  });
});
