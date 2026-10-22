import { spawnSync } from "node:child_process";
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

it.each(["qualified", "sparse donor", "different repository"])(
  "qualifies a %s independently of the invoking hook's Git context",
  (scenario) => {
    const fixture = createToolingDependencyFixture(tempDirs.make("openclaw-tooling-hook-"));
    const configure = (directory: string, key: string, value: string) => {
      const result = spawnSync("git", ["-C", directory, "config", key, value], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    };
    configure(fixture.checkout, "core.sparseCheckout", String(scenario === "qualified"));
    if (scenario === "sparse donor") {
      configure(fixture.tooling, "core.sparseCheckout", "true");
    } else if (scenario === "different repository") {
      configure(fixture.tooling, "remote.origin.url", "https://github.com/example/other.git");
    }
    fixture.env.GIT_DIR = join(fixture.checkout, ".git");
    fixture.env.GIT_WORK_TREE = fixture.checkout;
    fixture.env.GIT_INDEX_FILE = join(fixture.checkout, ".git", "hook-index");
    rewrite(
      join(fixture.checkout, "scripts/crabbox-wrapper.mts"),
      (source) =>
        `${source}\nassert.equal(process.env.GIT_INDEX_FILE, ${JSON.stringify(fixture.env.GIT_INDEX_FILE)});\n`,
    );
    const result = fixture.run("ordinary.mjs");
    if (scenario === "qualified") {
      expect(result, result.stderr).toMatchObject({
        status: 0,
        stdout: "qualified bootstrap OK\n",
      });
    } else {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        scenario === "sparse donor" ? "Sparse checkout." : "Different repository.",
      );
    }
    expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);
  },
);

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
    const output =
      ancestor === "missing subpath exports" ? "advanced watch\n" : "qualified bootstrap OK\n";
    expectRun(fixture, 0, output);
    expectRun(fixture, 0, output, "ordinary.mjs");
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
    moveAndLink(installed, external);
  }
  for (const entry of ["crabbox-wrapper.mjs", "ordinary.mjs"]) {
    const result = fixture.run(entry);
    expect(result.status).toBe(1);
    if (invalid === "version") {
      expect(result.stderr).toContain(`'${name}' has version 0.0.0-stale`);
      expect(result.stderr).toContain("requires 1.0.0");
      if (entry === "crabbox-wrapper.mjs") {
        expect(result.stderr.trimEnd()).toMatch(/\[crabbox\] FAILED \(exit 1\)$/);
      }
      expect(result.stdout + result.stderr).not.toContain("STALE PACKAGE EXECUTED");
    } else {
      expect(result.stderr).toContain("Tooling package escapes its installed dependency owner");
      expect(result.stdout).toBe("");
    }
  }
  expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);
});

it("preserves qualified generic preload resolution in a fork with a different cwd", () => {
  const fixture = createToolingDependencyFixture(tempDirs.make("openclaw-tooling-fork-"));
  rewrite(join(fixture.checkout, "scripts/ordinary.mjs"), (source) =>
    source.replace("./crabbox-wrapper.mts", "./fork.mts"),
  );
  writeFileSync(
    join(fixture.checkout, "scripts/fork.mts"),
    `import { fork } from "node:child_process";
import { once } from "node:events";
const child = fork(new URL("./crabbox-wrapper.mts", import.meta.url), ["--help"], {
  cwd: ${JSON.stringify(fixture.tooling)}, stdio: "inherit",
});
const [code] = await once(child, "exit");
process.exitCode = code ?? 1;
`,
  );
  expectRun(fixture, 0, "qualified bootstrap OK\n", "ordinary.mjs");
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
      if (scenario === "missing subpath exports") {
        rewrite(fixture.entry, (source) =>
          source.replace('"fixture-pkg"', '"fixture-pkg/feature"'),
        );
      }
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
