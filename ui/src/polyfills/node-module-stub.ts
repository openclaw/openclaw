// Polyfill stub for node:module in browser environments.
// This file provides createRequire as a stub that returns null for version lookups,
// since version resolution is not needed in browser builds.

export function createRequire(_moduleUrl: string) {
  // In browser environments, return a require function that always fails.
  // The version.ts code already handles null returns gracefully.
  return (_spec: string) => {
    throw new Error(
      `Cannot require "${_spec}" in browser environment. ` +
        `This module should not be loaded in browser builds.`,
    );
  };
}
