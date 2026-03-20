import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

const LOCAL_IMPORT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
] as const;

const NODE_BUILTIN_SPECIFIERS = new Set([
  ...builtinModules,
  ...builtinModules.filter((entry) => !entry.startsWith("node:")).map((entry) => `node:${entry}`),
]);

type ImportKind = "import" | "export" | "dynamic-import" | "require" | "require-resolve";

type ModuleSpecifierUse = {
  specifier: string;
  kind: ImportKind;
  line: number;
};

export type PluginImportPolicyViolation = {
  file: string;
  line: number;
  kind: ImportKind;
  specifier: string;
  reason: string;
};

export type PluginImportPolicyResult =
  | { ok: true }
  | { ok: false; violations: PluginImportPolicyViolation[] };

type PluginImportPolicyParams = {
  entryPath: string;
  rootDir: string;
};

type PluginPackageManifest = {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function toPosixPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function isPathInside(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRuntimeOverlayForwardImport(params: {
  rootDir: string;
  importerPath: string;
  specifier: string;
}): boolean {
  const normalizedRoot = toPosixPath(params.rootDir);
  if (!normalizedRoot.includes("/dist-runtime/extensions/")) {
    return false;
  }
  if (!isPathInside(params.rootDir, params.importerPath)) {
    return false;
  }
  return params.specifier.startsWith("../../../dist/");
}

function resolveRuntimeOverlayCanonicalDistRoot(rootDir: string): string | null {
  const normalizedRoot = toPosixPath(rootDir);
  const marker = "/dist-runtime/extensions/";
  const markerIndex = normalizedRoot.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const pluginId = normalizedRoot.slice(markerIndex + marker.length).split("/")[0];
  if (!pluginId) {
    return null;
  }

  const packageRoot = normalizedRoot.slice(0, markerIndex);
  const canonicalRoot = path.join(packageRoot, "dist");
  try {
    return fs.realpathSync(canonicalRoot);
  } catch {
    // ignore
  }
  return null;
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:");
}

function resolveBarePackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  const [name] = specifier.split("/");
  return name ?? specifier;
}

function readPluginPackageManifest(rootDir: string): PluginPackageManifest | null {
  const packageJsonPath = path.join(rootDir, "package.json");
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PluginPackageManifest;
  } catch {
    return null;
  }
}

function collectAllowedBarePackages(rootDir: string): {
  packageName?: string;
  allowedPackages: Set<string>;
} {
  const manifest = readPluginPackageManifest(rootDir);
  const allowedPackages = new Set<string>();
  if (!manifest) {
    return { allowedPackages };
  }

  for (const dependencySet of [
    manifest.dependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ]) {
    for (const packageName of Object.keys(dependencySet ?? {})) {
      if (packageName.trim()) {
        allowedPackages.add(packageName.trim());
      }
    }
  }

  const packageName = manifest.name?.trim();
  return {
    ...(packageName ? { packageName } : {}),
    allowedPackages,
  };
}

