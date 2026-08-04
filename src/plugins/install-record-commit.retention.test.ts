// Regression coverage for retained managed npm install retirement.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import { listRecoveredManagedNpmInstallCandidates } from "./installed-plugin-index-record-reader.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const PLUGIN_ID = "qa-retained-uninstall";
const PACKAGE_NAME = "@openclaw/qa-retained-uninstall";

const mocks = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  replaceConfigFile: vi.fn(),
  transformConfigFileWithRetry: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecords: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  replaceConfigFile: mocks.replaceConfigFile,
  resolveConfigWriteAfterWrite: (value?: unknown) => value ?? { mode: "auto" },
  transformConfigFileWithRetry: mocks.transformConfigFileWithRetry,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
    writePersistedInstalledPluginIndexInstallRecords:
      mocks.writePersistedInstalledPluginIndexInstallRecords,
  };
});

import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";

type ManagedFixture = {
  stateDir: string;
  installPath: string;
  previousInstallRecords: Record<string, PluginInstallRecord>;
};

async function withManagedFixture(
  run: (fixture: ManagedFixture) => Promise<void>,
  layout: "project" | "legacy" = "project",
): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-record-retained-"));
  try {
    const installPath = writeManagedNpmPlugin({
      stateDir,
      packageName: PACKAGE_NAME,
      pluginId: PLUGIN_ID,
      version: "1.0.0",
      layout,
    });
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      run({
        stateDir,
        installPath,
        previousInstallRecords: {
          [PLUGIN_ID]: { source: "npm", spec: `${PACKAGE_NAME}@1.0.0`, installPath },
        },
      }),
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function recoveredIds(stateDir: string): string[] {
  return listRecoveredManagedNpmInstallCandidates({ stateDir }).map(
    (candidate) => candidate.pluginId,
  );
}

function localRecord(installPath: string): PluginInstallRecord {
  return { source: "path", sourcePath: installPath, installPath };
}

describe("retained managed npm install transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.replaceConfigFile.mockImplementation(async (params: { nextConfig: OpenClawConfig }) => ({
      path: "/tmp/openclaw.json",
      previousHash: null,
      snapshot: {} as never,
      nextConfig: params.nextConfig,
      persistedHash: "test-config-hash",
      afterWrite: { mode: "auto" },
      followUp: { mode: "auto", requiresRestart: false },
    }));
    mocks.writePersistedInstalledPluginIndexInstallRecords.mockResolvedValue(undefined);
  });

  it.each(["project", "legacy"] as const)(
    "keeps removed %s npm package files without recovering their plugin",
    async (layout) => {
      await withManagedFixture(async ({ stateDir, installPath, previousInstallRecords }) => {
        expect(recoveredIds(stateDir)).toContain(PLUGIN_ID);

        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords,
          nextInstallRecords: {},
          nextConfig: {},
        });

        expect(fs.statSync(installPath).isDirectory()).toBe(true);
        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(true);
        expect(recoveredIds(stateDir)).not.toContain(PLUGIN_ID);
      }, layout);
    },
  );

  it.each(["project", "legacy"] as const)(
    "retires a retained %s npm package when its plugin moves to a local path",
    async (layout) => {
      await withManagedFixture(async ({ stateDir, installPath, previousInstallRecords }) => {
        const localInstallPath = path.join(stateDir, "extensions", PLUGIN_ID);
        fs.mkdirSync(localInstallPath, { recursive: true });

        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords,
          nextInstallRecords: { [PLUGIN_ID]: localRecord(localInstallPath) },
          nextConfig: {},
        });

        expect(fs.statSync(installPath).isDirectory()).toBe(true);
        expect(fs.statSync(localInstallPath).isDirectory()).toBe(true);
        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(true);
        expect(recoveredIds(stateDir)).not.toContain(PLUGIN_ID);
      }, layout);
    },
  );

  it("does not retire an npm package still used by its replacement", async () => {
    await withManagedFixture(async ({ stateDir, installPath, previousInstallRecords }) => {
      await commitPluginInstallRecordsWithConfig({
        previousInstallRecords,
        nextInstallRecords: { [PLUGIN_ID]: localRecord(installPath) },
        nextConfig: {},
      });

      expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
      expect(recoveredIds(stateDir)).toContain(PLUGIN_ID);
    });
  });

  it.each(["direct", "symlink"] as const)(
    "keeps a %s migrated plugin path active ahead of an earlier npm replacement",
    async (replacementPath) => {
      await withManagedFixture(async ({ stateDir, installPath }) => {
        let activePath = installPath;
        if (replacementPath === "symlink") {
          activePath = path.join(stateDir, "linked", PLUGIN_ID);
          fs.mkdirSync(path.dirname(activePath), { recursive: true });
          fs.symlinkSync(installPath, activePath, "dir");
        }
        const newerNpmInstallPath = path.join(
          stateDir,
          "npm",
          "projects",
          "qa-retained-new-generation",
          "node_modules",
          "@openclaw",
          "qa-retained-uninstall",
        );
        fs.mkdirSync(newerNpmInstallPath, { recursive: true });

        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {
            "legacy-qa-retained-uninstall": {
              source: "npm",
              spec: `${PACKAGE_NAME}@1.0.0`,
              installPath,
            },
          },
          nextInstallRecords: {
            "qa-newer-generation": {
              source: "npm",
              spec: `${PACKAGE_NAME}@2.0.0`,
              installPath: newerNpmInstallPath,
            },
            [PLUGIN_ID]: localRecord(activePath),
          },
          nextConfig: {},
        });

        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
        expect(recoveredIds(stateDir)).toContain(PLUGIN_ID);
      });
    },
  );

  it.each(["direct", "symlink"] as const)(
    "keeps a %s package active when its original plugin id moves elsewhere",
    async (replacementPath) => {
      await withManagedFixture(async ({ stateDir, installPath, previousInstallRecords }) => {
        const newInstallPath = path.join(stateDir, "extensions", PLUGIN_ID);
        fs.mkdirSync(newInstallPath, { recursive: true });
        let activePath = installPath;
        if (replacementPath === "symlink") {
          activePath = path.join(stateDir, "linked", "qa-live-retained-package");
          fs.mkdirSync(path.dirname(activePath), { recursive: true });
          fs.symlinkSync(installPath, activePath, "dir");
        }

        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords,
          nextInstallRecords: {
            [PLUGIN_ID]: localRecord(newInstallPath),
            "qa-live-retained-package": localRecord(activePath),
          },
          nextConfig: {},
        });

        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
        expect(recoveredIds(stateDir)).toContain(PLUGIN_ID);
      });
    },
  );

  it.each(["removed", "local migration"] as const)(
    "restores recovery and the installed index after a failed %s transaction",
    async (transition) => {
      await withManagedFixture(async ({ stateDir, installPath, previousInstallRecords }) => {
        const localInstallPath = path.join(stateDir, "extensions", PLUGIN_ID);
        fs.mkdirSync(localInstallPath, { recursive: true });
        const nextInstallRecords: Record<string, PluginInstallRecord> =
          transition === "removed" ? {} : { [PLUGIN_ID]: localRecord(localInstallPath) };
        mocks.replaceConfigFile.mockRejectedValueOnce(new Error("config changed"));

        await expect(
          commitPluginInstallRecordsWithConfig({
            previousInstallRecords,
            nextInstallRecords,
            nextConfig: {},
          }),
        ).rejects.toThrow("config changed");

        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
        expect(recoveredIds(stateDir)).toContain(PLUGIN_ID);
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(
          1,
          nextInstallRecords,
        );
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(
          2,
          previousInstallRecords,
        );
      });
    },
  );

  it.each(["EACCES", "EMFILE", "EIO"] as const)(
    "rolls back when retained npm ownership fails with %s",
    async (code) => {
      await withManagedFixture(async ({ stateDir, installPath, previousInstallRecords }) => {
        const ownershipError = Object.assign(new Error("managed npm root is inaccessible"), {
          code,
        });
        const realpath = vi.spyOn(fs, "realpathSync").mockImplementationOnce(() => {
          throw ownershipError;
        });

        try {
          await expect(
            commitPluginInstallRecordsWithConfig({
              previousInstallRecords,
              nextInstallRecords: {},
              nextConfig: {},
            }),
          ).rejects.toBe(ownershipError);

          expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
          expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(
            1,
            {},
          );
          expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(
            2,
            previousInstallRecords,
          );
          expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
          expect(recoveredIds(stateDir)).toContain(PLUGIN_ID);
        } finally {
          realpath.mockRestore();
        }
      });
    },
  );

  it("rolls back when an active install cannot be resolved", async () => {
    await withManagedFixture(async ({ stateDir, installPath, previousInstallRecords }) => {
      const ownershipError = Object.assign(new Error("active install is inaccessible"), {
        code: "EACCES",
      });
      const realpath = vi.spyOn(fs, "realpathSync").mockImplementationOnce(() => {
        throw ownershipError;
      });
      const nextInstallRecords = { [PLUGIN_ID]: localRecord(installPath) };

      try {
        await expect(
          commitPluginInstallRecordsWithConfig({
            previousInstallRecords,
            nextInstallRecords,
            nextConfig: {},
          }),
        ).rejects.toBe(ownershipError);

        expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(
          1,
          nextInstallRecords,
        );
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(
          2,
          previousInstallRecords,
        );
        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
        expect(recoveredIds(stateDir)).toContain(PLUGIN_ID);
      } finally {
        realpath.mockRestore();
      }
    });
  });

  it("does not mark removed packages outside the managed npm root", async () => {
    await withManagedFixture(async ({ stateDir }) => {
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-record-outside-"));
      try {
        const installPath = writeManagedNpmPlugin({
          stateDir: outsideRoot,
          packageName: PACKAGE_NAME,
          pluginId: PLUGIN_ID,
          version: "1.0.0",
        });

        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {
            [PLUGIN_ID]: { source: "npm", spec: `${PACKAGE_NAME}@1.0.0`, installPath },
          },
          nextInstallRecords: {},
          nextConfig: {},
        });

        expect(fs.statSync(installPath).isDirectory()).toBe(true);
        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
        expect(recoveredIds(stateDir)).toContain(PLUGIN_ID);
      } finally {
        fs.rmSync(outsideRoot, { recursive: true, force: true });
      }
    });
  });

  it("does not follow a package symlink outside the managed npm root", async () => {
    await withManagedFixture(async ({ stateDir }) => {
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-record-outside-"));
      try {
        const outsidePackage = writeManagedNpmPlugin({
          stateDir: outsideRoot,
          packageName: PACKAGE_NAME,
          pluginId: PLUGIN_ID,
          version: "1.0.0",
        });
        const installPath = path.join(
          stateDir,
          "npm",
          "projects",
          "qa-redirected-package",
          "node_modules",
          "@openclaw",
          "qa-retained-uninstall",
        );
        fs.mkdirSync(path.dirname(installPath), { recursive: true });
        fs.symlinkSync(outsidePackage, installPath, "dir");

        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {
            [PLUGIN_ID]: { source: "npm", spec: `${PACKAGE_NAME}@1.0.0`, installPath },
          },
          nextInstallRecords: {},
          nextConfig: {},
        });

        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
        expect(hasRetainedManagedNpmInstallMarker(outsidePackage)).toBe(false);
      } finally {
        fs.rmSync(outsideRoot, { recursive: true, force: true });
      }
    });
  });

  it("does not redirect a retired project into another active generation", async () => {
    await withManagedFixture(async ({ stateDir, installPath }) => {
      const projectRoot = path.dirname(path.dirname(path.dirname(installPath)));
      const redirectedProject = path.join(stateDir, "npm", "projects", "qa-redirected-project");
      fs.symlinkSync(projectRoot, redirectedProject, "dir");
      const redirectedPackage = path.join(
        redirectedProject,
        "node_modules",
        "@openclaw",
        "qa-retained-uninstall",
      );

      await commitPluginInstallRecordsWithConfig({
        previousInstallRecords: {
          [PLUGIN_ID]: {
            source: "npm",
            spec: `${PACKAGE_NAME}@1.0.0`,
            installPath: redirectedPackage,
          },
        },
        nextInstallRecords: {},
        nextConfig: {},
      });

      expect(hasRetainedManagedNpmInstallMarker(redirectedPackage)).toBe(false);
      expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
      expect(recoveredIds(stateDir)).toContain(PLUGIN_ID);
    });
  });
});
