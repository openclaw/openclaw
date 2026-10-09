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

  it.each([
    ["package roots", false],
    ["entrypoints", true],
    ["dist mode", false],
    ["src mode", true],
    ["argv hints", true],
    ["dev root", false],
  ] as const)("keys the cache by effective SDK context: %s", (change, shared) => {
    const fixture = createPluginSdkAliasFixture();
    const entry = writePluginEntry(fixture.root, bundledPluginFile("a", "src/index.ts"));
    const firstArgs: Parameters<typeof buildPluginLoaderAliasMap> = [entry];
    const nextArgs: Parameters<typeof buildPluginLoaderAliasMap> = [entry];
    if (change === "package roots" || change === "entrypoints") {
      const root = change === "package roots" ? createPluginSdkAliasFixture().root : fixture.root;
      nextArgs[0] = writePluginEntry(root, bundledPluginFile("b", "src/index.ts"));
    } else if (change === "dist mode" || change === "src mode") {
      firstArgs[3] = "auto";
      nextArgs[3] = change === "dist mode" ? "dist" : "src";
    } else if (change === "argv hints") {
      firstArgs[1] = "/path/to/cli-a.mjs";
      nextArgs[1] = "/path/to/cli-b.mjs";
    } else {
      const dev = createPluginSdkAliasFixture();
      mkdirSafeDir(path.join(dev.root, "extensions"));
      firstArgs[3] = nextArgs[3] = "dist";
      firstArgs[4] = null;
      nextArgs[4] = dev.root;
    }
    const first = buildPluginLoaderAliasMap(...firstArgs);
    const next = buildPluginLoaderAliasMap(...nextArgs);
    if (shared) {
      expect(next).toBe(first);
    } else {
      expect(next).not.toBe(first);
    }
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
