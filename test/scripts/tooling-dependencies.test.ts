import { execFileSync } from "node:child_process";
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
const staleSource = 'throw new Error("STALE PACKAGE EXECUTED");';
const directoryLink = process.platform === "win32" ? "junction" : "dir";
function writeJson(file: string, value: object) {
  writeFileSync(file, JSON.stringify(value));
}
function rewrite(file: string, transform: (source: string) => string) {
  writeFileSync(file, transform(readFileSync(file, "utf8")));
}
function moveAndLink(from: string, to: string, type: "file" | "dir" | "junction" = directoryLink) {
  renameSync(from, to);
  symlinkSync(to, from, type);
}
function expectRun(
  fixture: ReturnType<typeof createToolingDependencyFixture>,
  status: number,
  stdout: string,
  entry?: string,
) {
  const result = fixture.run(entry);
  expect(result, result.stderr).toMatchObject({ status, stdout });
  expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);
  return result;
}

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
    writeJson(join(directory, "package.json"), manifest);
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
  symlinkSync(installed, link, directoryLink);
  return { ...fixture, source, donor, entry, wrapper, installed, link, manifest };
}

it("qualifies a donor independently of inherited hook Git context", () => {
  const root = tempDirs.make("openclaw-tooling-hook-context-");
  const fixture = createToolingDependencyFixture(root);
  execFileSync("git", ["-C", fixture.checkout, "config", "core.sparseCheckout", "true"]);
  writeFileSync(
    join(fixture.checkout, "scripts/hook-context.mjs"),
    `import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toolingDependencyOptions } from "./lib/tooling-dependencies.mjs";
const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const gitDir = join(checkout, ".git");
const index = join(checkout, "hook-index");
execFileSync("git", ["-C", checkout, "read-tree", "--empty"], {
  env: { ...process.env, GIT_INDEX_FILE: index },
});
Object.assign(process.env, {
  GIT_DIR: gitDir,
  GIT_WORK_TREE: checkout,
  GIT_COMMON_DIR: gitDir,
  GIT_INDEX_FILE: index,
  GIT_PREFIX: "scripts/",
  GIT_OBJECT_DIRECTORY: join(gitDir, "objects"),
  GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDir, "objects"),
});
const before = { ...process.env };
const indexBefore = readFileSync(index);
try {
  assert.ok(toolingDependencyOptions(checkout, "hook-context").execArgv.length);
} finally {
  assert.deepEqual({ ...process.env }, before);
  assert.deepEqual(readFileSync(index), indexBefore);
}
await import("./crabbox-wrapper.mjs");
`,
  );
  expectRun(fixture, 0, "qualified bootstrap OK\n", "hook-context.mjs");
});

it("bootstraps qualified subpaths beside a stale ancestor without linking them", () => {
  const root = tempDirs.make("openclaw-tooling-bootstrap-");
  const fixture = createToolingDependencyFixture(root, true);
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
  expectRun(fixture, 0, "advanced watch\n");
  const ordinary = expectRun(fixture, 1, "", "ordinary.mjs");
  expect(ordinary.stderr).toContain("Repository dependencies are missing");
});

it.each([
  { name: "tsx", invalid: "version" },
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
    moveAndLink(installed, external);
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

it.each(["local only", "different root pin", "missing subpath exports"])(
  "resolves workspace-owned dependencies with %s and preserves checkout source",
  (scenario) => {
    const root = tempDirs.make("openclaw-tooling-package-");
    const fixture = createWorkspaceFixture(root);
    if (scenario === "local only") {
      const manifestPath = join(fixture.checkout, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete manifest.devDependencies["fixture-pkg"];
      writeJson(manifestPath, manifest);
      rmSync(join(fixture.tooling, "node_modules/fixture-pkg"), { recursive: true });
    } else if (scenario === "different root pin") {
      rewrite(
        fixture.wrapper,
        (source) => `import assert from "node:assert/strict";
import rootValue from "fixture-pkg";
assert.equal(rootValue, "qualified");
${source}`,
      );
    } else {
      fixture.writePackage("fixture-pkg", staleSource, "0.0.0", root);
      rewrite(fixture.entry, (source) => source.replace('"fixture-pkg"', '"fixture-pkg/feature"'));
    }
    expectRun(fixture, 0, "workspace workspace-private checkout 1\n");
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
    writeJson(manifestPath, manifest);
    expected = "requires 2.0.0";
  } else if (scenario === "range pin" || scenario === "undeclared") {
    writeJson(join(fixture.source, "package.json"), {
      ...fixture.manifest,
      dependencies: scenario === "undeclared" ? {} : { "fixture-pkg": "^2.0.0" },
    });
    expected = `requires ${scenario === "undeclared" ? "undeclared" : "^2.0.0"}`;
  } else if (scenario === "subpath exports") {
    rewrite(fixture.entry, (source) => source.replace('"fixture-pkg"', '"fixture-pkg/private"'));
    expected = "ERR_PACKAGE_PATH_NOT_EXPORTED";
  } else if (scenario === "entry escape") {
    const external = join(fixture.donor, "src/foreign.mjs");
    moveAndLink(join(fixture.installed, "index.mjs"), external, "file");
  } else if (scenario === "foreign workspace source") {
    const foreign = join(root, "foreign-source");
    mkdirSync(foreign);
    writeJson(join(foreign, "package.json"), { type: "module", exports: "./index.mjs" });
    writeFileSync(join(foreign, "index.mjs"), marker);
    mkdirSync(join(root, "node_modules"));
    symlinkSync(foreign, join(root, "node_modules/fixture-pkg"), directoryLink);
  } else {
    const target = scenario === "package escape" ? fixture.installed : fixture.donor;
    const external = join(root, "foreign-owner");
    moveAndLink(target, external);
  }
  const result = expectRun(fixture, 1, "");
  expect(result.stderr).toContain(expected);
});
