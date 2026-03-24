import { describe, expect, it } from "vitest";
import {
  crossPlatformRelative,
  formatMigrateImportSummary,
  MIGRATE_IMPORT_LIMITS,
  type MigrateImportResult,
  parseManifest,
  toPosixPath,
} from "./migrate-import.js";

function makeResult(overrides: Partial<MigrateImportResult> = {}): MigrateImportResult {
  return {
    archivePath: "/tmp/openclaw-migrate.tar.gz",
    manifest: {
      createdAt: "2026-01-01T00:00:00.000Z",
      platform: "linux",
      runtimeVersion: "2026.1.1",
      components: ["config", "credentials", "workspace", "sessions"],
      agents: [],
    },
    dryRun: false,
    merge: false,
    assets: [],
    warnings: [],
    ...overrides,
  };
}

describe("formatMigrateImportSummary", () => {
  it("formats a basic import result", () => {
    const lines = formatMigrateImportSummary(
      makeResult({
        assets: [
          {
            kind: "config",
            sourcePath: "/root/.openclaw/openclaw.json",
            targetPath: "/home/user/.openclaw/openclaw.json",
            displayTargetPath: "~/.openclaw/openclaw.json",
          },
        ],
      }),
    );

    expect(lines).toContain("Migration archive: /tmp/openclaw-migrate.tar.gz");
    expect(lines.some((l) => l.includes("linux"))).toBe(true);
    expect(lines).toContain("Components: config, credentials, workspace, sessions");
    expect(lines).toContain("Mode: overwrite");
    expect(lines).toContain("Importing 1 path:");
    expect(lines.some((l) => l.includes("config: ~/.openclaw/openclaw.json"))).toBe(true);
    expect(lines).toContain("Import complete.");
  });

  it("shows merge mode", () => {
    const lines = formatMigrateImportSummary(makeResult({ merge: true }));
    expect(lines).toContain("Mode: merge (deep-merging config into existing)");
  });

  it("shows dry-run notice", () => {
    const lines = formatMigrateImportSummary(makeResult({ dryRun: true }));
    expect(lines).toContain("Dry run only; no files were written.");
    expect(lines.every((l) => l !== "Import complete.")).toBe(true);
  });

  it("shows warnings", () => {
    const lines = formatMigrateImportSummary(
      makeResult({
        warnings: [
          "Source platform (linux) differs from this machine (darwin). Paths will be remapped.",
        ],
      }),
    );

    expect(lines).toContain("Warnings:");
    expect(lines.some((l) => l.includes("Source platform"))).toBe(true);
  });

  it("shows agent IDs when present", () => {
    const lines = formatMigrateImportSummary(
      makeResult({
        manifest: {
          createdAt: "2026-01-01T00:00:00.000Z",
          platform: "linux",
          runtimeVersion: "2026.1.1",
          components: ["sessions"],
          agents: ["main", "research"],
        },
        assets: [
          {
            kind: "agents",
            sourcePath: "/root/.openclaw/agents/main",
            targetPath: "/home/user/.openclaw/agents/main",
            displayTargetPath: "~/.openclaw/agents/main",
            agentId: "main",
          },
        ],
      }),
    );

    expect(lines).toContain("Agents: main, research");
    expect(lines.some((l) => l.includes("(agent: main)"))).toBe(true);
  });
});

describe("toPosixPath", () => {
  it("converts Windows drive-letter paths to POSIX", () => {
    expect(toPosixPath("C:\\Users\\alice\\.openclaw")).toBe("/C/Users/alice/.openclaw");
  });

  it("converts Windows paths with forward slashes", () => {
    expect(toPosixPath("D:/data/.openclaw")).toBe("/D/data/.openclaw");
  });

  it("passes POSIX paths through unchanged", () => {
    expect(toPosixPath("/home/user/.openclaw")).toBe("/home/user/.openclaw");
  });

  it("handles mixed separators", () => {
    expect(toPosixPath("C:\\Users/alice\\.openclaw")).toBe("/C/Users/alice/.openclaw");
  });
});

describe("crossPlatformRelative", () => {
  it("returns relative path for POSIX child under POSIX parent", () => {
    expect(crossPlatformRelative("/home/user/.openclaw", "/home/user/.openclaw/agents/main")).toBe(
      "agents/main",
    );
  });

  it("returns relative path for Windows child under Windows parent", () => {
    expect(
      crossPlatformRelative(
        "C:\\Users\\alice\\.openclaw",
        "C:\\Users\\alice\\.openclaw\\agents\\main",
      ),
    ).toBe("agents/main");
  });

  it("returns undefined when child is not under parent", () => {
    expect(crossPlatformRelative("/home/user/.openclaw", "/home/other/.openclaw")).toBe(undefined);
  });

  it("returns empty string when paths are equal", () => {
    expect(crossPlatformRelative("/home/user/.openclaw", "/home/user/.openclaw")).toBe("");
  });
});

