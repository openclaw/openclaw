import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, syncClawHubDocsTree } from "../../scripts/docs-sync-publish.mjs";

describe("docs-sync-publish", () => {
  it("parses docs sync provenance args", () => {
    expect(
      parseArgs([
        "--target",
        "generated-docs",
        "--source-repo",
        "openclaw/openclaw",
        "--source-sha",
        "abc123",
        "--clawhub-repo",
        "../clawhub",
        "--clawhub-source-repo",
        "openclaw/clawhub",
        "--clawhub-source-sha",
        "def456",
      ]),
    ).toMatchObject({
      clawhubRepo: "../clawhub",
      clawhubSourceRepo: "openclaw/clawhub",
      clawhubSourceSha: "def456",
      sourceRepo: "openclaw/openclaw",
      sourceSha: "abc123",
      target: "generated-docs",
    });
  });

  it("rejects missing docs sync option values", () => {
    for (const flag of [
      "--target",
      "--source-repo",
      "--source-sha",
      "--clawhub-repo",
      "--clawhub-source-repo",
      "--clawhub-source-sha",
    ]) {
      expect(() => parseArgs([flag])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "--target", "generated-docs"])).toThrow(
        `${flag} requires a value`,
      );
    }
  });

  it("interpolates the ClawHub npm release tag from the ClawHub package version", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-sync-clawhub-"));
    const clawhubRepo = join(root, "clawhub");
    const targetDocs = join(root, "target-docs");

    mkdirSync(join(clawhubRepo, "docs"), { recursive: true });
    mkdirSync(join(clawhubRepo, "packages", "clawhub"), { recursive: true });
    mkdirSync(targetDocs, { recursive: true });

    writeFileSync(
      join(clawhubRepo, "packages", "clawhub", "package.json"),
      `${JSON.stringify({ version: "0.20.3" }, null, 2)}\n`,
    );
    writeFileSync(
      join(clawhubRepo, "docs", "cli.md"),
      [
        "# CLI",
        "",
        "```yaml",
        "uses: openclaw/clawhub/.github/workflows/package-publish.yml@{{CLAWHUB_NPM_RELEASE_TAG}}",
        "```",
        "",
      ].join("\n"),
    );

    const result = syncClawHubDocsTree(targetDocs, {
      repoPath: clawhubRepo,
      sourceRepo: "openclaw/clawhub",
      sourceSha: "abc123",
    });

    expect(result.npmReleaseTag).toBe("v0.20.3");
    expect(readFileSync(join(targetDocs, "clawhub", "cli.md"), "utf8")).toContain(
      "package-publish.yml@v0.20.3",
    );
  });
});
