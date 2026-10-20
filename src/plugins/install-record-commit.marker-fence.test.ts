import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const retentionTempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.lease.assertOwned.mockReset();
    cleanup();
  }),
);

const mocks = vi.hoisted(() => {
  const lease = {
    databasePath: "/tmp/openclaw-plugin-index.sqlite",
    signal: new AbortController().signal,
    assertOwned: vi.fn(),
    assertOwnedInTransaction: vi.fn(),
  };
  return {
    lease,
    replace: vi.fn(),
    restore:
      vi.fn<
        typeof import("./installed-plugin-index-store-write.js").restorePersistedInstalledPluginIndexIfCurrent
      >(),
    withLease: vi.fn(
      async (_options: unknown, run: (activeLease: typeof lease) => Promise<unknown>) =>
        await run(lease),
    ),
    write:
      vi.fn<
        typeof import("./installed-plugin-index-records.js").writePersistedInstalledPluginIndexInstallRecordsWithLease
      >(),
  };
});

// mock-isolation: Exercise marker ownership without loading or writing operator config.
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: async () => ({ valid: true, config: {} }),
  replaceConfigFile: mocks.replace,
  resolveConfigWriteAfterWrite: (value?: unknown) => value ?? { mode: "auto" },
  transformConfigFileWithRetry: vi.fn(),
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  writePersistedInstalledPluginIndexInstallRecordsWithLease: mocks.write,
}));

vi.mock("./installed-plugin-index-store-write.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-store-write.js")>()),
  restorePersistedInstalledPluginIndexIfCurrent: mocks.restore,
}));

// mock-isolation: Supply the controlled lease whose revocation these marker tests exercise.
vi.mock("./plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: mocks.withLease,
}));

import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";

function createRetainedMarkerFixture(stateDir: string, pluginId = "retained-fence") {
  const packageName = `@openclaw/${pluginId}`;
  const installPath = writeManagedNpmPlugin({
    stateDir,
    packageName,
    pluginId,
    version: "1.0.0",
  });
  return {
    installPath,
    markerPath: resolveRetainedManagedNpmInstallMarkerPath(installPath),
    record: { source: "npm" as const, spec: `${packageName}@1.0.0`, installPath },
  };
}

function authority() {
  const auth = {
    current: true,
    failure: new Error("update authority revoked"),
    assert: () => {
      if (!auth.current) {
        throw auth.failure;
      }
    },
  };
  return auth;
}

async function expectRefusal(
  stateDir: string,
  failure: Error,
  params: Omit<Parameters<typeof commitPluginInstallRecordsWithConfig>[0], "nextConfig">,
) {
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
    expect(commitPluginInstallRecordsWithConfig({ ...params, nextConfig: {} })).rejects.toBe(
      failure,
    ),
  );
}

function mark(fixture: ReturnType<typeof createRetainedMarkerFixture>) {
  return markRetainedManagedNpmInstall({
    packageDir: fixture.installPath,
    pluginId: "retained-fence",
    reason: "retained-package",
  });
}

