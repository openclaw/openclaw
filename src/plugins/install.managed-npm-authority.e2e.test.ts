import fsSync from "node:fs";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { normalizeComparablePath } from "../infra/install-package-dir.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolvePluginNpmProjectDir } from "./install-paths.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";
import { installPluginFromNpmPackArchive, installPluginFromNpmSpec } from "./install.js";
import { packPlugins, startStaticRegistry } from "./test-helpers/npm-registry-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  } finally {
    try {
      closeOpenClawStateDatabaseForTest();
    } finally {
      vi.unstubAllEnvs();
    }
  }
});

it.each(["npm", "npm-pack"] as const)(
  "refuses a returned Promise after real %s preparation without moving the original project",
  { timeout: 120_000 },
  async (source) => {
    const rootDir = tempDirs.make("openclaw-managed-npm-authority-");
    const npmDir = path.join(rootDir, "managed-npm");
    const packageName = "managed-authority-fixture";
    vi.stubEnv("OPENCLAW_HOME", rootDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(rootDir, "state"));
    vi.stubEnv("NPM_CONFIG_CACHE", path.join(rootDir, "npm-cache"));
    vi.stubEnv("npm_config_cache", path.join(rootDir, "npm-cache"));
    const versions = await packPlugins(rootDir, [
      { packageName, version: "1.0.0", indexJs: "export const revision = 1;\n" },
      { packageName, version: "2.0.0", indexJs: "export const revision = 2;\n" },
    ]);
    const registry = await startStaticRegistry(
      [{ packageName, latest: "2.0.0", versions }],
      servers,
    );
    vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
    vi.stubEnv("npm_config_registry", registry);
    const install = (
      version: string,
      options: Pick<
        Parameters<typeof installPluginFromNpmSpec>[0],
        "beforePersistentApply" | "onBeforePluginArtifactCommit"
      > = {},
    ) => {
      const params = {
        npmDir,
        mode: "update" as const,
        expectedPluginId: packageName,
        config: {},
        timeoutMs: 120_000,
        ...options,
      };
      return source === "npm"
        ? installPluginFromNpmSpec({ ...params, spec: `${packageName}@${version}` })
        : installPluginFromNpmPackArchive({
            ...params,
            archivePath: path.join(rootDir, `${packageName}-${version}.tgz`),
          });
    };
    const original = await install("1.0.0");
    if (!original.ok) {
      throw new Error(original.error);
    }
    expect(original.version).toBe("1.0.0");
    const projectRoot = resolvePluginNpmProjectDir({ npmDir, packageName });
    const identity = await fs.lstat(projectRoot, { bigint: true });
    const protectedFiles = [
      path.join(projectRoot, "package.json"),
      path.join(projectRoot, "package-lock.json"),
      path.join(original.targetDir, "package.json"),
      path.join(original.targetDir, "dist", "index.js"),
    ];
    const before = await Promise.all(protectedFiles.map((file) => fs.readFile(file)));
    const events: string[] = [];
    const preparedVersions: string[] = [];
    const onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler = async ({
      stagedArtifactDir,
    }) => {
      const manifest = JSON.parse(
        await fs.readFile(path.join(stagedArtifactDir, "package.json"), "utf8"),
      ) as { version: string };
      preparedVersions.push(manifest.version);
      events.push("prepared");
    };
    const beforePersistentApply = vi.fn<() => unknown>(() => {
      events.push("asserted");
      return Promise.resolve();
    });
    const rename = vi.spyOn(fs, "rename");
    const renameSync = vi.spyOn(fsSync, "renameSync");
    const result = await install("2.0.0", {
      beforePersistentApply,
      onBeforePluginArtifactCommit,
    });

    expect(preparedVersions).toEqual(["2.0.0"]);
    expect(result).toEqual({
      ok: false,
      error:
        "Failed to publish managed npm project: TypeError: mutation authority must be synchronous",
    });
    expect(events).toEqual(["prepared", "asserted"]);
    expect(beforePersistentApply).toHaveBeenCalledOnce();
    const movesOriginalProject = ([from, to]: Parameters<typeof fs.rename>) =>
      [from, to].some(
        (entry) => normalizeComparablePath(String(entry)) === normalizeComparablePath(projectRoot),
      );
    expect(rename.mock.calls.filter(movesOriginalProject)).toEqual([]);
    expect(renameSync.mock.calls.filter(movesOriginalProject)).toEqual([]);
    expect(await fs.lstat(projectRoot, { bigint: true })).toMatchObject({
      dev: identity.dev,
      ino: identity.ino,
    });
    expect(await Promise.all(protectedFiles.map((file) => fs.readFile(file)))).toEqual(before);
    expect(await fs.readFile(path.join(original.targetDir, "dist", "index.js"), "utf8")).toBe(
      "export const revision = 1;\n",
    );
  },
);
