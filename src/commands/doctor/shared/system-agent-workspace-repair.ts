// Doctor repair that records one workspace for a system agent whose turns resolve two.
import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds } from "../../../agents/agent-roster.js";
import {
  resolveAgentEntry,
  resolveAgentWorkspaceDir,
  tryResolveConfiguredAgentWorkspaceDir,
  tryResolveLegacyCompatibilityAgentId,
} from "../../../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace-default-path.js";
import {
  DEFAULT_MEMORY_FILENAME,
  GENERATED_WORKSPACE_BOOTSTRAP_FILENAMES,
  fileDiffersFromTemplate,
} from "../../../agents/workspace.js";
import { containsEnvVarReference, resolveConfigEnvVars } from "../../../config/env-substitution.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasErrnoCode, ignoreMissingPath } from "../../../infra/errno.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { lstatIfExists } from "../../../infra/path-existence.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { shortenHomePath } from "../../../utils.js";
import type { DoctorConfigMutationResult } from "./config-mutation-state.js";

// Copies a system agent's files from the shared root into its own workspace before Doctor pins it.
type WorkspaceRestorePlan = {
  /** Relative paths copied from the root; seeded template files in the target are replaced. */
  copies: string[];
  /** Relative paths of symbolic links recreated in the target, pointing where the root's do. */
  links: string[];
  /** Relative paths customized differently in both directories; the target keeps its own. */
  conflicts: string[];
};

const TEMPLATED_FILES: ReadonlySet<string> = new Set(GENERATED_WORKSPACE_BOOTSTRAP_FILENAMES);
const RESTORED_DIRS = ["memory", "skills"] as const;

async function planFile(from: string, to: string, rel: string, plan: WorkspaceRestorePlan) {
  const templated = TEMPLATED_FILES.has(rel);
  const source = await fs.readFile(path.join(from, rel)).catch(ignoreMissingPath);
  if (!source || (templated && !(await fileDiffersFromTemplate(from, rel)))) {
    return;
  }
  const targetPath = path.join(to, rel);
  // A linked file in the target is kept: copying over it would write to the link's destination.
  if ((await lstatIfExists(targetPath, "ENOENT"))?.isSymbolicLink()) {
    plan.conflicts.push(rel);
    return;
  }
  const target = await fs.readFile(targetPath).catch(ignoreMissingPath);
  if (!target || (templated && !(await fileDiffersFromTemplate(to, rel)))) {
    plan.copies.push(rel);
  } else if (!target.equals(source)) {
    plan.conflicts.push(rel);
  }
}

async function linkTarget(dir: string, rel: string): Promise<string | undefined> {
  const link = path.join(dir, rel);
  try {
    return path.resolve(path.dirname(link), await fs.readlink(link));
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "EINVAL")) {
      return undefined;
    }
    throw error;
  }
}

async function planTree(from: string, to: string, rel: string, plan: WorkspaceRestorePlan) {
  let entries;
  try {
    entries = await fs.readdir(path.join(from, rel), { withFileTypes: true });
  } catch (error) {
    ignoreMissingPath(error);
    return;
  }
  // A linked or non-directory target is kept whole: descending would write through it.
  const target = await lstatIfExists(path.join(to, rel), "ENOENT");
  if (target && !target.isDirectory()) {
    plan.conflicts.push(rel);
    return;
  }
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      await planTree(from, to, child, plan);
    } else if (entry.isFile()) {
      await planFile(from, to, child, plan);
    } else if (entry.isSymbolicLink()) {
      const source = await linkTarget(from, child);
      if ((await lstatIfExists(path.join(to, child), "ENOENT")) === undefined) {
        plan.links.push(child);
      } else if (source !== (await linkTarget(to, child))) {
        plan.conflicts.push(child);
      }
    }
  }
}

