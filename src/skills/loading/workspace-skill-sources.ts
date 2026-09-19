import path from "node:path";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { isDefaultStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { resolvePluginSkillRoots, resolvePluginSkillRootsFromMetadata } from "./plugin-skills.js";
import { resolvePluginSkillsDir, resolveSkillsUserHomeDir } from "./skill-paths.js";
import { resolveWorkspaceSkillDirectories } from "./workspace-skill-roots.js";
import type {
  WorkspaceSkillSourcePlan,
  WorkspaceSkillSource,
} from "./workspace-skill-sources.types.js";

export type {
  WorkspaceSkillSources,
  WorkspaceSkillSourceRequest,
  WorkspaceSkillSourcePlan,
} from "./workspace-skill-sources.types.js";

/** Gateway-installed sources stay local; only workspace-owned files cross the boundary. */
export function splitSkillSourcePlan(plan: WorkspaceSkillSourcePlan) {
  const isWorkspaceOwned = (root: WorkspaceSkillSource) =>
    root.tier === "workspace" ||
    ((root.tier === "managed" || root.tier === "extra") &&
      !plan.pluginSkillRoots.some((plugin) => plugin.dir === root.dir) &&
      isPathInside(plan.workspaceDir, root.dir));
  const roots = plan.roots.map((root, order) => ({ ...root, order }));
  const gatewayRoots = roots.filter((root) => !isWorkspaceOwned(root));
  const workspaceRoots = roots.filter(isWorkspaceOwned);
  return {
    gatewayRoots,
    gatewayPlan: { ...plan, roots: gatewayRoots },
    workspacePlan: {
      ...plan,
      roots: workspaceRoots,
      // Generated plugin links and installation metadata belong to Gateway.
      pluginSkillRoots: [],
      pluginSkillsDir: undefined,
      bundledSkillsDir: undefined,
      stateDir: undefined,
      userHomeDir: undefined,
      managedSkillsDir:
        workspaceRoots.find((root) => root.tier === "managed")?.dir ??
        path.join(plan.workspaceDir, "skills"),
    },
  };
}

export function resolveCustodianSkillAgentId(
  config?: OpenClawConfig,
  agentId?: string,
  workspaceOnly = false,
) {
  const owner = config ? tryResolveAmbientOwnerAgentId(config) : undefined;
  return !workspaceOnly && agentId && owner && normalizeAgentId(agentId) === owner
    ? owner
    : undefined;
}

/** Source selection and precedence are shared by local discovery and provisioned remote discovery. */
export function resolveWorkspaceSkillSourcePlan(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    agentId?: string;
    workspaceOnly?: boolean;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    pluginSkillsDir?: string;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
  },
): WorkspaceSkillSourcePlan {
  const workspaceOnly = opts?.workspaceOnly === true;
  const userHomeDir = resolveSkillsUserHomeDir();
  const pluginSkillsDir = opts?.pluginSkillsDir ?? resolvePluginSkillsDir();
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const bundledSkillsDir = workspaceOnly
    ? undefined
    : (opts?.bundledSkillsDir ?? resolveBundledSkillsDir());
  const pluginParams = { workspaceDir, config: opts?.config, pluginSkillsDir };
  const pluginSkillRoots = workspaceOnly
    ? []
    : opts?.pluginMetadataSnapshot
      ? resolvePluginSkillRootsFromMetadata({
          ...pluginParams,
          metadataSnapshot: opts.pluginMetadataSnapshot,
        })
      : resolvePluginSkillRoots(pluginParams);
  const roots: WorkspaceSkillSource[] = [];
  if (!workspaceOnly) {
    roots.push(
      ...normalizeTrimmedStringList(opts?.config?.skills?.load?.extraDirs ?? []).map((dir) => ({
        dir: resolveUserPath(dir),
        source: "openclaw-extra",
        tier: "extra" as const,
      })),
    );
    roots.push(
      ...pluginSkillRoots.map((root) => ({
        ...root,
        source: "openclaw-extra",
        tier: "extra" as const,
      })),
    );
    if (bundledSkillsDir) {
      roots.push({ dir: bundledSkillsDir, source: "openclaw-bundled", tier: "bundled" });
      if (resolveCustodianSkillAgentId(opts?.config, opts?.agentId)) {
        roots.push({
          dir: path.join(path.dirname(bundledSkillsDir), "custodian-skills"),
          source: "openclaw-custodian",
          tier: "bundled",
        });
      }
    }
    if (opts?.config && opts.agentId) {
      roots.push({
        dir: resolveWorkshopSkillsDir(opts.config, opts.agentId),
        source: "openclaw-workshop",
        tier: "workshop",
      });
    }
    roots.push({ dir: managedSkillsDir, source: "openclaw-managed", tier: "managed" });
    if (isDefaultStateDir()) {
      roots.push({
        dir: path.resolve(userHomeDir ?? ".", ".agents", "skills"),
        source: "agents-skills-personal",
        tier: "personal",
      });
    }
  }
  roots.push(
    ...resolveWorkspaceSkillDirectories(workspaceDir, workspaceOnly).map(({ dir, source }) => ({
      dir,
      source,
      tier: "workspace" as const,
    })),
  );
  return {
    roots,
    allowSymlinkTargets: normalizeTrimmedStringList(
      opts?.config?.skills?.load?.allowSymlinkTargets ?? [],
    ).map((dir) => resolveUserPath(dir)),
    pluginSkillsDir,
    pluginSkillRoots,
    managedSkillsDir,
    bundledSkillsDir,
    stateDir: CONFIG_DIR,
    userHomeDir,
    workspaceDir,
  };
}
