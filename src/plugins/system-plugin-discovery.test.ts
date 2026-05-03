import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverOpenClawPlugins } from "./discovery.js";
import { setSystemPluginsDirOverrideForTest } from "./roots.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

vi.mock("./bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-system-plugin", tempDirs);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
  setSystemPluginsDirOverrideForTest(undefined);
});

function buildDiscoveryEnv(stateDir: string): NodeJS.ProcessEnv {
  const bundledPluginsDir = path.join(stateDir, "empty-bundled-plugins");
  mkdirSafeDir(bundledPluginsDir);
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_HOME: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
  };
}

function writePluginManifest(params: { pluginDir: string; id: string }) {
  fs.writeFileSync(
    path.join(params.pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      configSchema: { type: "object" },
    }),
    "utf-8",
  );
}

function writePluginEntry(filePath: string) {
  fs.writeFileSync(filePath, "export default function () {}", "utf-8");
}

describe("system plugin discovery", () => {
  it("discovers plugins in the system directory with origin=system", () => {
    const stateDir = makeTempDir();
    const systemDir = makeTempDir();
    setSystemPluginsDirOverrideForTest(systemDir);
    const pluginDir = path.join(systemDir, "my-system-interceptor");
    mkdirSafeDir(pluginDir);
    writePluginManifest({ pluginDir, id: "my-system-interceptor" });
    writePluginEntry(path.join(pluginDir, "index.js"));

    const env = buildDiscoveryEnv(stateDir);
    const { candidates } = discoverOpenClawPlugins({ env });

    const systemCandidates = candidates.filter((c) => c.origin === "system");
    expect(systemCandidates).toHaveLength(1);
    expect(systemCandidates[0]!.idHint).toBe("my-system-interceptor");
    expect(systemCandidates[0]!.origin).toBe("system");
  });

  it("discovers multiple plugins in the system directory", () => {
    const stateDir = makeTempDir();
    const systemDir = makeTempDir();
    setSystemPluginsDirOverrideForTest(systemDir);

    for (const id of ["sys-a", "sys-b", "sys-c"]) {
      const pluginDir = path.join(systemDir, id);
      mkdirSafeDir(pluginDir);
      writePluginManifest({ pluginDir, id });
      writePluginEntry(path.join(pluginDir, "index.js"));
    }

    const env = buildDiscoveryEnv(stateDir);
    const { candidates } = discoverOpenClawPlugins({ env });

    const systemCandidates = candidates.filter((c) => c.origin === "system");
    expect(systemCandidates).toHaveLength(3);
    const ids = systemCandidates.map((c) => c.idHint).sort();
    expect(ids).toEqual(["sys-a", "sys-b", "sys-c"]);
  });

  it("system candidates appear before config/global candidates", () => {
    const stateDir = makeTempDir();
    const systemDir = makeTempDir();
    setSystemPluginsDirOverrideForTest(systemDir);

    const sysPluginDir = path.join(systemDir, "priority-test");
    mkdirSafeDir(sysPluginDir);
    writePluginManifest({ pluginDir: sysPluginDir, id: "priority-test" });
    writePluginEntry(path.join(sysPluginDir, "index.js"));

    const globalDir = path.join(stateDir, "extensions", "global-test");
    mkdirSafeDir(globalDir);
    writePluginManifest({ pluginDir: globalDir, id: "global-test" });
    writePluginEntry(path.join(globalDir, "index.js"));

    const env = buildDiscoveryEnv(stateDir);
    const { candidates } = discoverOpenClawPlugins({ env });

    const systemIndex = candidates.findIndex((c) => c.origin === "system");
    const globalIndex = candidates.findIndex((c) => c.origin === "global");
    expect(systemIndex).toBeGreaterThanOrEqual(0);
    if (globalIndex >= 0) {
      expect(systemIndex).toBeLessThan(globalIndex);
    }
  });

  it("produces no system candidates when the directory is empty", () => {
    const stateDir = makeTempDir();
    setSystemPluginsDirOverrideForTest(makeTempDir());

    const env = buildDiscoveryEnv(stateDir);
    const { candidates } = discoverOpenClawPlugins({ env });

    const systemCandidates = candidates.filter((c) => c.origin === "system");
    expect(systemCandidates).toHaveLength(0);
  });

  it("produces no system candidates when the directory does not exist", () => {
    const stateDir = makeTempDir();
    setSystemPluginsDirOverrideForTest(path.join(stateDir, "nonexistent-system-dir"));

    const env = buildDiscoveryEnv(stateDir);
    const { candidates } = discoverOpenClawPlugins({ env });

    const systemCandidates = candidates.filter((c) => c.origin === "system");
    expect(systemCandidates).toHaveLength(0);
  });
});