function stripCommentsPreserveLength(source: string): string {
  let output = "";
  let index = 0;
  let state:
    | "code"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote"
    | "template" = "code";

  while (index < source.length) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (state === "line-comment") {
      if (current === "\n") {
        output += "\n";
        state = "code";
      } else {
        output += " ";
      }
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        output += "  ";
        index += 2;
        state = "code";
        continue;
      }
      output += current === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    if (state === "single-quote" || state === "double-quote" || state === "template") {
      output += current;
      if (current === "\\") {
        output += next;
        index += 2;
        continue;
      }
      if (
        (state === "single-quote" && current === "'") ||
        (state === "double-quote" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        state = "code";
      }
      index += 1;
      continue;
    }

    if (current === "/" && next === "/") {
      output += "  ";
      index += 2;
      state = "line-comment";
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      state = "block-comment";
      continue;
    }
    if (current === "'") {
      output += current;
      index += 1;
      state = "single-quote";
      continue;
    }
    if (current === '"') {
      output += current;
      index += 1;
      state = "double-quote";
      continue;
    }
    if (current === "`") {
      output += current;
      index += 1;
      state = "template";
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
}

function lineNumberForIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function collectModuleSpecifierUses(source: string): ModuleSpecifierUse[] {
  const stripped = stripCommentsPreserveLength(source);
  const uses: ModuleSpecifierUse[] = [];
  const patterns: Array<{ kind: ImportKind; regex: RegExp }> = [
    {
      kind: "import",
      regex: /(?:^|[^\w$.])import\s+(?:[\w*\s{},]+\s+from\s*)?["']([^"'`\n\r]+)["']/gm,
    },
    {
      kind: "export",
      regex: /(?:^|[^\w$.])export\s+(?:[\w*\s{},]+\s+from\s*)["']([^"'`\n\r]+)["']/gm,
    },
    {
      kind: "dynamic-import",
      regex: /(?:^|[^\w$.])import\s*\(\s*["']([^"'`\n\r]+)["']\s*\)/gm,
    },
    {
      kind: "require",
      regex: /(?:^|[^\w$.])require\s*\(\s*["']([^"'`\n\r]+)["']\s*\)/gm,
    },
    {
      kind: "require-resolve",
      regex: /(?:^|[^\w$.])require\.resolve\s*\(\s*["']([^"'`\n\r]+)["']\s*\)/gm,
    },
  ];

  for (const { kind, regex } of patterns) {
    regex.lastIndex = 0;
    for (const match of stripped.matchAll(regex)) {
      const specifier = match[1]?.trim();
      const index = match.index ?? 0;
      if (!specifier) {
        continue;
      }
      uses.push({
        kind,
        specifier,
        line: lineNumberForIndex(stripped, index),
      });
    }
  }

  return uses.toSorted(
    (left, right) => left.line - right.line || left.specifier.localeCompare(right.specifier),
  );
}

function expandLocalSpecifierCandidates(resolvedBase: string): string[] {
  const candidates = [resolvedBase];

  const explicitExt = path.extname(resolvedBase);
  if (explicitExt) {
    const withoutExt = resolvedBase.slice(0, -explicitExt.length);
    for (const extension of LOCAL_IMPORT_EXTENSIONS) {
      candidates.push(`${withoutExt}${extension}`);
    }
  } else {
    for (const extension of LOCAL_IMPORT_EXTENSIONS) {
      candidates.push(`${resolvedBase}${extension}`);
    }
  }

  candidates.push(path.join(resolvedBase, "index.js"));
  candidates.push(path.join(resolvedBase, "index.mjs"));
  candidates.push(path.join(resolvedBase, "index.cjs"));
  candidates.push(path.join(resolvedBase, "index.ts"));
  candidates.push(path.join(resolvedBase, "index.tsx"));
  candidates.push(path.join(resolvedBase, "index.mts"));
  candidates.push(path.join(resolvedBase, "index.cts"));

  return Array.from(new Set(candidates));
}

function resolveLocalModulePath(importerPath: string, specifier: string): string | null {
  const resolvedBase = specifier.startsWith("file:")
    ? new URL(specifier)
    : path.resolve(path.dirname(importerPath), specifier);
  const resolvedPath =
    resolvedBase instanceof URL ? path.normalize(resolvedBase.pathname) : resolvedBase;

  for (const candidate of expandLocalSpecifierCandidates(resolvedPath)) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return fs.realpathSync(candidate);
      }
    } catch {
      // continue
    }
  }

  return null;
}

function validateBareSpecifier(params: {
  specifier: string;
  packageName?: string;
  allowedPackages: Set<string>;
}): string | null {
  if (
    params.specifier === "openclaw/plugin-sdk" ||
    params.specifier.startsWith("openclaw/plugin-sdk/")
  ) {
    return null;
  }

  if (NODE_BUILTIN_SPECIFIERS.has(params.specifier)) {
    return null;
  }

  const barePackage = resolveBarePackageName(params.specifier);
  if (params.packageName && barePackage === params.packageName) {
    return null;
  }

  if (params.allowedPackages.has(barePackage)) {
    return null;
  }

  if (params.specifier === "openclaw" || params.specifier.startsWith("openclaw/")) {
    return "imports private OpenClaw package path; use openclaw/plugin-sdk/*";
  }

  return "imports undeclared bare package";
}

