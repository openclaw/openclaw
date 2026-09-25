// Covers fs-safe import boundary rules in source files.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SCAN_ROOTS = ["src", "packages", "extensions"] as const;

const ALLOWED_PREFIXES = ["src/", "packages/memory-host-sdk/"] as const;

function isSourceFile(filePath: string): boolean {
  return filePath.endsWith(".ts") && !filePath.endsWith(".test.ts") && !filePath.endsWith(".d.ts");
}

function listSourceFiles(): string[] {
  const files = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: SCAN_ROOTS });
  if (files) {
    const sourceFiles = files.filter(isSourceFile);
    return SCAN_ROOTS.flatMap((root) =>
      sourceFiles
        .filter((file) => file.startsWith(`${root}/`))
        .map((file) => path.join(REPO_ROOT, file))
        .toSorted(),
    );
  }
  return SCAN_ROOTS.flatMap((root) => {
    const dir = path.join(REPO_ROOT, root);
    return listFindSourceFiles(dir) ?? walkSourceFiles(dir);
  });
}

function listFindSourceFiles(dir: string): string[] | null {
  const result = spawnSync("find", [dir, "-type", "f", "-name", "*.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter(isSourceFile)
    .toSorted();
}

function walkSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      files.push(...walkSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && isSourceFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

const PLUGIN_OWNED_FS_SAFE_IMPORTS: Record<
  string,
  Record<string, { values: readonly string[]; types?: readonly string[] }>
> = {
  "extensions/acpx/src/codex-auth-bridge.ts": {
    "@openclaw/fs-safe/json": { values: ["tryReadJson"] },
  },
  "extensions/codex/src/app-server/computer-use-service-path.ts": {
    "@openclaw/fs-safe/advanced": {
      values: ["assertDirectoryIdentitySync", "readDirectoryIdentity"],
      types: ["DirectoryIdentity"],
    },
  },
  "extensions/codex/src/migration/helpers.ts": {
    "@openclaw/fs-safe/json": { values: ["tryReadJson"] },
  },
  "extensions/cua-computer/src/driver-artifact-verification.ts": {
    "@openclaw/fs-safe/durability": { values: ["sha256FileSync"] },
  },
  "extensions/feishu/src/doctor.ts": {
    "@openclaw/fs-safe/path": { values: ["safeStatSync"] },
  },
  "extensions/llama-cpp/src/llama-server-install.ts": {
    "@openclaw/fs-safe/durability": { values: ["sha256File"] },
  },
  "extensions/migrate-claude/skills.ts": {
    "@openclaw/fs-safe/walk": { values: ["walkDirectory"] },
  },
  "extensions/signal/src/install-signal-cli.ts": {
    "@openclaw/fs-safe/walk": { values: ["walkDirectory"] },
  },
  "extensions/openshell/src/backend.ts": {
    "@openclaw/fs-safe/atomic": {
      values: ["movePathWithCopyFallback"],
      types: ["MovePathPublicationReceipt"],
    },
    "@openclaw/fs-safe/guest": { values: ["GUEST_FILESYSTEM_PYTHON"] },
  },
  "extensions/matrix/src/matrix/state-layout-walk.ts": {
    "@openclaw/fs-safe/path": { values: ["hasNodeErrorCode"] },
    "@openclaw/fs-safe/walk": { values: ["walkDirectory"] },
  },
  "extensions/matrix/src/matrix/monitor/startup-verification.ts": {
    "@openclaw/fs-safe/json": { values: ["tryReadJson"] },
  },
  "extensions/matrix/src/matrix/thread-bindings.ts": {
    "@openclaw/fs-safe/json": { values: ["tryReadJson"] },
  },
  "extensions/memory-core/src/migration/doctor-memory-sidecar.ts": {
    "@openclaw/fs-safe/walk": { values: ["walkDirectory"] },
  },
  "extensions/file-transfer/src/node-host/file-write.ts": {
    "@openclaw/fs-safe/advanced": { values: ["overwriteFileHandle"] },
  },
  "extensions/file-transfer/src/tools/dir-fetch-tool.ts": {
    "@openclaw/fs-safe/durability": { values: ["sha256File"] },
    "@openclaw/fs-safe/walk": { values: ["walkDirectory"] },
  },
};

function sourceWithoutPluginOwnedImports(filePath: string, source: string): string {
  const modules = PLUGIN_OWNED_FS_SAFE_IMPORTS[filePath];
  if (!modules) {
    return source;
  }
  const parsed = parser.parseSourceFile(filePath, source);
  let checkedSource = source;
  for (const statement of parsed.statements.toReversed()) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const allowed = modules[statement.moduleSpecifier.text];
    if (!allowed) {
      continue;
    }
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (
      !clause ||
      clause.name ||
      !bindings ||
      !ts.isNamedImports(bindings) ||
      bindings.elements.length === 0 ||
      !bindings.elements.every((element) => {
        const name = (element.propertyName ?? element.name).text;
        return (
          allowed.values.includes(name) ||
          (allowed.types?.includes(name) &&
            (clause.phaseModifier === ts.SyntaxKind.TypeKeyword || element.isTypeOnly))
        );
      })
    ) {
      continue;
    }
    // These plugins own their dependency; path admission still uses OpenClaw policy.
    const specifier = statement.moduleSpecifier;
    checkedSource =
      checkedSource.slice(0, specifier.getStart(parsed)) + checkedSource.slice(specifier.end);
  }
  return checkedSource;
}

function hasDisallowedFsSafeImport(filePath: string, source: string): boolean {
  if (ALLOWED_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return false;
  }
  const checked = sourceWithoutPluginOwnedImports(filePath, source);
  return checked.includes('"@openclaw/fs-safe') || checked.includes("'@openclaw/fs-safe");
}

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

describe("fs-safe import boundary", () => {
  it("limits File Transfer's archive inventory helpers", () => {
    const owner = "extensions/file-transfer/src/tools/dir-fetch-tool.ts";
    const source =
      'import { sha256File as hash } from "@openclaw/fs-safe/durability";\n' +
      'import { walkDirectory as walk } from "@openclaw/fs-safe/walk";';
    expect(hasDisallowedFsSafeImport(owner, source)).toBe(false);
    expect(hasDisallowedFsSafeImport(`${owner}.other.ts`, source)).toBe(true);
    expect(
      hasDisallowedFsSafeImport(
        owner,
        'import { sha256File, publishFileExclusive } from "@openclaw/fs-safe/durability";',
      ),
    ).toBe(true);
    expect(
      hasDisallowedFsSafeImport(owner, `${source}\nimport { root } from "@openclaw/fs-safe/root";`),
    ).toBe(true);
  });

  it("limits File Transfer's descriptor overwrite helper", () => {
    const owner = "extensions/file-transfer/src/node-host/file-write.ts";
    const source = 'import { overwriteFileHandle as operation } from "@openclaw/fs-safe/advanced";';
    expect(hasDisallowedFsSafeImport(owner, source)).toBe(false);
    expect(hasDisallowedFsSafeImport(`${owner}.other.ts`, source)).toBe(true);
    expect(
      hasDisallowedFsSafeImport(
        owner,
        'import { overwriteFileHandle, root } from "@openclaw/fs-safe/advanced";',
      ),
    ).toBe(true);
    expect(
      hasDisallowedFsSafeImport(owner, `${source}\nimport { root } from "@openclaw/fs-safe/root";`),
    ).toBe(true);
  });

  it.each([
    [
      "move and receipt",
      'import { movePathWithCopyFallback, type MovePathPublicationReceipt } from "@openclaw/fs-safe/atomic";',
      false,
    ],
    [
      "move alias",
      'import { movePathWithCopyFallback as move } from "@openclaw/fs-safe/atomic";',
      false,
    ],
    [
      "receipt alias",
      'import type { MovePathPublicationReceipt as Receipt } from "@openclaw/fs-safe/atomic";',
      false,
    ],
    [
      "receipt value",
      'import { MovePathPublicationReceipt } from "@openclaw/fs-safe/atomic";',
      true,
    ],
    ["other atomic helper", 'import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";', true],
    [
      "misleading alias",
      'import { replaceFileAtomic as movePathWithCopyFallback } from "@openclaw/fs-safe/atomic";',
      true,
    ],
    [
      "mixed imports",
      'import { movePathWithCopyFallback, replaceFileAtomic } from "@openclaw/fs-safe/atomic";',
      true,
    ],
    ["namespace", 'import * as atomic from "@openclaw/fs-safe/atomic";', true],
    ["default", 'import atomic from "@openclaw/fs-safe/atomic";', true],
    ["side effect", 'import "@openclaw/fs-safe/atomic";', true],
    ["empty import", 'import {} from "@openclaw/fs-safe/atomic";', true],
    ["re-export", 'export { movePathWithCopyFallback } from "@openclaw/fs-safe/atomic";', true],
    ["quoted dynamic import", 'const atomic = await import("@openclaw/fs-safe/atomic");', true],
    ["require", 'const atomic = require("@openclaw/fs-safe/atomic");', true],
    ["other subpath", 'import { root } from "@openclaw/fs-safe/root";', true],
  ] as const)("limits the OpenShell exception: %s", (_label, source, expected) => {
    expect(hasDisallowedFsSafeImport("extensions/openshell/src/backend.ts", source)).toBe(expected);
  });

  it.each([
    ["extensions/openshell/src/elsewhere.ts", true],
    ["extensions/example/src/backend.ts", true],
    ["src/agents/workspace-bootstrap-publish.ts", false],
  ] as const)("preserves the file boundary for %s", (filePath, expected) => {
    expect(
      hasDisallowedFsSafeImport(
        filePath,
        'import { movePathWithCopyFallback } from "@openclaw/fs-safe/atomic";',
      ),
    ).toBe(expected);
  });

  it("still rejects another direct import beside the allowed move", () => {
    expect(
      hasDisallowedFsSafeImport(
        "extensions/openshell/src/backend.ts",
        'import { movePathWithCopyFallback } from "@openclaw/fs-safe/atomic";\n' +
          'import { root } from "@openclaw/fs-safe/root";',
      ),
    ).toBe(true);
  });

  it("lists source files without scanning boundary roots in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const files = listSourceFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files.every(isSourceFile)).toBe(true);
    });
  });

  it("keeps plugin filesystem imports within their reviewed dependency surface", () => {
    const violations = listSourceFiles()
      .map((filePath) => toRepoRelativePath(REPO_ROOT, filePath))
      .filter((filePath) =>
        hasDisallowedFsSafeImport(
          filePath,
          fs.readFileSync(path.join(REPO_ROOT, filePath), "utf8"),
        ),
      );

    expect(violations).toStrictEqual([]);
  });
});
