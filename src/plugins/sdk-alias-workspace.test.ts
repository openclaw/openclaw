import fs from "node:fs";
import path from "node:path";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { buildPluginLoaderAliasMap } from "./sdk-alias.js";
import { createPluginSdkAliasFixtureFactory, writePluginEntry } from "./sdk-alias.test-fixtures.js";
import { createSyncSuiteTempRootTracker, mkdirSafeDir } from "./test-helpers/fs-fixtures.js";

const temp = createSyncSuiteTempRootTracker("openclaw-workspace-alias");
const createPluginSdkAliasFixture = createPluginSdkAliasFixtureFactory(temp.makeTempDir);
afterAll(() => temp.cleanup());

function writeWorkspacePackageEntry(params: {
  root: string;
  packageDir: string;
  srcFile: string;
  distFile: string;
}) {
  const srcFile = path.join(params.root, "packages", params.packageDir, "src", params.srcFile);
  const distFile = path.join(params.root, "packages", params.packageDir, "dist", params.distFile);
  for (const filename of [srcFile, distFile]) {
    mkdirSafeDir(path.dirname(filename));
    fs.writeFileSync(filename, "export {};\n", "utf-8");
  }
  return { srcFile, distFile };
}

describe("plugin workspace package export aliases", () => {
  it("resolves workspace export targets and excludes unsupported or missing entries", () => {
    const fixture = createPluginSdkAliasFixture();
    const targets = Object.fromEntries(
      [
        "entry",
        "nested/import",
        "nested/default",
        "string-entry",
        "require-only",
        "types-only",
      ].map((stem) => [
        stem,
        writeWorkspacePackageEntry({
          root: fixture.root,
          packageDir: "llm-core",
          srcFile: `${stem}.ts`,
          distFile: `${stem}.mjs`,
        }).distFile,
      ]),
    );
    fs.writeFileSync(
      path.join(fixture.root, "packages/llm-core/package.json"),
      JSON.stringify({
        name: "@openclaw/llm-core",
        exports: {
          ".": { default: "./dist/entry.mjs" },
          "./renamed": { import: "./dist/nested/import.mjs", default: "./dist/nested/default.mjs" },
          "./string": "./dist/string-entry.mjs",
          "./require-only": { require: "./dist/require-only.mjs" },
          "./types-only": { types: "./dist/types-only.mjs" },
          "./missing": "./dist/missing.mjs",
          "./../invalid": "./dist/entry.mjs",
        },
      }),
      "utf-8",
    );
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );

    const aliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry, undefined, undefined, "dist"),
    );

    for (const [alias, stem] of [
      ["@openclaw/llm-core", "entry"],
      ["@openclaw/llm-core/renamed", "nested/import"],
      ["@openclaw/llm-core/string", "string-entry"],
    ] as const) {
      expect(fs.realpathSync(aliases[alias] ?? "")).toBe(fs.realpathSync(targets[stem] ?? ""));
    }
    for (const subpath of ["require-only", "types-only", "missing", "../invalid"]) {
      expect(aliases[`@openclaw/llm-core/${subpath}`]).toBeUndefined();
    }
  });
});
