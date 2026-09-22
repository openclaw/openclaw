import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnv } from "../test-utils/env.js";
import { buildPluginLoaderAliasMap } from "./sdk-alias.js";
import { createPluginSdkAliasFixtureFactory, writePluginEntry } from "./sdk-alias.test-fixtures.js";
import { mkdirSafeDir } from "./test-helpers/fs-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const createPluginSdkAliasFixture = createPluginSdkAliasFixtureFactory(() =>
  tempDirs.make("openclaw-sdk-alias-memo-"),
);

describe("buildPluginLoaderAliasMap memoization", () => {
  it("returns the same object reference for identical effective context", () => {
    const fixture = createPluginSdkAliasFixture();
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("memo-demo", "src/index.ts"),
    );

    withEnv({ OPENCLAW_DEV_SOURCE_ROOT: fixture.root }, () => {
      const first = buildPluginLoaderAliasMap(sourcePluginEntry);
      const reads = [
        vi.spyOn(fs, "readFileSync"),
        vi.spyOn(fs, "statSync"),
        vi.spyOn(fs, "existsSync"),
        vi.spyOn(fs, "realpathSync"),
      ];
      try {
        expect(buildPluginLoaderAliasMap(sourcePluginEntry)).toBe(first);
        for (const read of reads) {
          expect(read).not.toHaveBeenCalled();
        }
      } finally {
        reads.forEach((read) => read.mockRestore());
      }
    });
  });

  it("returns different references for different modulePath inputs", () => {
    const fixtureA = createPluginSdkAliasFixture();
    const fixtureB = createPluginSdkAliasFixture();
    const entryA = writePluginEntry(fixtureA.root, bundledPluginFile("a", "src/index.ts"));
    const entryB = writePluginEntry(fixtureB.root, bundledPluginFile("b", "src/index.ts"));

    const aliasA = buildPluginLoaderAliasMap(entryA);
    const aliasB = buildPluginLoaderAliasMap(entryB);

    expect(aliasA).not.toBe(aliasB);
  });

  it("reuses one merged map for plugin entrypoints with the same effective SDK surface", () => {
    const fixture = createPluginSdkAliasFixture();
    const entryA = writePluginEntry(fixture.root, bundledPluginFile("a", "src/index.ts"));
    const entryB = writePluginEntry(fixture.root, bundledPluginFile("b", "src/index.ts"));

    expect(buildPluginLoaderAliasMap(entryB)).toBe(buildPluginLoaderAliasMap(entryA));
  });

  it("returns different references when pluginSdkResolution differs", () => {
    const fixture = createPluginSdkAliasFixture();
    const entry = writePluginEntry(fixture.root, bundledPluginFile("res", "src/index.ts"));

    const auto = buildPluginLoaderAliasMap(entry, undefined, undefined, "auto");
    const dist = buildPluginLoaderAliasMap(entry, undefined, undefined, "dist");

    expect(auto).not.toBe(dist);
  });

  it("reuses one merged map when resolution modes have the same effective order", () => {
    const fixture = createPluginSdkAliasFixture();
    const entry = writePluginEntry(fixture.root, bundledPluginFile("same-order", "src/index.ts"));

    const auto = buildPluginLoaderAliasMap(entry, undefined, undefined, "auto");
    const source = buildPluginLoaderAliasMap(entry, undefined, undefined, "src");

    expect(source).toBe(auto);
  });

  it("reuses a merged map when different argv hints resolve the same SDK surface", () => {
    const fixture = createPluginSdkAliasFixture();
    const entry = writePluginEntry(fixture.root, bundledPluginFile("argv", "src/index.ts"));

    const a = buildPluginLoaderAliasMap(entry, "/path/to/cli-a.mjs");
    const b = buildPluginLoaderAliasMap(entry, "/path/to/cli-b.mjs");

    expect(a).toBe(b);
  });

  it("returns different references when an explicit dev source root differs", () => {
    const stableFixture = createPluginSdkAliasFixture();
    const devFixture = createPluginSdkAliasFixture();
    mkdirSafeDir(path.join(devFixture.root, "extensions"));
    const entry = writePluginEntry(
      stableFixture.root,
      bundledPluginFile("dev-env", "src/index.ts"),
    );

    const stableAliases = buildPluginLoaderAliasMap(entry, undefined, undefined, "dist", null);
    const devAliases = buildPluginLoaderAliasMap(
      entry,
      undefined,
      undefined,
      "dist",
      devFixture.root,
    );

    expect(devAliases).not.toBe(stableAliases);
  });

  it("does not reuse a public alias map after private qa aliases are enabled", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
      },
    });
    const sourceQaRuntimePath = path.join(fixture.root, "src", "plugin-sdk", "qa-runtime.ts");
    fs.writeFileSync(sourceQaRuntimePath, "export const qaRuntime = true;\n", "utf-8");
    const entry = writePluginEntry(fixture.root, bundledPluginFile("private-qa", "src/index.ts"));

    const publicAliases = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined }, () =>
      buildPluginLoaderAliasMap(entry),
    );
    const privateAliases = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1" }, () =>
      buildPluginLoaderAliasMap(entry),
    );

    expect(publicAliases).not.toBe(privateAliases);
    expect(publicAliases["openclaw/plugin-sdk/qa-runtime"]).toBeUndefined();
    expect(fs.realpathSync(privateAliases["openclaw/plugin-sdk/qa-runtime"] ?? "")).toBe(
      fs.realpathSync(sourceQaRuntimePath),
    );
  });

  it("keeps an explicit source host on its module graph in production mode", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" },
    });
    const entry = writePluginEntry(fixture.root, bundledPluginFile("env-mode", "src/index.ts"));
    const hostUrl = pathToFileURL(path.join(fixture.root, "src", "plugins", "loader.ts")).href;

    const developmentAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(entry, undefined, hostUrl),
    );
    const productionAliases = withEnv({ NODE_ENV: "production" }, () =>
      buildPluginLoaderAliasMap(entry, undefined, hostUrl),
    );

    expect(developmentAliases).toBe(productionAliases);
    expect(productionAliases["openclaw/plugin-sdk/core"]).toBe(fs.realpathSync(fixture.srcFile));
  });
});
