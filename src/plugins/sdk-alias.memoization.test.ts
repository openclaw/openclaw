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
const createBase = createPluginSdkAliasFixtureFactory(() =>
  tempDirs.make("openclaw-sdk-alias-memo-"),
);
function fixture(packageExports?: Record<string, unknown>) {
  const value = createBase({ packageExports });
  return {
    ...value,
    entry: writePluginEntry(value.root, bundledPluginFile("memo", "src/index.ts")),
  };
}

describe("buildPluginLoaderAliasMap memoization", () => {
  it("returns the same object reference for identical effective context", () => {
    const { root, entry } = fixture();

    withEnv({ OPENCLAW_DEV_SOURCE_ROOT: root }, () => {
      const first = buildPluginLoaderAliasMap(entry);
      const reads = (["readFileSync", "statSync", "existsSync", "realpathSync"] as const).map(
        (name) => vi.spyOn(fs, name),
      );
      try {
        expect(buildPluginLoaderAliasMap(entry)).toBe(first);
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
    const { root, entry } = fixture();
    const firstArgs: Parameters<typeof buildPluginLoaderAliasMap> = [entry];
    const nextArgs: Parameters<typeof buildPluginLoaderAliasMap> = [entry];
    if (change === "package roots" || change === "entrypoints") {
      const nextRoot = change === "package roots" ? createBase().root : root;
      nextArgs[0] = writePluginEntry(nextRoot, bundledPluginFile("b", "src/index.ts"));
    } else if (change === "dist mode" || change === "src mode") {
      firstArgs[3] = "auto";
      nextArgs[3] = change === "dist mode" ? "dist" : "src";
    } else if (change === "argv hints") {
      firstArgs[1] = "/path/to/cli-a.mjs";
      nextArgs[1] = "/path/to/cli-b.mjs";
    } else {
      const dev = createBase();
      mkdirSafeDir(path.join(dev.root, "extensions"));
      firstArgs[3] = nextArgs[3] = "dist";
      firstArgs[4] = null;
      nextArgs[4] = dev.root;
    }
    const first = buildPluginLoaderAliasMap(...firstArgs);
    const next = buildPluginLoaderAliasMap(...nextArgs);
    expect(Object.is(next, first)).toBe(shared);
  });

  it("does not reuse a public alias map after private qa aliases are enabled", () => {
    const { root, entry } = fixture({
      "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
    });
    const sourceQaRuntimePath = path.join(root, "src", "plugin-sdk", "qa-runtime.ts");
    fs.writeFileSync(sourceQaRuntimePath, "export const qaRuntime = true;\n", "utf-8");
    const aliases = (enabled?: string) =>
      withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: enabled }, () => buildPluginLoaderAliasMap(entry));
    const publicAliases = aliases();
    const privateAliases = aliases("1");

    expect(publicAliases).not.toBe(privateAliases);
    expect(publicAliases["openclaw/plugin-sdk/qa-runtime"]).toBeUndefined();
    expect(fs.realpathSync(privateAliases["openclaw/plugin-sdk/qa-runtime"] ?? "")).toBe(
      fs.realpathSync(sourceQaRuntimePath),
    );
  });

  it("keeps an explicit source host on its module graph in production mode", () => {
    const { root, entry, srcFile } = fixture({ "./plugin-sdk/core": "./dist/plugin-sdk/core.js" });
    const hostUrl = pathToFileURL(path.join(root, "src", "plugins", "loader.ts")).href;

    const aliases = (mode?: string) =>
      withEnv({ NODE_ENV: mode }, () => buildPluginLoaderAliasMap(entry, undefined, hostUrl));
    const developmentAliases = aliases();
    const productionAliases = aliases("production");

    expect(developmentAliases).toBe(productionAliases);
    expect(productionAliases["openclaw/plugin-sdk/core"]).toBe(fs.realpathSync(srcFile));
  });
});
