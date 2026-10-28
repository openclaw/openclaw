import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { assertStandaloneSourceBoundaryPrepared } from "../../scripts/lib/bun-standalone-source-boundary.mjs";

it("requires private SDK declarations and points to default declaration preparation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-source-boundary-"));
  try {
    const declarations = path.join(root, "packages/plugin-sdk/dist/src/plugin-sdk");
    const check = () => assertStandaloneSourceBoundaryPrepared(root);
    expect(check).toThrow(
      new Error(
        "Original-source AOT needs the package-boundary declarations in packages/plugin-sdk/dist. " +
          "Prepare them before building: " +
          "node --import ./scripts/tsx.mjs scripts/prepare-extension-package-boundary-artifacts.mts",
      ),
    );
    fs.mkdirSync(declarations, { recursive: true });
    fs.writeFileSync(path.join(declarations, "index.js"), "export {};\n");
    expect(check).toThrow("package-boundary declarations");
    fs.writeFileSync(
      path.join(declarations, "index.d.ts"),
      "export declare const value: number;\n",
    );
    expect(check).not.toThrow();
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
