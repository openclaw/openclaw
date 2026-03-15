import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { buildBackupArchiveRoot } from "./backup-shared.js";
import { backupVerifyCommand } from "./backup-verify.js";
import { backupCreateCommand } from "./backup.js";

const TEST_ARCHIVE_ROOT = "2026-03-09T00-00-00.000Z-openclaw-backup";

const createBackupVerifyRuntime = () => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
});

function createBackupManifest(assetArchivePath: string) {
  return {
    schemaVersion: 1,
    createdAt: "2026-03-09T00:00:00.000Z",
    archiveRoot: TEST_ARCHIVE_ROOT,
    runtimeVersion: "test",
    platform: process.platform,
    nodeVersion: process.version,
    assets: [
      {
        kind: "state",
        sourcePath: "/tmp/.openclaw",
        archivePath: assetArchivePath,
      },
    ],
  };
}

async function withBrokenArchiveFixture(
  options: {
    tempPrefix: string;
    manifestAssetArchivePath: string;
    payloads: Array<{ fileName: string; contents: string; archivePath?: string }>;
    buildTarEntries?: (paths: { manifestPath: string; payloadPaths: string[] }) => string[];
  },
  run: (archivePath: string) => Promise<void>,
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), options.tempPrefix));
  const archivePath = path.join(tempDir, "broken.tar.gz");
  const manifestPath = path.join(tempDir, "manifest.json");
  const payloadSpecs = await Promise.all(
    options.payloads.map(async (payload) => {
      const payloadPath = path.join(tempDir, payload.fileName);
      await fs.writeFile(payloadPath, payload.contents, "utf8");
      return {
        path: payloadPath,
        archivePath: payload.archivePath ?? options.manifestAssetArchivePath,
      };
    }),
  );
  const payloadEntryPathBySource = new Map(
    payloadSpecs.map((payload) => [payload.path, payload.archivePath]),
  );

  try {
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(createBackupManifest(options.manifestAssetArchivePath), null, 2)}\n`,
      "utf8",
    );
    await tar.c(
      {
        file: archivePath,
        gzip: true,
        portable: true,
        preservePaths: true,
        onWriteEntry: (entry) => {
          if (entry.path === manifestPath) {
            entry.path = `${TEST_ARCHIVE_ROOT}/manifest.json`;
            return;
          }
          const payloadEntryPath = payloadEntryPathBySource.get(entry.path);
          if (payloadEntryPath) {
            entry.path = payloadEntryPath;
          }
        },
      },
      options.buildTarEntries?.({
        manifestPath,
        payloadPaths: payloadSpecs.map((payload) => payload.path),
      }) ?? [manifestPath, ...payloadSpecs.map((payload) => payload.path)],
    );
    await run(archivePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe("backupVerifyCommand", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-verify-test-");
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("verifies an archive created by backup create", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-out-"));
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "hello\n", "utf8");

      const runtime = createBackupVerifyRuntime();
      const nowMs = Date.UTC(2026, 2, 9, 0, 0, 0);
      const created = await backupCreateCommand(runtime, { output: archiveDir, nowMs });
      const verified = await backupVerifyCommand(runtime, { archive: created.archivePath });

      expect(verified.ok).toBe(true);
      expect(verified.archiveRoot).toBe(buildBackupArchiveRoot(nowMs));
      expect(verified.assetCount).toBeGreaterThan(0);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("fails when the archive does not contain a manifest", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-no-manifest-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    try {
      const root = path.join(tempDir, "root");
      await fs.mkdir(path.join(root, "payload"), { recursive: true });
      await fs.writeFile(path.join(root, "payload", "data.txt"), "x\n", "utf8");
      await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, ["root"]);

      const runtime = createBackupVerifyRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /expected exactly one backup manifest entry/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when the manifest references a missing asset payload", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-missing-asset-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    try {
      const rootName = "2026-03-09T00-00-00.000Z-openclaw-backup";
      const root = path.join(tempDir, rootName);
      await fs.mkdir(root, { recursive: true });
      const manifest = {
        schemaVersion: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
        archiveRoot: rootName,
        runtimeVersion: "test",
        platform: process.platform,
        nodeVersion: process.version,
        assets: [
          {
            kind: "state",
            sourcePath: "/tmp/.openclaw",
            archivePath: `${rootName}/payload/posix/tmp/.openclaw`,
          },
        ],
      };
      await fs.writeFile(
        path.join(root, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, [rootName]);

      const runtime = createBackupVerifyRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /missing payload for manifest asset/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when archive paths contain traversal segments", async () => {
    const traversalPath = `${TEST_ARCHIVE_ROOT}/payload/../escaped.txt`;
    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-traversal-",
        manifestAssetArchivePath: traversalPath,
        payloads: [{ fileName: "payload.txt", contents: "payload\n", archivePath: traversalPath }],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /path traversal segments/i,
        );
      },
    );
  });

  it("fails when archive paths contain backslashes", async () => {
    const invalidPath = `${TEST_ARCHIVE_ROOT}/payload\\..\\escaped.txt`;
    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-backslash-",
        manifestAssetArchivePath: invalidPath,
        payloads: [{ fileName: "payload.txt", contents: "payload\n", archivePath: invalidPath }],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /forward slashes/i,
        );
      },
    );
  });

  it("ignores payload manifest.json files when locating the backup manifest", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const externalWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const configPath = path.join(tempHome.home, "custom-config.json");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-out-"));
    try {
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace: externalWorkspace,
            },
          },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "hello\n", "utf8");
      await fs.writeFile(
        path.join(externalWorkspace, "manifest.json"),
        JSON.stringify({ name: "workspace-payload" }),
        "utf8",
      );

      const runtime = createBackupVerifyRuntime();
      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: true,
        nowMs: Date.UTC(2026, 2, 9, 2, 0, 0),
      });
      const verified = await backupVerifyCommand(runtime, { archive: created.archivePath });

      expect(verified.ok).toBe(true);
      expect(verified.assetCount).toBeGreaterThanOrEqual(2);
    } finally {
      delete process.env.OPENCLAW_CONFIG_PATH;
      await fs.rm(externalWorkspace, { recursive: true, force: true });
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("fails when the archive contains duplicate root manifest entries", async () => {
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/payload.txt`;
    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-duplicate-manifest-",
        manifestAssetArchivePath: payloadArchivePath,
        payloads: [{ fileName: "payload.txt", contents: "payload\n" }],
        buildTarEntries: ({ manifestPath, payloadPaths }) => [
          manifestPath,
          manifestPath,
          ...payloadPaths,
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /expected exactly one backup manifest entry, found 2/i,
        );
      },
    );
  });

  it("fails when the archive contains duplicate payload entries", async () => {
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/payload.txt`;
    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-duplicate-payload-",
        manifestAssetArchivePath: payloadArchivePath,
        payloads: [
          { fileName: "payload-a.txt", contents: "payload-a\n", archivePath: payloadArchivePath },
          { fileName: "payload-b.txt", contents: "payload-b\n", archivePath: payloadArchivePath },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /duplicate entry path/i,
        );
      },
    );
  });
});
