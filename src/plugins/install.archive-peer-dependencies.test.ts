import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installPluginFromPath } from "./install.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { packToArchive } from "./test-helpers/archive-fixtures.js";

// Exercise the supported archive entry point with real offline npm, then
// import the installed plugin rather than mocking dependency installation.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it.each(["dependencies", "peerDependencies"] as const)(
  "installs a runnable archive with only %s",
  async (dependencyKind) => {
    const rootDir = tempDirs.make("openclaw-peer-archive-proof-");
    const packageDir = path.join(rootDir, "package");
    const stateDir = path.join(rootDir, "state");
    for (const key of ["userconfig", "globalconfig"]) {
      const file = path.join(rootDir, `${key}.npmrc`);
      await fs.writeFile(file, "");
      vi.stubEnv(`npm_config_${key}`, file);
      vi.stubEnv(`NPM_CONFIG_${key.toUpperCase()}`, file);
    }
    for (const [key, value] of Object.entries({
      offline: "true",
      cache: path.join(rootDir, "npm-cache"),
    })) {
      vi.stubEnv(`npm_config_${key}`, value);
      vi.stubEnv(`NPM_CONFIG_${key.toUpperCase()}`, value);
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await fs.mkdir(path.join(packageDir, "dist"), { recursive: true });
    await fs.mkdir(path.join(packageDir, "dependency"));
    await fs.writeFile(
      path.join(packageDir, "dependency/package.json"),
      JSON.stringify({ name: "archive-runtime-peer", version: "1.0.0", main: "index.cjs" }),
    );
    await fs.writeFile(
      path.join(packageDir, "dependency/index.cjs"),
      'module.exports = "installed runtime peer";\n',
    );
    // Use a tarball, not a file-directory link that can retain the staged
    // directory path after publication on Windows.
    await packToArchive({
      pkgDir: path.join(packageDir, "dependency"),
      outDir: packageDir,
      outName: "archive-runtime-peer.tgz",
    });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "peer-only-archive",
        version: "1.0.0",
        openclaw: { extensions: ["./dist/index.cjs"] },
        [dependencyKind]: { "archive-runtime-peer": "file:./archive-runtime-peer.tgz" },
      }),
    );
    await fs.writeFile(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "peer-only-archive", configSchema: { type: "object", properties: {} } }),
    );
    await fs.writeFile(
      path.join(packageDir, "dist/index.cjs"),
      'module.exports = { id: "peer-only-archive", register() {}, value: require("archive-runtime-peer") };\n',
    );
    const archivePath = await packToArchive({
      pkgDir: packageDir,
      outDir: rootDir,
      outName: "peer-only-archive.tgz",
    });
    const result = await withPluginCache(createPluginCache(), () =>
      installPluginFromPath({
        path: archivePath,
        extensionsDir: path.join(stateDir, "extensions"),
        config: {},
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) {
      return;
    }
    const entryPath = path.join(result.targetDir, "dist/index.cjs");
    const require = createRequire(entryPath);
    try {
      expect((require(entryPath) as { value: string }).value).toBe("installed runtime peer");
    } finally {
      for (const filename of Object.keys(require.cache)) {
        if (filename.startsWith(`${rootDir}${path.sep}`)) {
          delete require.cache[filename];
        }
      }
    }
  },
);
