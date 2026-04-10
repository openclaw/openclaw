import { describe, expect, it } from "vitest";
import {
  buildExtensionsNodeModulesFilter,
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

describe("buildExtensionsNodeModulesFilter", () => {
  const filter = buildExtensionsNodeModulesFilter("/home/user/.openclaw");

  it("allows non-extension paths through", () => {
    expect(filter("/home/user/.openclaw/openclaw.json")).toBe(true);
    expect(filter("/home/user/.openclaw/sessions/abc.jsonl")).toBe(true);
  });

  it("allows extension files that are not inside node_modules", () => {
    expect(filter("/home/user/.openclaw/extensions/my-plugin/package.json")).toBe(true);
    expect(filter("/home/user/.openclaw/extensions/my-plugin/dist/index.js")).toBe(true);
    expect(filter("/home/user/.openclaw/extensions/my-plugin/openclaw.plugin.json")).toBe(true);
  });

  it("excludes node_modules inside extensions", () => {
    expect(filter("/home/user/.openclaw/extensions/my-plugin/node_modules/foo/index.js")).toBe(
      false,
    );
    expect(
      filter("/home/user/.openclaw/extensions/my-plugin/node_modules/.package-lock.json"),
    ).toBe(false);
  });

  it("excludes nested node_modules inside extensions", () => {
    expect(
      filter(
        "/home/user/.openclaw/extensions/my-plugin/node_modules/foo/node_modules/bar/index.js",
      ),
    ).toBe(false);
  });

  it("does not exclude node_modules outside extensions", () => {
    expect(filter("/home/user/.openclaw/node_modules/something")).toBe(true);
  });

  it("handles Windows-style backslash paths", () => {
    const winFilter = buildExtensionsNodeModulesFilter("C:\\Users\\user\\.openclaw");
    expect(winFilter("C:\\Users\\user\\.openclaw\\extensions\\my-plugin\\package.json")).toBe(true);
    expect(
      winFilter("C:\\Users\\user\\.openclaw\\extensions\\my-plugin\\node_modules\\foo\\index.js"),
    ).toBe(false);
  });
});