function describeRestore(params: {
  plan: WorkspaceRestorePlan;
  applied: boolean;
  from: string;
  to: string;
}): string[] {
  const from = shortenHomePath(params.from);
  const to = shortenHomePath(params.to);
  const lines: string[] = [];
  const copied = [...params.plan.copies, ...params.plan.links];
  if (copied.length > 0) {
    lines.push(
      `${params.applied ? "Copied" : "Copy"} ${copied.join(", ")} from ${from} into ${to}; the files in ${from} stay in place.`,
    );
  }
  if (params.plan.conflicts.length > 0) {
    lines.push(
      `Kept ${params.plan.conflicts.join(", ")} in ${to}; the different copies in ${from} stay in place.`,
    );
  }
  return lines;
}

/**
 * An unpinned system agent in an explicit roster resolves its persona, bootstrap, and memory files
 * to its own directory, while its files may sit in the launch workspace. Doctor pins one of the two
 * after copying the agent's files into it. With `agents.defaults.workspace` set, the Gateway already
 * runs the agent in its own directory and the root holds sibling workspaces, so that directory is
 * pinned. Without it, the Gateway runs the agent in the launch workspace, which is pinned so the
 * working directory does not move; when another agent owns that workspace, Doctor only warns. No file is moved or deleted and a customized file in the pinned
 * directory is never replaced. Without `applyFiles` the pin is left out while files must be copied.
 */
export async function repairSystemAgentWorkspacePin(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    includeOwnsRoster?: boolean;
    authoredDefaultWorkspace?: string;
    /** Copy files now (Doctor repair); otherwise describe the copy and leave the pin out. */
    applyFiles?: boolean;
  } = {},
): Promise<
  DoctorConfigMutationResult & {
    warnings?: string[];
    explicitSetPaths?: string[][];
    /** Rerun with `applyFiles` once the operator confirms; this preview left the pin out. */
    restorePending?: true;
  }
