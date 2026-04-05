import { describe, expect, it } from "vitest";
import { formatBackupCreateSummary, type BackupCreateResult } from "./backup-create.js";

function makeResult(overrides: Partial<BackupCreateResult> = {}): BackupCreateResult {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    archiveRoot: "mullusi-backup-2026-01-01",
    archivePath: "/tmp/mullusi-backup.tar.gz",
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
  const backupArchiveLine = "Backup archive: /tmp/mullusi-backup.tar.gz";

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
            displayPath: "~/.mullusi",
          },
        ],
        skipped: [
          {
            kind: "workspace",
            sourcePath: "/workspace",
            displayPath: "~/Projects/mullusi",
            reason: "covered",
            coveredBy: "~/.mullusi",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 1 path:",
        "- state: ~/.mullusi",
        "Skipped 1 path:",
        "- workspace: ~/Projects/mullusi (covered by ~/.mullusi)",
        "Created /tmp/mullusi-backup.tar.gz",
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
            displayPath: "~/.mullusi/config.json",
          },
          {
            kind: "credentials",
            sourcePath: "/oauth",
            archivePath: "archive/oauth",
            displayPath: "~/.mullusi/oauth",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 2 paths:",
        "- config: ~/.mullusi/config.json",
        "- credentials: ~/.mullusi/oauth",
        "Dry run only; archive was not written.",
      ],
    },
  ])("$name", ({ result, expected }) => {
    expect(formatBackupCreateSummary(result)).toEqual(expected);
  });
});
