import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createToolingDependencyFixture } from "./tooling-dependencies.test-support.mts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["clean", "stale", "missing subpath exports"])(
  "bootstraps qualified dependencies beside a %s ancestor without linking them",
  (ancestor) => {
    const root = tempDirs.make("openclaw-tooling-bootstrap-");
    const fixture = createToolingDependencyFixture(root, ancestor !== "clean");
    if (ancestor === "missing subpath exports") {
      fixture.writePackage("fixture-pkg", 'export default "stale";', "0.0.0-stale", root, {
        "./advanced": 'export const legacyCopy = "stale";',
      });
      fixture.writePackage("fixture-pkg", 'export default "qualified";', "1.0.0", fixture.tooling, {
        "./advanced": 'export const copyFileDescriptorSync = "advanced";',
        "./watch": 'export const watch = "watch";',
      });
      writeFileSync(
        join(fixture.checkout, "scripts/crabbox-wrapper.mts"),
        `import { copyFileDescriptorSync } from "fixture-pkg/advanced";
import { watch } from "fixture-pkg/watch";
console.log(copyFileDescriptorSync, watch);
`,
      );
    }
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      ancestor === "missing subpath exports" ? "advanced watch\n" : "qualified bootstrap OK\n",
    );
    expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);

    const ordinary = fixture.run("ordinary.mjs");
    expect(ordinary.status).toBe(1);
    expect(ordinary.stderr).toContain("Repository dependencies are missing");
    expect(ordinary.stdout).toBe("");
    expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);
  },
);

it.each([
  { name: "tsx", invalid: "version" },
  { name: "fixture-pkg", invalid: "version" },
  { name: "tsx", invalid: "owner" },
  { name: "fixture-pkg", invalid: "owner" },
])("rejects $name with an invalid $invalid before executing it", ({ name, invalid }) => {
  const root = tempDirs.make("openclaw-tooling-workspace-");
  const fixture = createToolingDependencyFixture(root, true);
  if (invalid === "version") {
    fixture.writePackage(name, 'console.log("STALE PACKAGE EXECUTED");', "0.0.0-stale");
  } else {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const installed = join(fixture.tooling, "node_modules", name);
    const external = join(workspace, name);
    renameSync(installed, external);
    symlinkSync(external, installed, process.platform === "win32" ? "junction" : "dir");
  }
  const result = fixture.run();
  expect(result.status).toBe(1);
  if (invalid === "version") {
    expect(result.stderr).toContain(`'${name}' has version 0.0.0-stale`);
    expect(result.stderr).toContain("requires 1.0.0");
    expect(result.stderr.trimEnd()).toMatch(/\[crabbox\] FAILED \(exit 1\)$/);
    expect(result.stdout + result.stderr).not.toContain("STALE PACKAGE EXECUTED");
  } else {
    expect(result.stderr).toContain("Tooling package escapes its installed dependency owner");
    expect(result.stdout).toBe("");
  }
  expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);
});
