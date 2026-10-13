import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createToolingDependencyFixture } from "./tooling-dependencies.test-support.mts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createWorkspaceFixture(root: string) {
  const fixture = createToolingDependencyFixture(root);
  const workspace = "packages/fixture-workspace";
  const source = join(fixture.checkout, workspace);
  const donor = join(fixture.tooling, workspace);
  const manifest = {
    name: "@fixture/workspace",
    type: "module",
    exports: { "./local": "./src/local.mjs" },
    dependencies: { "fixture-pkg": "2.0.0" },
    devDependencies: { tsx: "2.0.0" },
  };
  for (const directory of [source, donor]) {
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  }
  writeFileSync(join(source, "src/local.mjs"), 'export default "checkout";');
  writeFileSync(join(donor, "src/local.mjs"), 'throw new Error("FOREIGN SOURCE EXECUTED");');
  const entry = join(source, "src/index.mjs");
  writeFileSync(
    entry,
    `import value, { privateValue } from "fixture-pkg";
import local from "@fixture/workspace/local";
export { value, privateValue, local };
`,
  );
  const wrapper = join(fixture.checkout, "scripts/crabbox-wrapper.mts");
  writeFileSync(
    wrapper,
    `import { value, privateValue, local } from "../${workspace}/src/index.mjs";
console.log(value, privateValue, local, process.env.TOOLING_FIXTURE_PRELOADED);
`,
  );
  // Isolated pnpm links point out of package-local node_modules into the root store.
  const installed = fixture.writePackage(
    "fixture-pkg",
    'export default "workspace"; export { default as privateValue } from "private-pkg";',
    "2.0.0",
    join(fixture.tooling, "node_modules/.pnpm/fixture-pkg@2.0.0"),
    { "./feature": 'export { default, privateValue } from "./index.mjs";' },
  );
  fixture.writePackage("private-pkg", 'export default "workspace-private";', "3.0.0", installed);
  mkdirSync(join(donor, "node_modules"));
  const link = join(donor, "node_modules/fixture-pkg");
  symlinkSync(installed, link, process.platform === "win32" ? "junction" : "dir");
  return { ...fixture, source, donor, entry, wrapper, installed, link, manifest };
}

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

it.each(["local only", "different root pin", "stale ancestor", "missing subpath exports"])(
  "resolves workspace-owned dependencies with %s and preserves checkout source",
  (scenario) => {
    const root = tempDirs.make("openclaw-tooling-package-");
    const fixture = createWorkspaceFixture(root);
    if (scenario === "local only") {
      const manifestPath = join(fixture.checkout, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete manifest.devDependencies["fixture-pkg"];
      writeFileSync(manifestPath, JSON.stringify(manifest));
      rmSync(join(fixture.tooling, "node_modules/fixture-pkg"), { recursive: true });
    } else if (scenario === "different root pin") {
      writeFileSync(
        fixture.wrapper,
        `import assert from "node:assert/strict";
import rootValue from "fixture-pkg";
assert.equal(rootValue, "qualified");
${readFileSync(fixture.wrapper, "utf8")}`,
      );
    } else {
      fixture.writePackage(
        "fixture-pkg",
        'throw new Error("STALE PACKAGE EXECUTED");',
        "0.0.0",
        root,
      );
      if (scenario === "missing subpath exports") {
        writeFileSync(
          fixture.entry,
          readFileSync(fixture.entry, "utf8").replace('"fixture-pkg"', '"fixture-pkg/feature"'),
        );
      }
    }
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("workspace workspace-private checkout 1\n");
    expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);
  },
);

it.each([
  "version",
  "range pin",
  "undeclared",
  "subpath exports",
  "package escape",
  "entry escape",
  "context escape",
  "foreign workspace source",
])("rejects workspace dependency %s before package execution", (scenario) => {
  const root = tempDirs.make("openclaw-tooling-package-rejection-");
  const fixture = createWorkspaceFixture(root);
  const marker = 'console.log("INVALID PACKAGE EXECUTED");';
  writeFileSync(
    join(fixture.installed, "index.mjs"),
    `${marker} export default "workspace"; export const privateValue = "private";`,
  );
  let expected = "Tooling package escapes its installed dependency owner";
  if (scenario === "version") {
    const manifestPath = join(fixture.installed, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = "0.0.0-stale";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expected = "requires 2.0.0";
  } else if (scenario === "range pin" || scenario === "undeclared") {
    writeFileSync(
      join(fixture.source, "package.json"),
      JSON.stringify({
        ...fixture.manifest,
        dependencies: scenario === "undeclared" ? {} : { "fixture-pkg": "^2.0.0" },
      }),
    );
    expected = `requires ${scenario === "undeclared" ? "undeclared" : "^2.0.0"}`;
  } else if (scenario === "subpath exports") {
    writeFileSync(
      fixture.entry,
      readFileSync(fixture.entry, "utf8").replace('"fixture-pkg"', '"fixture-pkg/private"'),
    );
    expected = "ERR_PACKAGE_PATH_NOT_EXPORTED";
  } else if (scenario === "entry escape") {
    const external = join(fixture.donor, "src/foreign.mjs");
    renameSync(join(fixture.installed, "index.mjs"), external);
    symlinkSync(external, join(fixture.installed, "index.mjs"), "file");
  } else if (scenario === "foreign workspace source") {
    const foreign = join(root, "foreign-source");
    mkdirSync(foreign);
    writeFileSync(
      join(foreign, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.mjs" }),
    );
    writeFileSync(join(foreign, "index.mjs"), marker);
    mkdirSync(join(root, "node_modules"));
    symlinkSync(
      foreign,
      join(root, "node_modules/fixture-pkg"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } else {
    const target = scenario === "package escape" ? fixture.installed : fixture.donor;
    const external = join(root, "foreign-owner");
    renameSync(target, external);
    symlinkSync(external, target, process.platform === "win32" ? "junction" : "dir");
  }
  const result = fixture.run();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(expected);
  expect(result.stdout).toBe("");
  expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);
});
