import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { iteratePluginRootContributions } from "../plugins/plugin-root-contributions.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import {
  loadHookEntriesFromDir,
  type DiscoveredHookEntry,
  type HookDiscoveryRoot,
} from "./discovery.js";
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

function resolveBundledHooksDir(): string | undefined {
  const override = process.env.OPENCLAW_BUNDLED_HOOKS_DIR?.trim();
  if (override) {
    return override;
  }

  // Search compiled executables, npm packages, then source checkouts in that order.
  for (const resolveCandidate of [
    () => path.join(path.dirname(process.execPath), "hooks", "bundled"),
    () => path.join(path.dirname(fileURLToPath(import.meta.url)), "bundled"),
    () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/hooks/bundled"),
  ]) {
    try {
      const candidate = resolveCandidate();
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // A failed candidate does not prevent later installation layouts from resolving.
    }
  }
  return undefined;
}

function resolvePluginHookDirs(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
}): HookDiscoveryRoot[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    return [];
  }
  const metadataSnapshot = resolvePluginMetadataSnapshot({
    workspaceDir,
    config: params.config,
    env: process.env,
  });
  const seen = new Set<string>();
  const resolved: HookDiscoveryRoot[] = [];

  for (const { record, roots } of iteratePluginRootContributions({
    metadataSnapshot,
    config: params.config,
    contribution: "hooks",
  })) {
    for (const root of roots) {
      const candidate = path.resolve(record.rootDir, root);
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      resolved.push({
        dir: candidate,
        pluginId: record.id,
        rootDir: record.rootDir,
        source: "openclaw-plugin",
      });
    }
  }

  return resolved;
}

function resolveHookDiscoveryRoots(
  workspaceDir: string,
  opts?: HookDiscoveryOptions,
): HookDiscoveryRoot[] {
  const bundledHooksDir = opts?.bundledHooksDir ?? resolveBundledHooksDir();
  return [
    ...filterStringEntries(opts?.config?.hooks?.internal?.load?.extraDirs)
      .filter((dir) => dir.trim())
      .map((dir) => {
        // Resolve only the invocation base and home through the trimming resolver.
        // The configured directory's whitespace belongs to its filesystem identity.
        const expanded = dir.startsWith("~")
          ? expandHomePrefix(dir, { home: resolveUserPath("~") })
          : dir;
        return {
          dir: path.isAbsolute(expanded)
            ? path.resolve(expanded)
            : path.resolve(resolveUserPath("."), expanded),
          source: "openclaw-managed" as const,
          includeRoot: true,
        };
      }),
    ...(bundledHooksDir ? [{ dir: bundledHooksDir, source: "openclaw-bundled" as const }] : []),
    ...resolvePluginHookDirs({ workspaceDir, config: opts?.config }),
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
