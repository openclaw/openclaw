import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectCliBootstrapExternalImportErrors,
  listStaticImportSpecifiers,
} from "../../scripts/check-cli-bootstrap-imports.mjs";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-cli-bootstrap-imports-"));
  tempRoots.push(root);
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  return root;
}

function writeFixture(root: string, relativePath: string, source: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source, "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-cli-bootstrap-imports", () => {
  it("lists only static import and export specifiers", () => {
    expect(
      listStaticImportSpecifiers(`
        import fs from "node:fs";
        import "./side-effect.js";
        export { value } from "../value.js";
        await import("commander");
      `),
    ).toEqual(["node:fs", "./side-effect.js", "../value.js"]);
  });

  it("allows a bootstrap graph with builtins and lazy external imports", () => {
    const root = makeTempRoot();
    writeFixture(
      root,
      "dist/entry.js",
      `import fs from "node:fs";\nimport "./cli/run-main.js";\nvoid fs;\n`,
    );
    writeFixture(
      root,
      "dist/cli/run-main.js",
      `import "../light.js";\nexport async function run() { return import("tslog"); }\n`,
    );
    writeFixture(root, "dist/light.js", `import path from "node:path";\nvoid path;\n`);

    expect(collectCliBootstrapExternalImportErrors({ rootDir: root })).toEqual([]);
  });

  it("reports external packages in the static bootstrap graph", () => {
    const root = makeTempRoot();
    writeFixture(root, "dist/entry.js", `import "./cli/run-main.js";\n`);
    writeFixture(root, "dist/cli/run-main.js", `import "../heavy.js";\n`);
    writeFixture(root, "dist/heavy.js", `import { Logger } from "tslog";\nvoid Logger;\n`);

    expect(collectCliBootstrapExternalImportErrors({ rootDir: root })).toEqual([
      'CLI bootstrap static graph imports external package "tslog" from dist/heavy.js.',
    ]);
  });
});
