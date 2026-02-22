import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCAN_ROOTS = ["src", "extensions"] as const;
const RUNTIME_TS_GLOBS = [
  "*.ts",
  "!*.test.ts",
  "!*.test-helpers.ts",
  "!*.test-utils.ts",
  "!*.e2e.ts",
  "!*.d.ts",
  "!**/__tests__/**",
  "!**/tests/**",
  "!**/*test-helpers*.ts",
  "!**/*test-utils*.ts",
] as const;

const SKIP_RUNTIME_SOURCE_PATH_PATTERNS = [
  /\.test\.tsx?$/,
  /\.test-helpers\.tsx?$/,
  /\.test-utils\.tsx?$/,
  /\.e2e\.tsx?$/,
  /\.d\.ts$/,
  /[\\/](?:__tests__|tests)[\\/]/,
  /[\\/][^\\/]*test-helpers(?:\.[^\\/]+)?\.ts$/,
  /[\\/][^\\/]*test-utils(?:\.[^\\/]+)?\.ts$/,
];

function shouldSkipRuntimeSourcePath(relativePath: string): boolean {
  return SKIP_RUNTIME_SOURCE_PATH_PATTERNS.some((pattern) => pattern.test(relativePath));
}

async function findWeakRandomPatternMatches(repoRoot: string): Promise<string[]> {
  const rgResult = spawnSync(
    "rg",
    [
      "--line-number",
      "--no-heading",
      "--color=never",
      ...RUNTIME_TS_GLOBS.flatMap((glob) => ["--glob", glob]),
      "Date\\.now.*Math\\.random|Math\\.random.*Date\\.now",
      ...SCAN_ROOTS,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (!rgResult.error && (rgResult.status === 0 || rgResult.status === 1)) {
    const matches: string[] = [];
    const lines = rgResult.stdout.split(/\r?\n/);
    for (const line of lines) {
      const text = line.trim();
      if (!text) {
        continue;
      }
      const parsed = /^(.*?):(\d+):(.*)$/.exec(text);
      if (!parsed) {
        continue;
      }
      const relativePath = parsed[1] ?? "";
      const lineNumber = parsed[2] ?? "";
      if (shouldSkipRuntimeSourcePath(relativePath)) {
        continue;
      }
      matches.push(`${relativePath}:${lineNumber}`);
    }
    return matches;
  }

  const [{ default: fs }, pathModule, { listRuntimeSourceFiles }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("../test-utils/repo-scan.js"),
  ]);

  const matches: string[] = [];
  const files = await listRuntimeSourceFiles(repoRoot, {
    roots: SCAN_ROOTS,
    extensions: [".ts"],
  });
  for (const filePath of files) {
    const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      if (!line.includes("Date.now") || !line.includes("Math.random")) {
        continue;
      }
      matches.push(`${pathModule.relative(repoRoot, filePath)}:${idx + 1}`);
    }
  }
  return matches;
}

describe("weak random pattern guardrail", () => {
  it("rejects Date.now + Math.random token/id patterns in runtime code", async () => {
    const repoRoot = process.cwd();
    const matches = await findWeakRandomPatternMatches(repoRoot);
    expect(matches).toEqual([]);
  });
});
