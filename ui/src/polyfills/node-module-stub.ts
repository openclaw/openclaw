// Polyfill stub for node:module in browser environments.
// This file provides createRequire as a stub that throws on use,
// since version resolution is not needed in browser builds.
// The throw is caught by version.ts's inner try/catch silently.

export function createRequire(_moduleUrl: string) {
  // In browser environments, return a require function that always throws.
  // The throw is caught by version.ts's inner try/catch in readVersionFromJsonCandidates.
  return (_spec: string) => {
    throw new Error(
      `Cannot require "${_spec}" in browser environment. ` +
        `This module should not be loaded in browser builds.`,
    );
  };
}