> {
  const unchanged = { config: cfg, changes: [] };
  const agentId = tryResolveLegacyCompatibilityAgentId(cfg);
  const entries = cfg.agents?.entries ?? {};
  const entryKey = Object.keys(entries).find((key) => normalizeAgentId(key) === agentId);
  if (!agentId || !entryKey || resolveAgentEntry(cfg, agentId)?.workspace?.trim()) {
    return unchanged;
  }
  // Mirrors the launch workspace Gateway startup prepares for this agent's turns.
  const launchDir =
    tryResolveConfiguredAgentWorkspaceDir(cfg, env) ?? resolveDefaultAgentWorkspaceDir(env);
  const agentDir = resolveAgentWorkspaceDir(cfg, agentId, env);
  if (launchDir === agentDir) {
    return unchanged;
  }
  const configPath = `agents.entries.${entryKey}.workspace`;
  // Files in a workspace another agent already resolves to belong to that agent.
  const launchOwned = listAgentIds(cfg).some(
    (id) => id !== agentId && resolveAgentWorkspaceDir(cfg, id, env) === launchDir,
  );
  const keepLaunch = !cfg.agents?.defaults?.workspace?.trim();
  if (keepLaunch && launchOwned) {
    // Either pin would move the Gateway working directory, ending stored CLI conversations.
    return {
      ...unchanged,
      warnings: [
        `Agent "${agentId}" works in ${shortenHomePath(launchDir)}, which another agent owns, but resolves its persona and memory to ${shortenHomePath(agentDir)}. Doctor did not set ${configPath}; set it to the directory that should hold its files.`,
      ],
    };
  }
  const [from, to] = keepLaunch ? [agentDir, launchDir] : [launchDir, agentDir];
  const restore: WorkspaceRestorePlan = { copies: [], links: [], conflicts: [] };
  try {
    if (!launchOwned) {
      /**
       * Lists the persona, memory, and skill files (and links under memory/ and skills/) `from` holds
       * that `to` lacks or still has as a seed.
       */
      for (const name of [...GENERATED_WORKSPACE_BOOTSTRAP_FILENAMES, DEFAULT_MEMORY_FILENAME]) {
        await planFile(from, to, name, restore);
      }
      for (const dir of RESTORED_DIRS) {
        await planTree(from, to, dir, restore);
      }
    }
  } catch (error) {
    return {
      ...unchanged,
      warnings: [
        `Could not inspect the workspaces of agent "${agentId}": ${formatErrorMessage(error)}. Set ${configPath} to the directory that holds its files.`,
      ],
    };
  }
  /**
   * Pin `<root>/<agentId>` with the root spelled as authored (`${VAR}`, `~/x`) so a later change
   * to the root moves defaults and pin together; fall back to the resolved path when the authored
   * spelling does not resolve to the same directory.
   */
  let workspace = to;
  if (!keepLaunch) {
    const authoredRoot = options.authoredDefaultWorkspace ?? cfg.agents?.defaults?.workspace;
    const authored = authoredRoot?.trim();
    if (authored) {
      const pin = `${authored.replace(/[\\/]+$/, "")}/${agentId}`;
      try {
        const resolved = containsEnvVarReference(pin)
          ? resolveConfigEnvVars(pin, env, { onMissing: () => {} })
          : pin;
        const resolvedPin = typeof resolved === "string" ? resolved : pin;
        const probe: OpenClawConfig = {
          ...cfg,
          agents: {
            ...cfg.agents,
            entries: { ...cfg.agents?.entries, [agentId]: { workspace: resolvedPin } },
          },
        };
        if (resolveAgentWorkspaceDir(probe, agentId, env) === agentDir) {
          workspace = pin;
        }
      } catch {
        // Keep the resolved agent directory when the authored root cannot be resolved.
      }
    }
  }
  const copied = [...restore.copies, ...restore.links];
  const pinLine = `Set ${configPath} to ${workspace} so its working directory, persona, and memory use one workspace.`;
  if (options.includeOwnsRoster) {
    const shownWorkspace =
      workspace.startsWith("~") || containsEnvVarReference(workspace)
        ? workspace
        : shortenHomePath(workspace);
    const copyHint =
      copied.length > 0
        ? ` after copying ${copied.join(", ")} from ${shortenHomePath(from)} into ${shortenHomePath(to)}`
        : "";
    return {
      ...unchanged,
      warnings: [
        `Set ${configPath} to ${shownWorkspace} in the included agent roster${copyHint} so its working directory, persona, and memory use one workspace.`,
      ],
    };
  }
  if (options.applyFiles !== true) {
    if (copied.length > 0) {
      // The config stays unpinned until the copy runs: --fix, or this repair rerun with
      // applyFiles once the operator accepts the preview.
      return {
        ...unchanged,
        restorePending: true,
        changes: [...describeRestore({ plan: restore, applied: false, from, to }), pinLine],
      };
    }
  } else {
    try {
      /** Copies the planned files; the root keeps every original and no customized target is replaced. */
      for (const rel of restore.copies) {
        const target = path.join(to, rel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        // A seeded template is replaced; any other target must still be absent.
        await fs.copyFile(
          path.join(from, rel),
          target,
          TEMPLATED_FILES.has(rel) ? 0 : fs.constants.COPYFILE_EXCL,
        );
      }
      for (const rel of restore.links) {
        const source = path.join(from, rel);
        const target = path.join(to, rel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        // An absolute target keeps a relative link pointing where it did from the root.
        await fs.symlink(path.resolve(path.dirname(source), await fs.readlink(source)), target);
      }
    } catch (error) {
      return {
        ...unchanged,
        warnings: [
          `Could not copy the files of agent "${agentId}" from ${shortenHomePath(from)} into ${shortenHomePath(to)}: ${formatErrorMessage(error)}. Doctor did not set ${configPath}.`,
        ],
      };
    }
  }
  return {
    config: {
      ...cfg,
      agents: {
        ...cfg.agents,
        entries: { ...entries, [entryKey]: { ...entries[entryKey], workspace } },
      },
    },
    changes: [...describeRestore({ plan: restore, applied: true, from, to }), pinLine],
    explicitSetPaths: [["agents", "entries", entryKey, "workspace"]],
  };
}
