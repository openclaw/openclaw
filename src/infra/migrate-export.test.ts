import { describe, expect, it } from "vitest";
import { formatMigrateExportSummary, type MigrateExportResult } from "./migrate-export.js";

function makeResult(overrides: Partial<MigrateExportResult> = {}): MigrateExportResult {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    archiveRoot: "openclaw-migrate-2026-01-01",
    archivePath: "/tmp/openclaw-migrate.tar.gz",
    dryRun: false,
    components: ["config", "credentials", "workspace", "sessions"],
    agents: [],
    stripSecrets: false,
    assets: [],
    skipped: [],
    ...overrides,
  };
}

describe("formatMigrateExportSummary", () => {
  it("formats a basic export result", () => {
    const lines = formatMigrateExportSummary(
      makeResult({
        assets: [
          {
            kind: "config",
            sourcePath: "/home/user/.openclaw/openclaw.json",
            archivePath: "archive/config",
            displayPath: "~/.openclaw/openclaw.json",
          },
        ],
      }),
    );

    expect(lines).toContain("Migration archive: /tmp/openclaw-migrate.tar.gz");
    expect(lines).toContain("Components: config, credentials, workspace, sessions");
    expect(lines).toContain("Included 1 path:");
    expect(lines.some((l) => l.includes("config: ~/.openclaw/openclaw.json"))).toBe(true);
    expect(lines).toContain("Created /tmp/openclaw-migrate.tar.gz");
  });

  it("shows agent IDs when present", () => {
    const lines = formatMigrateExportSummary(
      makeResult({
        agents: ["main", "research"],
        assets: [
          {
            kind: "agents",
            sourcePath: "/home/user/.openclaw/agents/main",
            archivePath: "archive/agents/main",
            displayPath: "~/.openclaw/agents/main",
            agentId: "main",
          },
        ],
      }),
    );

    expect(lines).toContain("Agents: main, research");
    expect(lines.some((l) => l.includes("(agent: main)"))).toBe(true);
  });

  it("shows strip-secrets notice", () => {
    const lines = formatMigrateExportSummary(makeResult({ stripSecrets: true }));
    expect(lines).toContain("Secrets: stripped");
  });

  it("shows dry-run notice", () => {
    const lines = formatMigrateExportSummary(makeResult({ dryRun: true }));
    expect(lines).toContain("Dry run only; archive was not written.");
    expect(lines.every((l) => !l.startsWith("Created"))).toBe(true);
  });

  it("shows skipped assets", () => {
    const lines = formatMigrateExportSummary(
      makeResult({
        skipped: [
          {
            kind: "workspace",
            sourcePath: "/home/user/workspace",
            displayPath: "~/workspace",
            reason: "covered",
          },
        ],
      }),
    );

    expect(lines).toContain("Skipped 1 path:");
    expect(lines.some((l) => l.includes("workspace: ~/workspace (covered)"))).toBe(true);
  });
});