describe("parseManifest", () => {
  function validManifestJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: 1,
      kind: "migrate",
      createdAt: "2026-01-01T00:00:00.000Z",
      archiveRoot: "openclaw-migrate-2026-01-01",
      runtimeVersion: "2026.1.1",
      platform: "linux",
      nodeVersion: "v22.0.0",
      components: ["config"],
      agents: [],
      paths: {
        stateDir: "/root/.openclaw",
        configPath: "/root/.openclaw/openclaw.json",
        oauthDir: "/root/.openclaw/credentials",
        workspaceDirs: [],
      },
      assets: [
        {
          kind: "config",
          sourcePath: "/root/.openclaw/openclaw.json",
          archivePath: "openclaw-migrate-2026-01-01/payload/posix/root/.openclaw/openclaw.json",
        },
      ],
      skipped: [],
      ...overrides,
    });
  }

  it("parses a valid manifest", () => {
    const manifest = parseManifest(validManifestJson());
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.kind).toBe("migrate");
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].sourcePath).toBe("/root/.openclaw/openclaw.json");
  });

  it("rejects assets with empty sourcePath", () => {
    const json = validManifestJson({
      assets: [{ kind: "config", sourcePath: "", archivePath: "some/path" }],
    });
    expect(() => parseManifest(json)).toThrow("missing sourcePath or archivePath");
  });

  it("rejects assets with empty archivePath", () => {
    const json = validManifestJson({
      assets: [{ kind: "config", sourcePath: "/some/path", archivePath: "  " }],
    });
    expect(() => parseManifest(json)).toThrow("missing sourcePath or archivePath");
  });

  it("rejects assets with non-string sourcePath", () => {
    const json = validManifestJson({
      assets: [{ kind: "config", sourcePath: 123, archivePath: "some/path" }],
    });
    expect(() => parseManifest(json)).toThrow("missing sourcePath or archivePath");
  });

  it("rejects non-migrate kind", () => {
    expect(() => parseManifest(validManifestJson({ kind: "backup" }))).toThrow(
      "not a migration archive",
    );
  });

  it("rejects invalid JSON", () => {
    expect(() => parseManifest("not json")).toThrow("not valid JSON");
  });

  it("rejects assets with unknown kind", () => {
    const json = validManifestJson({
      assets: [{ kind: "unknown_thing", sourcePath: "/some/path", archivePath: "some/archive" }],
    });
    expect(() => parseManifest(json)).toThrow("unsupported kind");
  });

  it("rejects assets with empty kind", () => {
    const json = validManifestJson({
      assets: [{ kind: "", sourcePath: "/some/path", archivePath: "some/archive" }],
    });
    expect(() => parseManifest(json)).toThrow("unsupported kind");
  });

  it("accepts all valid asset kinds", () => {
    const json = validManifestJson({
      assets: [
        { kind: "config", sourcePath: "/a", archivePath: "x/payload/a" },
        { kind: "credentials", sourcePath: "/b", archivePath: "x/payload/b" },
        { kind: "workspace", sourcePath: "/c", archivePath: "x/payload/c" },
        { kind: "agents", sourcePath: "/d", archivePath: "x/payload/d" },
        { kind: "state", sourcePath: "/e", archivePath: "x/payload/e" },
      ],
    });
    const manifest = parseManifest(json);
    expect(manifest.assets).toHaveLength(5);
  });

  it("rejects manifest missing paths object", () => {
    const json = validManifestJson({ paths: "not an object" });
    expect(() => parseManifest(json)).toThrow("missing paths");
  });

  it("rejects manifest with empty stateDir", () => {
    const json = validManifestJson({
      paths: {
        stateDir: "",
        configPath: "/root/.openclaw/openclaw.json",
        oauthDir: "/root/.openclaw/credentials",
        workspaceDirs: [],
      },
    });
    expect(() => parseManifest(json)).toThrow("missing required fields");
  });

  it("rejects manifest with missing configPath", () => {
    const json = validManifestJson({
      paths: {
        stateDir: "/root/.openclaw",
        oauthDir: "/root/.openclaw/credentials",
        workspaceDirs: [],
      },
    });
    expect(() => parseManifest(json)).toThrow("missing required fields");
  });
});

describe("MIGRATE_IMPORT_LIMITS", () => {
  it("has reasonable extraction limits", () => {
    expect(MIGRATE_IMPORT_LIMITS.maxEntries).toBe(50_000);
    expect(MIGRATE_IMPORT_LIMITS.maxExtractedBytes).toBe(512 * 1024 * 1024);
    expect(MIGRATE_IMPORT_LIMITS.maxArchiveBytes).toBe(256 * 1024 * 1024);
  });

  it("archive size limit is smaller than extracted size limit", () => {
    expect(MIGRATE_IMPORT_LIMITS.maxArchiveBytes).toBeLessThan(
      MIGRATE_IMPORT_LIMITS.maxExtractedBytes,
    );
  });
});