function classifyLocalSpecifierViolation(params: {
  importerPath: string;
  specifier: string;
  resolvedPath: string | null;
  rootDir: string;
  canonicalDistRoot: string | null;
}): string | null {
  if (
    isRuntimeOverlayForwardImport({
      rootDir: params.rootDir,
      importerPath: params.importerPath,
      specifier: params.specifier,
    })
  ) {
    return null;
  }

  const rawResolved = params.specifier.startsWith("file:")
    ? path.normalize(new URL(params.specifier).pathname)
    : path.resolve(path.dirname(params.importerPath), params.specifier);
  const effectiveResolved = params.resolvedPath ?? rawResolved;

  const insidePrimaryRoot = isPathInside(params.rootDir, effectiveResolved);
  const insideCanonicalRoot =
    params.canonicalDistRoot !== null && isPathInside(params.canonicalDistRoot, effectiveResolved);
  if (!insidePrimaryRoot && !insideCanonicalRoot) {
    return "imports path outside the plugin root";
  }

  if (!params.resolvedPath) {
    return "imports local path that could not be resolved inside the plugin root";
  }

  return null;
}

function validateFile(params: {
  filePath: string;
  rootDir: string;
  canonicalDistRoot: string | null;
  packageName?: string;
  allowedPackages: Set<string>;
  visited: Set<string>;
  violations: PluginImportPolicyViolation[];
}) {
  if (params.visited.has(params.filePath)) {
    return;
  }
  params.visited.add(params.filePath);

  let source = "";
  try {
    source = fs.readFileSync(params.filePath, "utf8");
  } catch {
    return;
  }

  for (const use of collectModuleSpecifierUses(source)) {
    if (isBareSpecifier(use.specifier)) {
      const reason = validateBareSpecifier({
        specifier: use.specifier,
        packageName: params.packageName,
        allowedPackages: params.allowedPackages,
      });
      if (reason) {
        params.violations.push({
          file: toPosixPath(params.filePath),
          line: use.line,
          kind: use.kind,
          specifier: use.specifier,
          reason,
        });
      }
      continue;
    }

    const resolvedPath = resolveLocalModulePath(params.filePath, use.specifier);
    const reason = classifyLocalSpecifierViolation({
      importerPath: params.filePath,
      specifier: use.specifier,
      resolvedPath,
      rootDir: params.rootDir,
      canonicalDistRoot: params.canonicalDistRoot,
    });
    if (reason) {
      params.violations.push({
        file: toPosixPath(params.filePath),
        line: use.line,
        kind: use.kind,
        specifier: use.specifier,
        reason,
      });
      continue;
    }
    if (resolvedPath) {
      const shouldSkipCanonicalTraversal =
        params.canonicalDistRoot !== null &&
        isPathInside(params.canonicalDistRoot, resolvedPath) &&
        !isPathInside(params.rootDir, params.filePath);
      if (shouldSkipCanonicalTraversal) {
        continue;
      }
      validateFile({
        filePath: resolvedPath,
        rootDir: params.rootDir,
        canonicalDistRoot: params.canonicalDistRoot,
        packageName: params.packageName,
        allowedPackages: params.allowedPackages,
        visited: params.visited,
        violations: params.violations,
      });
    }
  }
}

export function validatePluginImportPolicy(
  params: PluginImportPolicyParams,
): PluginImportPolicyResult {
  const rootDir = fs.realpathSync(params.rootDir);
  const entryPath = fs.realpathSync(params.entryPath);
  const canonicalDistRoot = resolveRuntimeOverlayCanonicalDistRoot(rootDir);
  const { packageName, allowedPackages } = collectAllowedBarePackages(rootDir);
  const visited = new Set<string>();
  const violations: PluginImportPolicyViolation[] = [];

  validateFile({
    filePath: entryPath,
    rootDir,
    canonicalDistRoot,
    packageName,
    allowedPackages,
    visited,
    violations,
  });

  if (violations.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    violations: violations.toSorted(
      (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
    ),
  };
}
