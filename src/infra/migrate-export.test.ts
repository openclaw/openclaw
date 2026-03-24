import { describe, expect, it } from "vitest";
import {
  formatMigrateExportSummary,
  type MigrateExportResult,
  redactConfigSecrets,
} from "./migrate-export.js";

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
    warnings: [],
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

  it("shows warnings", () => {
    const lines = formatMigrateExportSummary(
      makeResult({
        warnings: [
          "--strip-secrets only redacts the JSON config file. credentials (OAuth tokens) are exported unredacted.",
        ],
      }),
    );

    expect(lines).toContain("Warnings:");
    expect(lines.some((l) => l.includes("--strip-secrets only redacts"))).toBe(true);
  });
});

describe("redactConfigSecrets", () => {
  it("redacts known secret keys in nested objects", () => {
    const input = JSON.stringify({
      gateway: { authToken: "secret123" },
      models: { provider: "openai" },
    });
    const result = JSON.parse(redactConfigSecrets(input));
    expect(result.gateway.authToken).toBe("<REDACTED>");
    expect(result.models.provider).toBe("openai");
  });

  it("redacts secrets inside array elements", () => {
    const input = JSON.stringify({
      agents: {
        list: [
          { id: "main", apiToken: "tok_abc" },
          { id: "research", apiKey: "key_xyz", name: "R" },
        ],
      },
    });
    const result = JSON.parse(redactConfigSecrets(input));
    expect(result.agents.list[0].apiToken).toBe("<REDACTED>");
    expect(result.agents.list[0].id).toBe("main");
    expect(result.agents.list[1].apiKey).toBe("<REDACTED>");
    expect(result.agents.list[1].name).toBe("R");
  });

  it("handles deeply nested arrays with secret keys", () => {
    const input = JSON.stringify({
      providers: [{ credentials: [{ secret: "s1" }, { secret: "s2" }] }],
    });
    const result = JSON.parse(redactConfigSecrets(input));
    expect(result.providers[0].credentials[0].secret).toBe("<REDACTED>");
    expect(result.providers[0].credentials[1].secret).toBe("<REDACTED>");
  });

  it("throws on unparseable config", () => {
    expect(() => redactConfigSecrets("not json {{{")).toThrow("Failed to parse config");
  });

  it("handles JSON5 syntax (comments, trailing commas)", () => {
    const input = `{
      // this is a comment
      "gateway": { "authToken": "secret123", },
    }`;
    const result = JSON.parse(redactConfigSecrets(input));
    expect(result.gateway.authToken).toBe("<REDACTED>");
  });
});
