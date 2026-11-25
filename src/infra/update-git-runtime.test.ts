import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { readBuiltRuntimeCommit } from "./update-git-runtime.js";

it("returns null when build provenance omits the commit", async () => {
  await withTestDir({ prefix: "openclaw-built-commit-" }, async (root) => {
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ version: "2026.8.1" }),
    );

    expect(await readBuiltRuntimeCommit(root)).toBeNull();
  });
});
