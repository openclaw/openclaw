import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const script = ".github/actions/setup-release-harness/narrow-lockfile.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const lockfile = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      tsx:
        specifier: 4.0.0
        version: 4.0.0

  extensions/absent:
    dependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.3.0

  packages/present:
    dependencies:
      zod:
        specifier: 4.0.0
        version: 4.0.0

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-x}
`;

function sparseHarness(projects: string[]) {
  const root = tempDirs.make("release-harness-");
  for (const project of [".", ...projects]) {
    mkdirSync(join(root, project), { recursive: true });
    writeFileSync(join(root, project, "package.json"), "{}\n");
  }
  writeFileSync(join(root, "pnpm-lock.yaml"), lockfile);
  return root;
}

describe("setup-release-harness lockfile narrowing", () => {
  it("drops only importers whose projects are absent from the sparse checkout", () => {
    const root = sparseHarness(["packages/present"]);

    const output = execFileSync(process.execPath, [script, root], { encoding: "utf8" });

    expect(output).toContain("dropped 1 absent importer(s)");
    expect(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).toBe(
      lockfile.replace(
        `  extensions/absent:
    dependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.3.0

`,
        "",
      ),
    );
  });

  it("leaves a complete checkout byte-identical", () => {
    const root = sparseHarness(["packages/present", "extensions/absent"]);

    execFileSync(process.execPath, [script, root]);

    expect(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).toBe(lockfile);
  });
});
