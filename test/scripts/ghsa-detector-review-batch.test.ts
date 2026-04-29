import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveInsideDirectory,
  summarizeCaseStatus,
  validateCoverage,
} from "../../scripts/run-ghsa-detector-review-batch.mjs";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-ghsa-detector-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("GHSA detector-review coverage helpers", () => {
  it("fails closed when required coverage did not complete", () => {
    expect(
      summarizeCaseStatus({
        exitCode: 0,
        hasReport: true,
        coverageRequired: true,
        coverage: { ok: false, reason: "no-commits" },
      }),
    ).toBe("coverage-failed");

    expect(
      summarizeCaseStatus({
        exitCode: 0,
        hasReport: true,
        coverageRequired: true,
      }),
    ).toBe("coverage-failed");
  });

  it("keeps no-coverage retry status for valid A=yes zero-finding coverage", () => {
    expect(
      summarizeCaseStatus({
        exitCode: 0,
        hasReport: true,
        coverageRequired: true,
        coverage: {
          ok: true,
          aDecision: "yes",
          findings: 0,
          additiveFix: false,
        },
      }),
    ).toBe("no-coverage");
  });

  it("rejects extracted-as paths that would escape the temp scan directory", () => {
    const root = path.join(path.sep, "tmp", "scan-root");
    expect(resolveInsideDirectory(root, "src/index.ts")).toBe(path.join(root, "src", "index.ts"));
    expect(resolveInsideDirectory(root, "../../escape.ts")).toBeNull();
    expect(resolveInsideDirectory(root, "/tmp/escape.ts")).toBeNull();
    expect(resolveInsideDirectory(root, "C:\\tmp\\escape.ts")).toBeNull();
  });

  it("marks coverage failed when extracted-as points outside the temp tree", async () => {
    const root = await makeTempDir();
    const workspace = path.join(root, "case");
    const reportPath = path.join(workspace, "report.md");
    const rulePath = path.join(workspace, "opengrep", "general-rule.yml");
    await mkdir(path.dirname(rulePath), { recursive: true });
    await writeFile(rulePath, "rules: []\n", "utf8");
    await writeFile(
      reportPath,
      [
        "| `A` | detector | yes |",
        "Fix commit: abcdef1234567890",
        "Vulnerable commit: 123456abcdef0",
        "Extracted-as: src/a.ts -> ../../escape.ts",
      ].join("\n"),
      "utf8",
    );

    const coverage = await validateCoverage({
      reportPath,
      caseWorkspaceRoot: workspace,
      repoRoot: root,
      ghsaId: "GHSA-AAAA-BBBB-CCCC",
      runCommand: async (argv: string[]) => {
        if (argv[3] === "diff-tree") {
          return { code: 0, stdout: "src/a.ts\n", stderr: "" };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      },
    });

    expect(coverage).toMatchObject({
      ok: false,
      reason: "vuln-invalid-extracted-as",
      file: "src/a.ts",
      renamed: "../../escape.ts",
    });
  });

  it("marks coverage failed when opengrep exits non-zero", async () => {
    const root = await makeTempDir();
    const workspace = path.join(root, "case");
    const reportPath = path.join(workspace, "report.md");
    const rulePath = path.join(workspace, "opengrep", "general-rule.yml");
    await mkdir(path.dirname(rulePath), { recursive: true });
    await writeFile(rulePath, "rules: []\n", "utf8");
    await writeFile(
      reportPath,
      [
        "| `A` | detector | yes |",
        "Fix commit: abcdef1234567890",
        "Vulnerable commit: 123456abcdef0",
      ].join("\n"),
      "utf8",
    );

    const coverage = await validateCoverage({
      reportPath,
      caseWorkspaceRoot: workspace,
      repoRoot: root,
      ghsaId: "GHSA-AAAA-BBBB-CCCC",
      runCommand: async (argv: string[]) => {
        if (argv[3] === "diff-tree") {
          return { code: 0, stdout: "src/a.ts\n", stderr: "" };
        }
        if (argv[3] === "show") {
          return { code: 0, stdout: "const value = 1;\n", stderr: "" };
        }
        if (argv[0] === "opengrep") {
          return {
            code: 2,
            stdout: '{"errors":[{"type":"Rule parse error"}]}',
            stderr: "bad rule",
          };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      },
    });

    expect(coverage).toMatchObject({
      ok: false,
      reason: "vuln-opengrep-failed",
      exitCode: 2,
    });
  });
});
