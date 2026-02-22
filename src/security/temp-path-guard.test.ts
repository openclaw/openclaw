import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const RUNTIME_ROOTS = ["src", "extensions"];
const SKIP_PATTERNS = [
  /\.test\.tsx?$/,
  /\.test-helpers\.tsx?$/,
  /\.test-utils\.tsx?$/,
  /\.e2e\.tsx?$/,
  /\.d\.ts$/,
  /[\\/](?:__tests__|tests)[\\/]/,
  /[\\/][^\\/]*test-helpers(?:\.[^\\/]+)?\.ts$/,
];

function shouldSkip(relativePath: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function isIdentifierNamed(node: ts.Node, name: string): node is ts.Identifier {
  return ts.isIdentifier(node) && node.text === name;
}

function isPathJoinCall(expr: ts.LeftHandSideExpression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "join" &&
    isIdentifierNamed(expr.expression, "path")
  );
}

function isOsTmpdirCall(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "tmpdir" &&
    isIdentifierNamed(node.expression.expression, "os")
  );
}

function isDynamicTemplateSegment(node: ts.Expression): boolean {
  return ts.isTemplateExpression(node);
}

function mightContainDynamicTmpdirJoin(source: string): boolean {
  return source.includes("path.join") && source.includes("os.tmpdir") && source.includes("`");
}

function hasDynamicTmpdirJoin(source: string, filePath = "fixture.ts"): boolean {
  if (!mightContainDynamicTmpdirJoin(source)) {
    return false;
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      ts.isCallExpression(node) &&
      isPathJoinCall(node.expression) &&
      node.arguments.length >= 2 &&
      isOsTmpdirCall(node.arguments[0]) &&
      node.arguments.slice(1).some((arg) => isDynamicTemplateSegment(arg))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
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

function prefilterLikelyTmpdirJoinFiles(root: string): Set<string> | null {
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
    "--no-messages",
  ];
  const joined = spawnSync("rg", [...commonArgs, "path\\.join", root], { encoding: "utf8" });
  if (joined.error || (joined.status !== 0 && joined.status !== 1)) {
    return null;
  }
  const tmpdir = spawnSync("rg", [...commonArgs, "os\\.tmpdir", root], { encoding: "utf8" });
  if (tmpdir.error || (tmpdir.status !== 0 && tmpdir.status !== 1)) {
    return null;
  }
  const joinMatches = parsePathList(joined.stdout);
  const tmpdirMatches = parsePathList(tmpdir.stdout);
  const intersection = new Set<string>();
  for (const file of joinMatches) {
    if (tmpdirMatches.has(file)) {
      intersection.add(file);
    }
  }
  return intersection;
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

    for (const root of RUNTIME_ROOTS) {
      const absRoot = path.join(repoRoot, root);
      const rgPrefiltered = prefilterLikelyTmpdirJoinFiles(absRoot);
      const files = rgPrefiltered ? [...rgPrefiltered] : await listTsFiles(absRoot);
      for (const file of files) {
        const relativePath = path.relative(repoRoot, file);
        if (shouldSkip(relativePath)) {
          continue;
        }
        const source = await fs.readFile(file, "utf8");
        if (hasDynamicTmpdirJoin(source, relativePath)) {
          offenders.push(relativePath);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
