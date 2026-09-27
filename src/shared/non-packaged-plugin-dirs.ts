/** Bundled plugins available to source builds but excluded from node and npm distributions. */
export const NON_PACKAGED_BUNDLED_PLUGIN_DIRS: ReadonlySet<string> = new Set([
  "qa-channel",
  "qa-lab",
]);
