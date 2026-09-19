// Test Env Mutation Report tests cover test env mutation report script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectTestEnvMutationReport,
  main as runTestEnvMutationReport,
  renderTestEnvMutationReport,
  type TestEnvMutationReport,
} from "../../scripts/test-env-mutation-report.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function writeRepoFile(repoRoot: string, relativePath: string, value: string): void {
  const filePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function makeEnvMutationFixture(): string {
  const repoRoot = createTempDir("openclaw-test-env-mutations-");
  writeRepoFile(
    repoRoot,
    "src/runtime.ts",
    `
process.env.OPENCLAW_STATE_DIR = "ignored because this is not a test file";
`,
  );
  writeRepoFile(
    repoRoot,
    "src/example.test.ts",
    `
process.env.OPENCLAW_STATE_DIR = "state";
delete process.env["OPENCLAW_CONFIG_PATH"];
vi.stubEnv("HOME", "home");
vi.stubEnv("OPENCLAW_WORKSPACE_DIR", "workspace");
process.env = { ...process.env, OPENCLAW_HOME: "home", OTHER_KEY: "ignored" };
const dynamicEnvKey = "OPENCLAW_STATE_DIR";
process.env[dynamicEnvKey] = "dynamic";
delete process.env[dynamicEnvKey];
const fixture = 'process.env.OPENCLAW_HOME = "not code"';
process.env.NOT_OPENCLAW = "ignored";
`,
  );
  writeRepoFile(
    repoRoot,
    "scripts/mcp-code-mode-gateway-e2e.ts",
    `
process.env.OPENCLAW_CONFIG_PATH = "script-harness";
`,
  );
  writeRepoFile(
    repoRoot,
    "src/agents/auth-profiles/oauth-test-utils.ts",
    `
process.env.OPENCLAW_AGENT_DIR = "agent";
`,
  );
  writeRepoFile(
    repoRoot,
    "src/test-utils/openclaw-test-state.ts",
    `
process.env.HOME = "allowed";
delete process.env.OPENCLAW_STATE_DIR;
`,
  );
  return repoRoot;
}

