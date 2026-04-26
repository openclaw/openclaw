import { describe, expect, it } from "vitest";
import {
  findAssetsBypassingExcludes,
  formatBackupCreateSummary,
  type BackupCreateResult,
} from "./backup-create.js";

function makeResult(overrides: Partial<BackupCreateResult> = {}): BackupCreateResult {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    archiveRoot: "openclaw-backup-2026-01-01",
    archivePath: "/tmp/openclaw-backup.tar.gz",
    dryRun: false,
    includeWorkspace: true,
    onlyConfig: false,
    verified: false,
    assets: [],
    skipped: [],
    ...overrides,
  };
}

describe("formatBackupCreateSummary", () => {
  const backupArchiveLine = "Backup archive: /tmp/openclaw-backup.tar.gz";

  it.each([
    {
      name: "formats created archives with included and skipped paths",
      result: makeResult({
        verified: true,
        assets: [
          {
            kind: "state",
            sourcePath: "/state",
            archivePath: "archive/state",
            displayPath: "~/.openclaw",
          },
        ],
        skipped: [
          {
            kind: "workspace",
            sourcePath: "/workspace",
            displayPath: "~/Projects/openclaw",
            reason: "covered",
            coveredBy: "~/.openclaw",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 1 path:",
        "- state: ~/.openclaw",
        "Skipped 1 path:",
        "- workspace: ~/Projects/openclaw (covered by ~/.openclaw)",
        "Created /tmp/openclaw-backup.tar.gz",
        "Archive verification: passed",
      ],
    },
    {
      name: "formats dry runs and pluralized counts",
      result: makeResult({
        dryRun: true,
        assets: [
          {
            kind: "config",
            sourcePath: "/config",
            archivePath: "archive/config",
            displayPath: "~/.openclaw/config.json",
          },
          {
            kind: "credentials",
            sourcePath: "/oauth",
            archivePath: "archive/oauth",
            displayPath: "~/.openclaw/oauth",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 2 paths:",
        "- config: ~/.openclaw/config.json",
        "- credentials: ~/.openclaw/oauth",
        "Dry run only; archive was not written.",
      ],
    },
  ])("$name", ({ result, expected }) => {
    expect(formatBackupCreateSummary(result)).toEqual(expected);
  });
});

describe("findAssetsBypassingExcludes", () => {
  const stateDir = "/home/user/.openclaw";
  const assets = [
    { kind: "state", sourcePath: "/home/user/.openclaw" },
    { kind: "config", sourcePath: "/home/user/.openclaw/config.json" },
    { kind: "workspace", sourcePath: "/tmp/external-workspace-abc" },
    { kind: "config", sourcePath: "/etc/openclaw/custom-config.json" },
  ];

  it("returns [] when no excludes are active", () => {
    expect(findAssetsBypassingExcludes([], assets, stateDir)).toEqual([]);
  });

  it("returns assets whose sourcePath sits outside the filter's baseDir", () => {
    const bypassed = findAssetsBypassingExcludes(["*.log"], assets, stateDir);
    expect(bypassed.map((a) => a.sourcePath)).toEqual([
      "/tmp/external-workspace-abc",
      "/etc/openclaw/custom-config.json",
    ]);
  });

  it("returns [] when every asset lives inside baseDir", () => {
    const inside = assets.slice(0, 2);
    expect(findAssetsBypassingExcludes(["*.log"], inside, stateDir)).toEqual([]);
  });
});
