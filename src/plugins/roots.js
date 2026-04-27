import path from "node:path";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
export function resolvePluginSourceRoots(params) {
    const env = params.env ?? process.env;
    const workspaceRoot = params.workspaceDir ? resolveUserPath(params.workspaceDir, env) : undefined;
    const stock = resolveBundledPluginsDir(env);
    const global = path.join(resolveConfigDir(env), "extensions");
    const workspace = workspaceRoot ? path.join(workspaceRoot, ".openclaw", "extensions") : undefined;
    return { stock, global, workspace };
}
// Shared env-aware cache inputs for discovery, manifest, and loader caches.
export function resolvePluginCacheInputs(params) {
    const env = params.env ?? process.env;
    const roots = resolvePluginSourceRoots({
        workspaceDir: params.workspaceDir,
        env,
    });
    // Preserve caller order because load-path precedence follows input order.
    const loadPaths = (params.loadPaths ?? [])
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => resolveUserPath(entry, env));
    return { roots, loadPaths };
}
