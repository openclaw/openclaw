import bundledRuntimeSidecarPaths from "../../scripts/lib/bundled-runtime-sidecar-paths.json" with { type: "json" };

// Keep this JSON as the root package's runtime sidecar inventory only. Official
// plugin packages that are excluded from root package files must ship their
// sidecars from their own npm package-local dist directory instead.
export const BUNDLED_RUNTIME_SIDECAR_PATHS: readonly string[] = bundledRuntimeSidecarPaths;
