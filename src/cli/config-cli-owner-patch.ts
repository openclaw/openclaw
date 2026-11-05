import { isDeepStrictEqual } from "node:util";
import type { ReadConfigFileSnapshotWithPluginMetadataResult } from "../config/io.types.js";
import { prepareConfigWriteTopology } from "../config/io.write-topology.js";
import { applyMergePatch, createMergePatch } from "../config/merge-patch.js";
import { collectBaseArrayPaths, formatConfigPatchPath } from "../config/patch-replace-paths.js";
import { resolveConfigPath } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveIdentityPathViaExistingAncestorSync as identity } from "../infra/boundary-path.js";
import { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { isPlainObject } from "../infra/plain-object.js";
import { shortenHomePath } from "../utils.js";
import type { OwnerRequest } from "./local-state-owner.js";

// Matches the config.patch request schema.
const MAX_REPLACE_PATHS = 256;

// Arrays the patch replaces, or removes with a deleted or replaced subtree, are explicit intent.
function collectReplacePaths(patch: unknown, base: unknown, parentPath?: string): string[] {
  if (!isPlainObject(patch)) {
    return [];
  }
  return Object.entries(patch).flatMap(([key, value]) => {
    const path = formatConfigPatchPath(parentPath, key);
    const baseValue = isPlainObject(base) ? base[key] : undefined;
    if (isPlainObject(value)) {
      return collectReplacePaths(value, baseValue, path);
    }
    // Any non-object value (null, scalar or array) also removes the base arrays below it.
    const removed = collectBaseArrayPaths(baseValue, path);
    return Array.isArray(value) && !removed.includes(path) ? [path].concat(removed) : removed;
  });
}

function createOwnerMergePatch(previous: OpenClawConfig, next: OpenClawConfig) {
  const patch = createMergePatch(previous, next);
  const replacePaths = collectReplacePaths(patch, previous);
  const apply = (base: OpenClawConfig): OpenClawConfig => {
    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
      replaceArrayPaths: new Set(replacePaths),
    });
    // SAFETY: a patch between validated configs over a validated config models the Gateway's merge; the Gateway validates the real result.
    return merged as OpenClawConfig;
  };
  return { patch, replacePaths, apply };
}

/**
 * Prepare the authored config the local writer would save for this change, including the
 * ownership it derives from the command's explicit and unset paths. config.patch carries no
 * such paths, so the Gateway's writer derives ownership and `${VAR}` references from the
 * merged result alone; a change whose result would differ there is refused, not approximated.
 */
export async function prepareConfigOwnerChange(
  params: ReadConfigFileSnapshotWithPluginMetadataResult & {
    previous: OpenClawConfig;
    next: OpenClawConfig;
    explicitSetPaths: readonly (readonly string[])[];
    unsetPaths: readonly (readonly string[])[];
    env: NodeJS.ProcessEnv;
  },
) {
  const { previous, explicitSetPaths, unsetPaths, ...read } = params;
  const local = await prepareConfigWriteTopology({
    ...read,
    nextConfig: params.next,
    options: { explicitSetPaths },
    unsetPaths,
  });
  const refusal = (cause?: unknown) =>
    new Error(
      "The running Gateway would save a different result for this change: it cannot see which paths this command set, so it would recompute environment references or agent, auth or session-store ownership differently. Nothing was sent and no settings were saved. Split the change into separate commands (for example set an owner path after the roster or store change), or stop the Gateway through its service owner, wait for ownership to release, then rerun this exact command.",
      cause === undefined ? undefined : { cause },
    );
  // The Gateway merges the patch over its resolved source and writes without intent paths.
  const owner = await prepareConfigWriteTopology({
    ...read,
    nextConfig: createOwnerMergePatch(previous, local.authoredConfig).apply(
      params.snapshot.sourceConfig,
    ),
    options: {},
    unsetPaths: [],
  }).catch((error: unknown) => {
    // Without the command's paths the Gateway's writer refuses what the local writer admits.
    throw refusal(error);
  });
  if (!isDeepStrictEqual(owner.authoredConfig, local.authoredConfig)) {
    throw refusal();
  }
  return {
    previous,
    next: local.authoredConfig,
    clearedSessionStoreOwner: local.clearedSessionStoreOwner,
  };
}

/**
 * Express a prepared CLI change as one Gateway config.patch request against `baseHash`. Arrays replace or
 * delete exactly, as the local writer would; a change the Gateway's merge cannot reproduce
 * (for example an authored null) is refused instead of being approximated.
 */
function buildConfigOwnerPatch(
  change: { previous: OpenClawConfig; next: OpenClawConfig },
  baseHash: unknown,
) {
  const { patch, replacePaths, apply } = createOwnerMergePatch(change.previous, change.next);
  if (
    replacePaths.length > MAX_REPLACE_PATHS ||
    !isDeepStrictEqual(apply(change.previous), change.next)
  ) {
    throw new Error(
      "This change cannot be expressed as a Gateway config patch, so it was not sent to the running Gateway. No settings were saved. To apply it, stop the Gateway through its service owner, wait for ownership to release, then rerun this exact command.",
    );
  }
  // Only fields stable Gateways accept: their closed config.patch schema rejects newer ones
  // such as `response`, and an updated CLI routes to whichever Gateway is still running.
  return {
    raw: JSON.stringify(patch),
    ...(typeof baseHash === "string" ? { baseHash } : {}),
    ...(replacePaths.length > 0 ? { replacePaths } : {}),
  };
}

/**
 * Bind a routed config change to the file the running Gateway writes. The change is prepared
 * from this command's own read; the returned commit sends it as one config.patch against the
 * owner's revision and returns the restart hint, if any.
 */
export async function bindConfigOwner(requestOwner: OwnerRequest, env: NodeJS.ProcessEnv) {
  const current = await requestOwner<{ hash?: unknown; path?: unknown }>("config.get", {});
  const selected = resolveConfigPath(env);
  if (typeof current.path !== "string" || identity(current.path) !== identity(selected)) {
    throw new Error(
      `The running Gateway owns this state directory but uses config file ${typeof current.path === "string" ? shortenHomePath(current.path) : "<unknown>"}, not ${shortenHomePath(selected)}. Nothing was sent and no settings were saved. Rerun with the Gateway's config path, or stop the Gateway through its service owner and rerun this exact command.`,
    );
  }
  // Owner-routed writes inspect installed plugin state without write custody.
  if (!getDatabaseEngineSelection()) {
    const { readConfigSnapshotForEngineSelection } =
      await import("../commands/config-preflight-snapshot.js");
    await readConfigSnapshotForEngineSelection();
  }
  return async (change: { previous: OpenClawConfig; next: OpenClawConfig }) => {
    const result = await requestOwner<{ restart?: unknown; restartPending?: unknown }>(
      "config.patch",
      buildConfigOwnerPatch(change, current.hash),
    );
    return result.restart || result.restartPending
      ? "The Gateway is restarting to apply it."
      : undefined;
  };
}
