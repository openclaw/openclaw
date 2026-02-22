import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUNTIME_ROOTS = ["src", "extensions"];
const SKIP_PATTERNS = [
  /\.test\.tsx?$/,
  /\.test-helpers\.tsx?$/,
  /\.test-utils\.tsx?$/,
  /\.test-harness\.tsx?$/,
  /\.e2e\.tsx?$/,
  /\.d\.ts$/,
  /[\\/](?:__tests__|tests)[\\/]/,
  /[\\/][^\\/]*test-helpers(?:\.[^\\/]+)?\.ts$/,
  /[\\/][^\\/]*test-utils(?:\.[^\\/]+)?\.ts$/,
  /[\\/][^\\/]*test-harness(?:\.[^\\/]+)?\.ts$/,
];

type QuoteChar = "'" | '"' | "`";

type QuoteScanState = {
  quote: QuoteChar | null;
  escaped: boolean;
};

function shouldSkip(relativePath: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function stripCommentsForScan(input: string): string {
  return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function findMatchingParen(source: string, openIndex: number): number {
  let depth = 1;
  const quoteState: QuoteScanState = { quote: null, escaped: false };
  for (let i = openIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (consumeQuotedChar(quoteState, ch)) {
      continue;
    }
    if (beginQuotedSection(quoteState, ch)) {
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function splitTopLevelArguments(source: string): string[] {
  const out: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  const quoteState: QuoteScanState = { quote: null, escaped: false };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoteState.quote) {
      current += ch;
      consumeQuotedChar(quoteState, ch);
      continue;
    }
    if (beginQuotedSection(quoteState, ch)) {
      current += ch;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) {
        parenDepth -= 1;
      }
      current += ch;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      current += ch;
      continue;
    }
    if (ch === "]") {
      if (bracketDepth > 0) {
        bracketDepth -= 1;
      }
      current += ch;
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      current += ch;
      continue;
    }
    if (ch === "}") {
      if (braceDepth > 0) {
        braceDepth -= 1;
      }
      current += ch;
      continue;
    }
    if (ch === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    out.push(current.trim());
  }
  return out;
}

function beginQuotedSection(state: QuoteScanState, ch: string): boolean {
  if (ch !== "'" && ch !== '"' && ch !== "`") {
    return false;
  }
  state.quote = ch;
  return true;
}

function consumeQuotedChar(state: QuoteScanState, ch: string): boolean {
  if (!state.quote) {
    return false;
  }
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (ch === "\\") {
    state.escaped = true;
    return true;
  }
  if (ch === state.quote) {
    state.quote = null;
  }
  return true;
}

function isOsTmpdirExpression(argument: string): boolean {
  return /^os\s*\.\s*tmpdir\s*\(\s*\)$/u.test(argument.trim());
}

function mightContainDynamicTmpdirJoin(source: string): boolean {
  return (
    source.includes("path") &&
    source.includes("join") &&
    source.includes("tmpdir") &&
    source.includes("${")
  );
}

function hasDynamicTmpdirJoin(source: string): boolean {
  if (!mightContainDynamicTmpdirJoin(source)) {
    return false;
  }

  const scanSource = stripCommentsForScan(source);
  const joinPattern = /path\s*\.\s*join\s*\(/gu;
  let match: RegExpExecArray | null = joinPattern.exec(scanSource);
  while (match) {
    const openParenIndex = scanSource.indexOf("(", match.index);
    if (openParenIndex !== -1) {
      const closeParenIndex = findMatchingParen(scanSource, openParenIndex);
      if (closeParenIndex !== -1) {
        const argsSource = scanSource.slice(openParenIndex + 1, closeParenIndex);
        const args = splitTopLevelArguments(argsSource);
        if (args.length >= 2 && isOsTmpdirExpression(args[0])) {
          for (const arg of args.slice(1)) {
            const trimmed = arg.trim();
            if (trimmed.startsWith("`") && trimmed.includes("${")) {
              return true;
            }
          }
        }
      }
    }
    match = joinPattern.exec(scanSource);
  }
  return false;
}

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(fullPath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")) {
      out.push(fullPath);
    }
  }
  return out;
}

function parsePathList(stdout: string): Set<string> {
  const out = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    out.add(path.resolve(trimmed));
  }
  return out;
}

function prefilterLikelyTmpdirJoinFiles(roots: readonly string[]): Set<string> | null {
  const commonArgs = [
    "--files-with-matches",
    "--glob",
    "*.ts",
    "--glob",
    "*.tsx",
    "--glob",
    "!**/*.test.ts",
    "--glob",
    "!**/*.test.tsx",
    "--glob",
    "!**/*.e2e.ts",
    "--glob",
    "!**/*.e2e.tsx",
    "--glob",
    "!**/*.d.ts",
    "--glob",
    "!**/*test-helpers*.ts",
    "--glob",
    "!**/*test-helpers*.tsx",
    "--glob",
    "!**/*test-utils*.ts",
    "--glob",
    "!**/*test-utils*.tsx",
    "--glob",
    "!**/*test-harness*.ts",
    "--glob",
    "!**/*test-harness*.tsx",
    "--no-messages",
  ];
  const strictDynamicCall = spawnSync(
    "rg",
    [
      ...commonArgs,
      "-P",
      "-U",
      "(?s)path\\s*\\.\\s*join\\s*\\(\\s*os\\s*\\.\\s*tmpdir\\s*\\([^`]*`",
      ...roots,
    ],
    { encoding: "utf8" },
  );
  if (
    !strictDynamicCall.error &&
    (strictDynamicCall.status === 0 || strictDynamicCall.status === 1)
  ) {
    return parsePathList(strictDynamicCall.stdout);
  }

  const candidateCall = spawnSync(
    "rg",
    [...commonArgs, "path\\s*\\.\\s*join\\s*\\(\\s*os\\s*\\.\\s*tmpdir\\s*\\(", ...roots],
    { encoding: "utf8" },
  );
  if (candidateCall.error || (candidateCall.status !== 0 && candidateCall.status !== 1)) {
    return null;
  }
  return parsePathList(candidateCall.stdout);
}

describe("temp path guard", () => {
  it("skips test helper filename variants", () => {
    expect(shouldSkip("src/commands/test-helpers.ts")).toBe(true);
    expect(shouldSkip("src/commands/sessions.test-helpers.ts")).toBe(true);
    expect(shouldSkip("src\\commands\\sessions.test-helpers.ts")).toBe(true);
  });

  it("detects dynamic and ignores static fixtures", () => {
    const dynamicFixtures = [
      "const p = path.join(os.tmpdir(), `openclaw-${id}`);",
      "const p = path.join(os.tmpdir(), 'safe', `${token}`);",
    ];
    const staticFixtures = [
      "const p = path.join(os.tmpdir(), 'openclaw-fixed');",
      "const p = path.join(os.tmpdir(), `openclaw-fixed`);",
      "const p = path.join(os.tmpdir(), prefix + '-x');",
      "const p = path.join(os.tmpdir(), segment);",
      "const p = path.join('/tmp', `openclaw-${id}`);",
      "// path.join(os.tmpdir(), `openclaw-${id}`)",
      "const p = path.join(os.tmpdir());",
    ];

    for (const fixture of dynamicFixtures) {
      expect(hasDynamicTmpdirJoin(fixture)).toBe(true);
    }
    for (const fixture of staticFixtures) {
      expect(hasDynamicTmpdirJoin(fixture)).toBe(false);
    }
  });
  it("blocks dynamic template path.join(os.tmpdir(), ...) in runtime source files", async () => {
    const repoRoot = process.cwd();
    const offenders: string[] = [];
    const scanRoots = RUNTIME_ROOTS.map((root) => path.join(repoRoot, root));
    const rgPrefiltered = prefilterLikelyTmpdirJoinFiles(scanRoots);
    const prefilteredByRoot = new Map<string, string[]>();
    if (rgPrefiltered) {
      for (const file of rgPrefiltered) {
        for (const absRoot of scanRoots) {
          if (file.startsWith(absRoot + path.sep)) {
            const bucket = prefilteredByRoot.get(absRoot) ?? [];
            bucket.push(file);
            prefilteredByRoot.set(absRoot, bucket);
            break;
          }
        }
      }
    }

    for (const root of RUNTIME_ROOTS) {
      const absRoot = path.join(repoRoot, root);
      const files = rgPrefiltered
        ? (prefilteredByRoot.get(absRoot) ?? [])
        : await listTsFiles(absRoot);
      for (const file of files) {
        const relativePath = path.relative(repoRoot, file);
        if (shouldSkip(relativePath)) {
          continue;
        }
        const source = await fs.readFile(file, "utf8");
        if (hasDynamicTmpdirJoin(source)) {
          offenders.push(relativePath);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