describe("collectTestEnvMutationReport", () => {
  it("reports active OpenClaw env mutations while ignoring strings and non-test files", () => {
    const report = collectTestEnvMutationReport({ repoRoot: makeEnvMutationFixture() });

    expect(
      report.activeFindings.map((finding) => ({
        file: finding.file,
        key: finding.key,
        operation: finding.operation,
      })),
    ).toEqual([
      {
        file: "scripts/mcp-code-mode-gateway-e2e.ts",
        key: "OPENCLAW_CONFIG_PATH",
        operation: "assign",
      },
      {
        file: "src/agents/auth-profiles/oauth-test-utils.ts",
        key: "OPENCLAW_AGENT_DIR",
        operation: "assign",
      },
      { file: "src/example.test.ts", key: "OPENCLAW_STATE_DIR", operation: "assign" },
      { file: "src/example.test.ts", key: "OPENCLAW_CONFIG_PATH", operation: "delete" },
      { file: "src/example.test.ts", key: "HOME", operation: "stubEnv" },
      { file: "src/example.test.ts", key: "OPENCLAW_WORKSPACE_DIR", operation: "stubEnv" },
      { file: "src/example.test.ts", key: "OPENCLAW_HOME", operation: "replace" },
      { file: "src/example.test.ts", key: "<dynamic>", operation: "assign" },
      { file: "src/example.test.ts", key: "<dynamic>", operation: "delete" },
    ]);
    expect(report.allowedFindings).toHaveLength(2);
    expect(report.summary).toMatchObject({
      activeFileCount: 3,
      activeFindingCount: 9,
      allowedFileCount: 1,
      allowedFindingCount: 2,
    });
  });

  it("renders a non-blocking text report for active findings", () => {
    const report = collectTestEnvMutationReport({ repoRoot: makeEnvMutationFixture() });

    const rendered = renderTestEnvMutationReport(report, { includeAllowed: true });

    expect(rendered).toContain("OpenClaw test env mutation report");
    expect(rendered).toContain("Findings: 9 active in 3 file(s), 2 allowed in 1 file(s)");
    expect(rendered).toContain("- src/example.test.ts (7)");
    expect(rendered).toContain("L2 OPENCLAW_STATE_DIR assign process.env");
    expect(rendered).toContain("Allowed harness findings:");
  });

  it("prints JSON from the CLI and exits successfully", () => {
    const repoRoot = makeEnvMutationFixture();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(process.cwd(), "scripts/test-env-mutation-report.ts"),
        "--",
        "--repo-root",
        repoRoot,
        "--json",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as TestEnvMutationReport;
    expect(report.summary.activeFindingCount).toBe(9);
    expect(report.summary.allowedFindingCount).toBe(2);
  });

  it("prints CLI help without scanning the repository", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(process.cwd(), "scripts/test-env-mutation-report.ts"),
        "--help",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("pnpm test:env-mutations:report");
    expect(result.stdout).not.toContain("Scanned files:");
    expect(result.stderr).toBe("");
  });

  it("rejects missing or flag-shaped CLI repo roots instead of scanning zero files", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(process.cwd(), "scripts/test-env-mutation-report.ts"),
        "--",
        "--repo-root",
        "--json",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--repo-root expects a path");
    expect(() => runTestEnvMutationReport(["--", "--repo-root", "-h"])).toThrow(
      "--repo-root expects a path",
    );
  });

  it("rejects loose CLI limits before scanning the repository", () => {
    for (const limit of ["1e3", ""]) {
      expect(() =>
        runTestEnvMutationReport([
          "--",
          "--limit",
          limit,
          "--repo-root",
          createTempDir("openclaw-env-limit-"),
        ]),
      ).toThrow("--limit expects a non-negative integer");
    }
  });

  it.each([
    { limit: 1, shown: 1, allowedShown: 1 },
    { limit: 2, shown: 2, allowedShown: 2 },
    { limit: 0, shown: 3, allowedShown: 2 },
  ])(
    "preserves grouped output and each section's cap with limit $limit",
    ({ limit, shown, allowedShown }) => {
      const repoRoot = createTempDir("openclaw-env-groups-");
      writeRepoFile(repoRoot, "src/a.test.ts", 'process.env.HOME = "a";\n');
      writeRepoFile(
        repoRoot,
        "src/z.test.ts",
        'vi.stubEnv("HOME", "z");\ndelete process.env.HOME;\n',
      );
      writeRepoFile(
        repoRoot,
        "src/test-utils/openclaw-test-state.ts",
        'process.env.HOME = "allowed";\ndelete process.env.HOME;\n',
      );
      const report = collectTestEnvMutationReport({ repoRoot });
      const findings = report.activeFindings;
      report.activeFindings = [
        ...findings.slice(1, 2),
        ...findings.slice(0, 1),
        ...findings.slice(2),
      ];
      const activeLines = [
        "- src/z.test.ts (2)",
        '  L1 HOME vi.stubEnv: vi.stubEnv("HOME", "z");',
        ...(shown >= 2 ? ["  L2 HOME delete process.env: delete process.env.HOME;"] : []),
        ...(shown === 3
          ? ["- src/a.test.ts (1)", '  L1 HOME assign process.env: process.env.HOME = "a";']
          : []),
        ...(shown < 3
          ? [`... ${3 - shown} more finding(s) not shown; pass --limit 0 to show all.`]
          : []),
      ];
      const allowedLines = [
        "- src/test-utils/openclaw-test-state.ts (2)",
        '  L1 HOME assign process.env: process.env.HOME = "allowed";',
        ...(allowedShown === 2
          ? ["  L2 HOME delete process.env: delete process.env.HOME;"]
          : ["... 1 more finding(s) not shown; pass --limit 0 to show all."]),
      ];

      expect(renderTestEnvMutationReport(report, { includeAllowed: true, limit })).toBe(
        [
          "OpenClaw test env mutation report",
          "Scanned files: 3",
          "Findings: 3 active in 2 file(s), 2 allowed in 1 file(s)",
          "",
          "Active findings:",
          ...activeLines,
          "",
          "Allowed harness findings:",
          ...allowedLines,
          "",
        ].join("\n"),
      );
    },
  );

  it("keeps the empty report output unchanged", () => {
    const report = collectTestEnvMutationReport({ repoRoot: createTempDir("openclaw-env-empty-") });
    expect(renderTestEnvMutationReport(report, { includeAllowed: true })).toBe(
      "OpenClaw test env mutation report\nScanned files: 0\nFindings: 0 active in 0 file(s), 0 allowed in 0 file(s)\n\nActive findings: none\n",
    );
  });
});