describe("plugin install record marker fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replace.mockReset();
    mocks.restore.mockResolvedValue(true);
    mocks.write.mockResolvedValue({
      previous: null,
      revision: 1,
      mutation: {
        databasePath: "/tmp/openclaw.sqlite",
        before: null,
        after: { state_key: "plugins.installedIndex", value_json: "{}", updated_at_ms: 1 },
      },
    });
  });

  it.each([
    ["retirement", "lease", "preparation"],
    ["retirement", "invoker", "preparation"],
    ["activation", "lease", "preparation"],
    ["activation", "invoker", "removal"],
    ["activation", "invoker", "directory cleanup"],
  ] as const)(
    "fences awaited %s markers using %s authority at %s",
    async (transition, owner, boundary) => {
      const stateDir = retentionTempDirs.make("openclaw-record-marker-fence-");
      const fixture = createRetainedMarkerFixture(stateDir);
      if (transition === "activation") {
        await mark(fixture);
      }
      const before =
        transition === "activation" ? fs.readFileSync(fixture.markerPath, "utf8") : undefined;
      const siblingMarker = path.join(path.dirname(fixture.markerPath), "unrelated.json");
      if (boundary === "directory cleanup") {
        fs.writeFileSync(siblingMarker, "unrelated marker");
      }
      const records = { "retained-fence": fixture.record };
      const auth = authority();
      const targetPath =
        boundary === "preparation" && transition === "retirement"
          ? fixture.installPath
          : boundary === "directory cleanup"
            ? path.dirname(fixture.markerPath)
            : fixture.markerPath;
      const after = async <T>(operation: Promise<T>, target: unknown) => {
        let completed = false;
        try {
          const result = await operation;
          completed = true;
          return result;
        } finally {
          if ((completed || boundary === "directory cleanup") && String(target) === targetPath) {
            auth.current = false;
          }
        }
      };
      const stat = fs.promises.stat.bind(fs.promises);
      const readFile = fs.promises.readFile.bind(fs.promises);
      const rm = fs.promises.rm.bind(fs.promises);
      const rmdir = fs.promises.rmdir.bind(fs.promises);
      if (boundary === "preparation" && transition === "retirement") {
        vi.spyOn(fs.promises, "stat").mockImplementation((target, options) =>
          after(stat(target, options), target),
        );
      } else if (boundary === "preparation") {
        vi.spyOn(fs.promises, "readFile").mockImplementation((target, options) =>
          after(readFile(target, options), target),
        );
      } else if (boundary === "removal") {
        vi.spyOn(fs.promises, "rm").mockImplementation((target, options) =>
          after(rm(target, options), target),
        );
      } else {
        vi.spyOn(fs.promises, "rmdir").mockImplementation((target) => after(rmdir(target), target));
      }
      if (owner === "lease") {
        mocks.lease.assertOwned.mockImplementation(auth.assert);
      }
      await expectRefusal(stateDir, auth.failure, {
        previousInstallRecords: transition === "retirement" ? records : {},
        nextInstallRecords: transition === "activation" ? records : {},
        ...(owner === "invoker" ? { writeOptions: { assertConfigPathForWrite: auth.assert } } : {}),
      });
      expect(auth.current).toBe(false);
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(mocks.restore).toHaveBeenCalledTimes(owner === "invoker" ? 1 : 0);
      if (before !== undefined) {
        expect(fs.readFileSync(fixture.markerPath, "utf8")).toBe(before);
      } else {
        expect(fs.existsSync(path.dirname(fixture.markerPath))).toBe(false);
      }
      expect(fs.existsSync(fixture.installPath)).toBe(true);
      if (boundary === "directory cleanup") {
        expect(fs.readFileSync(siblingMarker, "utf8")).toBe("unrelated marker");
      }
    },
  );

  it("preserves later retirement markers when rollback loses authority after an awaited removal", async () => {
    const stateDir = retentionTempDirs.make("openclaw-record-marker-rollback-fence-");
    const first = createRetainedMarkerFixture(stateDir, "first-retained");
    const second = createRetainedMarkerFixture(stateDir, "second-retained");
    const auth = authority();
    const rm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      await rm(target, options);
      if (String(target) === first.markerPath) {
        auth.current = false;
      }
    });
    mocks.lease.assertOwned.mockImplementation(auth.assert);
    let markerBeforeRollback = "";
    mocks.replace.mockImplementationOnce(async () => {
      markerBeforeRollback = fs.readFileSync(second.markerPath, "utf8");
      throw new Error("config changed");
    });
    await expectRefusal(stateDir, auth.failure, {
      previousInstallRecords: { "first-retained": first.record, "second-retained": second.record },
      nextInstallRecords: {},
    });
    expect(mocks.restore).toHaveBeenCalledOnce();
    expect(fs.existsSync(first.markerPath)).toBe(false);
    expect(markerBeforeRollback).not.toBe("");
    expect(fs.readFileSync(second.markerPath, "utf8")).toBe(markerBeforeRollback);
    expect(fs.existsSync(first.installPath)).toBe(true);
    expect(fs.existsSync(second.installPath)).toBe(true);
  });

  it("fences marker restoration after rollback directory preparation loses authority", async () => {
    const stateDir = retentionTempDirs.make("openclaw-record-marker-restore-fence-");
    const fixture = createRetainedMarkerFixture(stateDir);
    await mark(fixture);
    const auth = authority();
    const mkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, "mkdir").mockImplementation(async (target, options) => {
      const result = await mkdir(target, options);
      if (String(target) === path.dirname(fixture.markerPath)) {
        auth.current = false;
      }
      return result;
    });
    mocks.lease.assertOwned.mockImplementation(auth.assert);
    mocks.replace.mockRejectedValueOnce(new Error("config changed"));
    await expectRefusal(stateDir, auth.failure, {
      previousInstallRecords: {},
      nextInstallRecords: { "retained-fence": fixture.record },
    });
    expect(auth.current).toBe(false);
    expect(mocks.restore).toHaveBeenCalledOnce();
    expect(fs.existsSync(fixture.markerPath)).toBe(false);
    expect(fs.existsSync(path.dirname(fixture.markerPath))).toBe(true);
    expect(fs.existsSync(fixture.installPath)).toBe(true);
  });
});
