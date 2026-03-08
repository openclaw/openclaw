import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";

export type SreStatePaths = {
  stateRootDir: string;
  graphDir: string;
  dossiersDir: string;
  indexDir: string;
  plansDir: string;
};

function resolveDirOverride(envValue: string | undefined, fallback: string): string {
  const trimmed = envValue?.trim();
  return trimmed ? path.resolve(trimmed) : fallback;
}

export function resolveSreStatePaths(env: NodeJS.ProcessEnv = process.env): SreStatePaths {
  const openclawStateDir = resolveStateDir(env);
  const stateRootDir = path.join(openclawStateDir, "state");

  return {
    stateRootDir,
    graphDir: resolveDirOverride(env.OPENCLAW_SRE_GRAPH_DIR, path.join(stateRootDir, "sre-graph")),
    dossiersDir: resolveDirOverride(
      env.OPENCLAW_SRE_DOSSIERS_DIR,
      path.join(stateRootDir, "sre-dossiers"),
    ),
    indexDir: resolveDirOverride(env.OPENCLAW_SRE_INDEX_DIR, path.join(stateRootDir, "sre-index")),
    plansDir: resolveDirOverride(env.OPENCLAW_SRE_PLANS_DIR, path.join(stateRootDir, "sre-plans")),
  };
}

export function listSreStateDirs(paths: SreStatePaths = resolveSreStatePaths()): string[] {
  return [paths.graphDir, paths.dossiersDir, paths.indexDir, paths.plansDir];
}
