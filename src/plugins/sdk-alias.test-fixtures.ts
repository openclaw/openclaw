import fs from "node:fs";
import path from "node:path";
import { mkdirSafeDir } from "./test-helpers/fs-fixtures.js";

export function createPluginSdkAliasFixtureFactory(makeTempDir: () => string) {
  return function createPluginSdkAliasFixture(params?: {
    srcFile?: string;
    distFile?: string;
    srcBody?: string;
    distBody?: string;
    packageExports?: Record<string, unknown>;
    trustedRootIndicators?: boolean;
    trustedRootIndicatorMode?: "bin+marker" | "cli-entry-only" | "none";
  }) {
    const root = makeTempDir();
    const srcFile = path.join(root, "src", "plugin-sdk", params?.srcFile ?? "core.ts");
    const distFile = path.join(root, "dist", "plugin-sdk", params?.distFile ?? "core.js");
    mkdirSafeDir(path.dirname(srcFile));
    mkdirSafeDir(path.dirname(distFile));
    const trustedRootIndicatorMode =
      params?.trustedRootIndicatorMode ??
      (params?.trustedRootIndicators === false ? "none" : "bin+marker");
    const packageJson: Record<string, unknown> = {
      name: "openclaw",
      type: "module",
    };
    if (trustedRootIndicatorMode === "bin+marker") {
      packageJson.bin = {
        openclaw: "openclaw.mjs",
      };
    }
    if (params?.packageExports || trustedRootIndicatorMode === "cli-entry-only") {
      const trustedExports: Record<string, unknown> =
        trustedRootIndicatorMode === "cli-entry-only"
          ? { "./cli-entry": { default: "./dist/cli-entry.js" } }
          : {};
      packageJson.exports = {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
        ...trustedExports,
        ...params?.packageExports,
      };
    }
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify(packageJson, null, 2),
      "utf-8",
    );
    if (trustedRootIndicatorMode === "bin+marker") {
      fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n", "utf-8");
    }
    mkdirSafeDir(path.join(root, "scripts", "lib"));
    fs.writeFileSync(
      path.join(root, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
      JSON.stringify(["qa-channel", "qa-channel-protocol", "qa-lab", "qa-runtime"], null, 2),
      "utf-8",
    );
    fs.writeFileSync(srcFile, params?.srcBody ?? "export {};\n", "utf-8");
    fs.writeFileSync(distFile, params?.distBody ?? "export {};\n", "utf-8");
    return { root, srcFile, distFile };
  };
}

export function writePluginEntry(root: string, relativePath: string) {
  const pluginEntry = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(pluginEntry), { recursive: true });
  fs.writeFileSync(pluginEntry, 'export const plugin = "demo";\n', "utf-8");
  return pluginEntry;
}
