import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  formatDeferredPluginMigration,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { collectPluginConfigContractMatches } from "../plugins/config-contract-matches.js";
import { parseConcreteConfigPath, toDotPath } from "../shared/dot-path.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { applyUnsetPathsForWrite } from "./config-path-mutation.js";
import type { ConfigWriteOptions } from "./io.types.js";
import { inheritLegacyDefaultAgentId } from "./legacy.default-agent-owner.js";
import type { OpenClawConfig } from "./types.js";

const snapshotMigrationFacts = new WeakMap<object, readonly DeferredPluginMigration[]>();

/** Revalidation consumes the same pending generation that admitted this source snapshot. */
export function setDeferredPluginMigrationConfigFacts(
  source: object,
  pending: readonly DeferredPluginMigration[] | undefined,
): void {
  if (pending?.length) {
    snapshotMigrationFacts.set(source, structuredClone(pending));
  }
}

export function getDeferredPluginMigrationConfigFacts(
  source: unknown,
): readonly DeferredPluginMigration[] | undefined {
  return isRecord(source) ? snapshotMigrationFacts.get(source) : undefined;
}

function readPathValue(value: unknown, segments: readonly string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (isBlockedObjectKey(segment)) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(segment);
      current = index === undefined ? undefined : current[index];
    } else {
      current = isRecord(current) && Object.hasOwn(current, segment) ? current[segment] : undefined;
    }
  }
  return current;
}

function uniquePaths(paths: readonly string[][]): string[][] {
  return [...new Map(paths.map((path) => [JSON.stringify(path), path])).values()];
}

/** Preserve only current source inputs owned by the deferred plugin or the shared session locator. */
export function resolveDeferredPluginMigrationConfigPaths(params: {
  config: unknown;
  pluginId: string;
  compatibilityMigrationPaths?: readonly string[];
}): Pick<DeferredPluginMigration, "configPaths" | "validationExcludedPaths"> {
  const compatibilityPaths = (params.compatibilityMigrationPaths ?? []).flatMap((pathPattern) =>
    collectPluginConfigContractMatches({ root: params.config, pathPattern }).map(({ path }) =>
      parseConcreteConfigPath(path),
    ),
  );
  const configPaths = uniquePaths([
    ["plugins", "entries", params.pluginId, "config"],
    ["session", "store"],
    ...compatibilityPaths,
  ]).filter((path) => readPathValue(params.config, path) !== undefined);
  return {
    ...(configPaths.length > 0 ? { configPaths } : {}),
    ...(compatibilityPaths.length > 0
      ? { validationExcludedPaths: uniquePaths(compatibilityPaths) }
      : {}),
  };
}

function restorePath(source: unknown, candidate: unknown, segments: readonly string[]): unknown {
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    return structuredClone(source);
  }
  if (isBlockedObjectKey(segment)) {
    return candidate;
  }
  if (Array.isArray(source)) {
    const index = parseConfigPathArrayIndex(segment);
    if (index === undefined || index >= source.length) {
      return candidate;
    }
    const next = Array.isArray(candidate) ? [...candidate] : [];
    next[index] = restorePath(source[index], next[index], rest);
    return next;
  }
  if (!isRecord(source) || !Object.hasOwn(source, segment)) {
    return candidate;
  }
  const next = isRecord(candidate) ? { ...candidate } : {};
  next[segment] = restorePath(source[segment], next[segment], rest);
  return next;
}

/** Explicit edits must not report success after preservation restores their old values. */
export function assertDeferredPluginMigrationConfigEditAllowed(params: {
  sourceConfig: unknown;
  nextConfig: OpenClawConfig;
  pending: readonly DeferredPluginMigration[];
  editedPaths: readonly (readonly string[])[];
}): void {
  for (const pending of params.pending) {
    for (const retainedPath of pending.configPaths ?? []) {
      const intersects = params.editedPaths.some(
        (editedPath) =>
          retainedPath.every((segment, index) => editedPath[index] === segment) ||
          editedPath.every((segment, index) => retainedPath[index] === segment),
      );
      if (
        intersects &&
        !isDeepStrictEqual(
          readPathValue(params.sourceConfig, retainedPath),
          readPathValue(params.nextConfig, retainedPath),
        )
      ) {
        throw new Error(
          `Cannot edit retained config at "${toDotPath(retainedPath)}". ${formatDeferredPluginMigration(pending)}`,
        );
      }
    }
  }
}

/** The current config snapshot owns retained values; migration receipts contain paths only. */
export function preserveDeferredPluginMigrationConfig(params: {
  sourceConfig: unknown;
  nextConfig: OpenClawConfig;
  pending: readonly DeferredPluginMigration[];
  writeOptions?: Pick<ConfigWriteOptions, "explicitSetPaths" | "unsetPaths" | "auditOrigin">;
}): OpenClawConfig {
  const { explicitSetPaths, unsetPaths, auditOrigin } = params.writeOptions ?? {};
  if (params.pending.length > 0) {
    assertDeferredPluginMigrationConfigEditAllowed({
      ...params,
      nextConfig: applyUnsetPathsForWrite(params.nextConfig, unsetPaths),
      editedPaths:
        auditOrigin === "config-rpc" ? [[]] : [...(explicitSetPaths ?? []), ...(unsetPaths ?? [])],
    });
  }
  let next: unknown = params.nextConfig;
  for (const pending of params.pending) {
    for (const path of pending.configPaths ?? []) {
      if (path.length > 0) {
        next = restorePath(params.sourceConfig, next, path);
      }
    }
  }
  return isRecord(next) ? inheritLegacyDefaultAgentId(params.nextConfig, next) : params.nextConfig;
}

/** Retained plugin-owned legacy fields are inert until their migration owner becomes available. */
export function omitDeferredPluginMigrationConfig(
  raw: unknown,
  pending: readonly DeferredPluginMigration[] | undefined,
): unknown {
  return isRecord(raw)
    ? inheritLegacyDefaultAgentId(
        raw,
        applyUnsetPathsForWrite(
          raw,
          pending?.flatMap((entry) => entry.validationExcludedPaths ?? []),
        ),
      )
    : raw;
}
