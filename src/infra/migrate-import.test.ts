import { describe, expect, it } from "vitest";
import { formatMigrateImportSummary, type MigrateImportResult } from "./migrate-import.js";

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
