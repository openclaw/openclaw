import { gatewayProbeModuleLoaders } from "../daemon-cli/probe.js";

/** Minimal shape of a lazy module loader this preload can warm. */
export type PreloadableModuleLoader = {
  load: () => Promise<unknown>;
};

/**
 * Lazy modules the post-swap restart and verification path evaluates.
 *
 * A package update stages the new version and swaps it over the live install
 * root, then restarts and verifies the gateway from the *previous* build that
 * is still running. The bundled dist splits into content-hashed chunks, so any
 * `import()` reached for the first time after the swap resolves to a chunk name
 * that only the replaced tree contained and fails with ENOENT. Warming these
 * loaders before the swap makes those calls resolve from memory instead.
 */
export const gatewayRestartModuleLoaders: readonly PreloadableModuleLoader[] = [
  ...gatewayProbeModuleLoaders,
];

/**
 * Warms the restart path's lazy modules. Best effort by design: this runs
 * before the install swap, so a module that cannot be warmed must not abort an
 * update that is otherwise fine -- it only forfeits this protection.
 */
export async function preloadGatewayRestartModules(
  loaders: readonly PreloadableModuleLoader[] = gatewayRestartModuleLoaders,
): Promise<void> {
  await Promise.all(
    loaders.map(async (loader) => {
      try {
        await loader.load();
      } catch {
        // Warming is opportunistic; the real load reports its own failure.
      }
    }),
  );
}
