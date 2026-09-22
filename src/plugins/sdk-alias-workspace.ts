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
export const ROOT_PACKAGED_WORKSPACE_PACKAGE_DIRS = new Set([
  "acp-core",
  "media-core",
  "normalization-core",
  "retry",
  "terminal-core",
]);
