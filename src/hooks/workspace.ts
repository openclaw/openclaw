// Hook workspace helpers resolve hook roots and workspace-local hook files.
import path from "node:path";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { resolveBundledHooksDir } from "./bundled-dir.js";
import {
  loadHookEntriesFromDir,
  type DiscoveredHookEntry,
  type HookDiscoveryRoot,
} from "./discovery.js";
import { resolvePluginHookDirs } from "./plugin-hooks.js";
import { resolveHookEntries } from "./policy.js";
import type { HookEntry, HookPolicyEntry } from "./types.js";

const log = createSubsystemLogger("hooks/workspace");

export type HookSourceFact = HookPolicyEntry & { rootId: string; filePath: string };
type HookCandidate = HookSourceFact & { entry?: DiscoveredHookEntry };
type HookDiscoveryOptions = {
  config?: OpenClawConfig;
  managedHooksDir?: string;
  bundledHooksDir?: string;
};

function resolveHookDiscoveryRoots(
  workspaceDir: string,
  opts?: HookDiscoveryOptions,
): HookDiscoveryRoot[] {
  const bundledHooksDir = opts?.bundledHooksDir ?? resolveBundledHooksDir();
  return [
    ...normalizeTrimmedStringList(opts?.config?.hooks?.internal?.load?.extraDirs).map((dir) => ({
      dir: resolveUserPath(dir),
      source: "openclaw-managed" as const,
      includeRoot: true,
    })),
    ...(bundledHooksDir ? [{ dir: bundledHooksDir, source: "openclaw-bundled" as const }] : []),
    ...resolvePluginHookDirs({ workspaceDir, config: opts?.config }).map(
      ({ dir, pluginId, rootDir }) => ({
        dir,
        pluginId,
        rootDir,
        source: "openclaw-plugin" as const,
      }),
    ),
    { dir: opts?.managedHooksDir ?? path.join(CONFIG_DIR, "hooks"), source: "openclaw-managed" },
    { dir: path.join(workspaceDir, "hooks"), source: "openclaw-workspace" },
  ];
}

/** Prepare source-policy facts separately from executable, freshly discovered handlers. */
export function prepareWorkspaceHookEntries(
  workspaceDir: string,
  opts?: HookDiscoveryOptions & {
    previousSources?: HookSourceFact[];
    requireValidHook?: (entry: HookPolicyEntry) => boolean;
  },
): { entries: HookEntry[]; sources: HookSourceFact[] } {
  const candidates = resolveHookDiscoveryRoots(workspaceDir, opts).flatMap((root) => {
    const rootId = JSON.stringify([
      root.source,
      path.resolve(root.dir),
      root.pluginId,
      Boolean(root.includeRoot),
      root.rootDir,
    ]);
    const entries: HookCandidate[] = loadHookEntriesFromDir(root, log.warn).map((entry) => ({
      rootId,
      filePath: entry.hook.filePath,
      hook: { name: entry.hook.name, source: entry.hook.source },
      metadata: entry.metadata,
      entry,
    }));
    for (const previous of opts?.previousSources ?? []) {
      if (previous.rootId !== rootId) {
        continue;
      }
      const index = entries.findIndex((candidate) => candidate.filePath === previous.filePath);
      const entry = entries[index]?.entry;
      if (entry && !entry.invalidMetadata && entry.metadata?.events.length) {
        continue;
      }
      if (index >= 0) {
        entries.splice(index, 1);
      }
      // A lost winner still shadows lower code. Its metadata can select an error
      // or an intentional non-outcome, but can never supply executable handlers.
      entries.push({ ...previous, entry });
    }
    return entries;
  });
  const resolved = resolveHookEntries(
    opts?.requireValidHook ? candidates : candidates.filter(({ entry }) => entry?.hook.handlerPath),
    {
      onCollisionIgnored: ({ name, kept, ignored }) => {
        log.warn(
          `Ignoring ${ignored.hook.source} hook "${name}" because it cannot override ${kept.hook.source} hook code`,
        );
      },
    },
  );
  const entries = resolved
    .flatMap((candidate) => {
      const { entry } = candidate;
      if (opts?.requireValidHook) {
        if (!opts.requireValidHook(candidate)) {
          return [];
        }
        if (!entry || entry.invalidMetadata || !entry.metadata?.events.length) {
          throw new Error(
            `Hook "${candidate.hook.name}" has missing or invalid metadata at ${candidate.filePath}`,
          );
        }
        if (!entry.hook.handlerPath) {
          throw new Error(
            `Hook "${candidate.hook.name}" has no readable handler in ${entry.hook.baseDir}`,
          );
        }
      }
      return entry ? [entry] : [];
    })
    .filter((entry): entry is HookEntry => Boolean(entry.hook.handlerPath));
  return {
    entries,
    sources: resolved.map(({ rootId, filePath, hook, metadata }) => ({
      rootId,
      filePath,
      hook,
      metadata,
    })),
  };
}

/** Inspect hooks best-effort without retaining an active generation's source obligations. */
export function loadWorkspaceHookEntries(
  workspaceDir: string,
  opts?: HookDiscoveryOptions,
): HookEntry[] {
  return prepareWorkspaceHookEntries(workspaceDir, opts).entries;
}
