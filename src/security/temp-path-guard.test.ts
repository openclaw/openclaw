import { describe, expect, it } from "vitest";
import { loadRuntimeSourceFilesForGuardrails } from "../test-utils/runtime-source-guardrail-scan.js";

const SKIP_PATTERNS = [
  /\.test\.tsx?$/,
  /\.test-helpers\.tsx?$/,
  /\.test-utils\.tsx?$/,
  /\.test-harness\.tsx?$/,
  /\.e2e\.tsx?$/,
  /\.d\.ts$/,
  /[\\/](?:__tests__|tests|test-utils)[\\/]/,
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

  it("enforces runtime guardrails for tmpdir joins and weak randomness", async () => {
    const files = await loadRuntimeSourceFilesForGuardrails(process.cwd());
    const offenders: string[] = [];
    const weakRandomMatches: string[] = [];

    for (const file of files) {
      const relativePath = file.relativePath;
      if (shouldSkip(relativePath)) {
        continue;
      }
      if (hasDynamicTmpdirJoin(file.source)) {
        offenders.push(relativePath);
      }
      if (file.source.includes("Date.now") && file.source.includes("Math.random")) {
        const lines = file.source.split(/\r?\n/);
        for (let idx = 0; idx < lines.length; idx += 1) {
          const line = lines[idx] ?? "";
          if (!line.includes("Date.now") || !line.includes("Math.random")) {
            continue;
          }
          weakRandomMatches.push(`${relativePath}:${idx + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    expect(weakRandomMatches).toEqual([]);
  });
});
