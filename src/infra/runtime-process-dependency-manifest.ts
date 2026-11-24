/** Dependency programs retain their installed package topology and disk runtime. */
export const runtimeProcessDependencyEntrypoints = {
  npm: {
    specifier: "npm/bin/npm-cli.js",
    packageJsonSpecifier: "npm/package.json",
    relativePath: "bin/npm-cli.js",
    execution: "external-disk",
    kind: "standalone-package-manager",
  },
  npx: {
    specifier: "npm/bin/npx-cli.js",
    packageJsonSpecifier: "npm/package.json",
    relativePath: "bin/npx-cli.js",
    execution: "external-disk",
    kind: "standalone-package-manager",
  },
  chromeDevtoolsMcp: {
    specifier: "chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    execution: "external-disk",
    kind: "package",
  },
  matrixCryptoDownload: {
    specifier: "@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js",
    execution: "external-disk",
    kind: "package",
  },
} as const;
