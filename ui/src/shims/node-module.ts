/**
 * Browser-safe stub for "node:module".
 * createRequire is not available in browser environments; callers (e.g. src/version.ts)
 * already guard against this with a try/catch and fall back to injected build constants.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const createRequire: ((url: string) => any) | undefined = undefined;
