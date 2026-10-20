import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkspacePackageAliasEntry } from "./plugin-cache-sdk.js";

// Jiti-loaded plugin code runs outside the Vitest/tsgo resolver, so every
// workspace package import reachable from plugin SDK barrels needs an explicit
// source/dist alias here to keep source checkouts and packaged builds aligned.
// Packaged installs omit workspace manifests; preserve the exact curated subpaths
// instead of expanding aliases from package exports.
const WORKSPACE_PACKAGE_ALIAS_SUBPATHS = [
  ["gateway-client", ["", "readiness", "timeouts", "websocket-data"]],
  [
    "gateway-protocol",
    [
      "",
      "client-info",
      "connect-error-details",
      "frame-guards",
      "gateway-error-details",
      "restart-unavailable",
      "schema",
      "startup-unavailable",
      "version",
    ],
  ],
  [
    "markdown-core",
    [
      "",
      "code-spans",
      "fences",
      "frontmatter",
      "ir",
      "render",
      "render-aware-chunking",
      "tables",
      "types",
    ],
  ],
  ["media-generation-core", ["", "capability-model-ref", "catalog", "model-ref", "normalization"]],
  ["retry", [""]],
  ["worker-runtime", ["", "worker", "lifecycle"]],
  [
    "terminal-core",
    [
      "",
      "ansi",
      "decorative-emoji",
      "health-style",
      "links",
      "note",
      "osc-progress",
      "palette",
      "progress-line",
      "prompt-select-styled",
      "prompt-select-styled-params",
      "prompt-style",
      "restore",
      "safe-text",
      "stream-writer",
      "table",
      "terminal-link",
      "theme",
    ],
  ],
  ["net-policy", ["", "ip", "ipv4", "redact-sensitive-url", "url-protocol", "url-userinfo"]],
  [
    "model-catalog-core",
    [
      "",
      "configured-model-refs",
      "model-catalog-refs",
      "model-catalog-normalize",
      "model-catalog-pricing",
      "model-catalog-types",
      "provider-id",
      "provider-model-id-normalization",
      "provider-model-id-normalize",
    ],
  ],
] as const;

export const WORKSPACE_PACKAGE_ALIAS_ENTRIES: WorkspacePackageAliasEntry[] =
  WORKSPACE_PACKAGE_ALIAS_SUBPATHS.flatMap(([packageDir, subpaths]) =>
    subpaths.map((subpath): WorkspacePackageAliasEntry => ({
      packageName: `@openclaw/${packageDir}`,
      packageDir,
      subpath,
      srcFile: `${subpath || "index"}.ts`,
      distFile: `${subpath || "index"}.mjs`,
    })),
  );
export const WORKSPACE_PACKAGE_EXPORT_DIRS = [
  "media-core",
  "normalization-core",
  "acp-core",
  "llm-core",
];
export const WORKSPACE_PACKAGE_ALIAS_NAMES = new Set([
  ...WORKSPACE_PACKAGE_ALIAS_SUBPATHS.map(([name]) => `@openclaw/${name}`),
  ...WORKSPACE_PACKAGE_EXPORT_DIRS.map((name) => `@openclaw/${name}`),
]);
const ROOT_PACKAGED_WORKSPACE_PACKAGE_DIRS = new Set([
  "acp-core",
  "media-core",
  "normalization-core",
  "retry",
  "terminal-core",
  "worker-runtime",
]);

export function workspacePackageExportAliasEntries(params: {
  packageName: string;
  packageDir: string;
  exports: unknown;
}): WorkspacePackageAliasEntry[] {
  const entries: WorkspacePackageAliasEntry[] = [];
  for (const [exportKey, value] of Object.entries(isRecord(params.exports) ? params.exports : {})) {
    const subpath = exportKey === "." ? "" : exportKey.startsWith("./") ? exportKey.slice(2) : null;
    if (subpath === null || (exportKey !== "." && !subpath) || subpath.includes("..")) {
      continue;
    }
    const importPath =
      typeof value === "string"
        ? value
        : isRecord(value)
          ? typeof value.import === "string"
            ? value.import
            : typeof value.default === "string"
              ? value.default
              : null
          : null;
    if (!importPath?.startsWith("./dist/") || !importPath.endsWith(".mjs")) {
      continue;
    }
    const distFile = importPath.slice("./dist/".length);
    entries.push({
      packageName: params.packageName,
      packageDir: params.packageDir,
      subpath,
      srcFile: distFile.replace(/\.mjs$/u, ".ts"),
      distFile,
    });
  }
  return entries.toSorted((a, b) => a.subpath.localeCompare(b.subpath));
}

export function workspacePackageAliasCandidates(
  entry: WorkspacePackageAliasEntry,
  kind: "dist" | "src",
): string[] {
  return kind === "dist"
    ? [
        ...(ROOT_PACKAGED_WORKSPACE_PACKAGE_DIRS.has(entry.packageDir)
          ? [path.join("dist", entry.packageDir, entry.distFile.replace(/\.mjs$/u, ".js"))]
          : []),
        path.join("packages", entry.packageDir, "dist", entry.distFile),
      ]
    : [path.join("packages", entry.packageDir, "src", entry.srcFile)];
}
