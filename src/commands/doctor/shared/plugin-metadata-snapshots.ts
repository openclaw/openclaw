import { listAgentWorkspaceDirs } from "../../../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../../../plugins/plugin-metadata-snapshot.js";

type DoctorPluginMetadataSnapshot = {
  workspaceDir?: string;
  metadata: PluginMetadataSnapshot;
};

/** Loads Doctor metadata from every agent workspace before destructive stale-state repair. */
export function resolveDoctorPluginMetadataSnapshots(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): DoctorPluginMetadataSnapshot[] {
  const workspaceDirs = listAgentWorkspaceDirs(config, env);
  const scopes: Array<string | undefined> = workspaceDirs.length > 0 ? workspaceDirs : [undefined];
  return scopes.map((workspaceDir) => {
    const metadata = resolvePluginMetadataSnapshot({
      config,
      env,
      ...(workspaceDir ? { workspaceDir } : {}),
      allowWorkspaceScopedCurrent: true,
    });
    return workspaceDir ? { workspaceDir, metadata } : { metadata };
  });
}
