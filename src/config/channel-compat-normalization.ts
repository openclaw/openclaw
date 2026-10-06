import { asNullableRecord as asObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLegacyDmAliases,
  type CompatMutationResult,
} from "../channels/plugins/dm-access.js";
import {
  normalizeChannelAccounts,
  type NormalizeLegacyChannelAccountParams,
} from "./channel-config-normalization.js";

export { normalizeLegacyDmAliases };
export { asObjectRecord };
export type { CompatMutationResult };
export type {
  NormalizeChannelConfigEntryParams,
  NormalizeLegacyChannelAccountParams,
} from "./channel-config-normalization.js";

/** Resolved streaming values a channel doctor supplies while migrating legacy aliases. */
export type LegacyStreamingAliasOptions = {
  resolvedMode: string;
  /**
   * Mode to persist when migration creates the `streaming` object from flat
   * delivery aliases alone (no streamMode/scalar/boolean mode source). Only
   * needed by channels whose "streaming absent" runtime default differs from
   * their object-without-mode default (Discord: progress vs off).
   */
  aliasOnlyMode?: string;
  includePreviewChunk?: boolean;
  resolvedNativeTransport?: unknown;
};

export type RetiredChannelKeyRemoval = {
  key: string;
  pathPrefix: string;
};

function parseAliasStreamingMode(value: unknown): "off" | "partial" | "block" | "progress" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "off" ||
    normalized === "partial" ||
    normalized === "block" ||
    normalized === "progress"
    ? normalized
    : null;
}

/**
 * Doctor-only stream mode resolution across nested and legacy alias keys.
 *
 * Runtime helpers no longer read `streamMode`, so doctor contracts use this to
 * preserve legacy intent (nested mode > scalar string > streamMode > scalar
 * boolean) while migrating flat aliases into `streaming.mode`.
 */
export function resolveLegacyAliasStreamingMode(
  entry: Record<string, unknown>,
  defaultMode: "off" | "partial" | "block" | "progress",
): "off" | "partial" | "block" | "progress" {
  const nestedMode = asObjectRecord(entry.streaming)?.mode;
  const parsed =
    parseAliasStreamingMode(nestedMode ?? entry.streaming) ??
    parseAliasStreamingMode(entry.streamMode);
  if (parsed) {
    return parsed;
  }
  if (typeof entry.streaming === "boolean") {
    return entry.streaming ? "partial" : "off";
  }
  return defaultMode;
}

/** Checks whether any account entry still carries a channel-specific legacy alias. */
export function hasLegacyAccountStreamingAliases(
  value: unknown,
  match: (entry: unknown) => boolean,
): boolean {
  return Object.values(asObjectRecord(value) ?? {}).some((account) => match(account));
}

/**
 * Moves legacy flat streaming aliases into the nested `streaming` config shape.
 *
 * Existing nested values win over legacy aliases, matching doctor migration rules
 * that preserve explicit modern config while removing stale compatibility keys.
 */
export function normalizeLegacyStreamingAliases(
  params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
    changes: string[];
  } & LegacyStreamingAliasOptions,
): CompatMutationResult {
  const beforeStreaming = params.entry.streaming;
  const hadLegacyStreamMode = params.entry.streamMode !== undefined;
  const hasLegacyFlatFields =
    params.entry.chunkMode !== undefined ||
    params.entry.blockStreaming !== undefined ||
    params.entry.blockStreamingCoalesce !== undefined ||
    (params.includePreviewChunk === true && params.entry.draftChunk !== undefined) ||
    params.entry.nativeStreaming !== undefined;
  const shouldNormalize =
    hadLegacyStreamMode ||
    typeof beforeStreaming === "boolean" ||
    typeof beforeStreaming === "string" ||
    hasLegacyFlatFields;
  if (!shouldNormalize) {
    return { entry: params.entry, changed: false };
  }

  const updated = { ...params.entry };
  let changed = false;
  // Clone nested records so callers keep immutable before/after snapshots.
  const streaming = { ...asObjectRecord(updated.streaming) };
  const block = { ...asObjectRecord(streaming.block) };
  const preview = { ...asObjectRecord(streaming.preview) };

  // Only fill `streaming.mode` when the modern nested field is absent.
  let movedStreamMode = false;
  if (
    (hadLegacyStreamMode ||
      typeof beforeStreaming === "boolean" ||
      typeof beforeStreaming === "string") &&
    streaming.mode === undefined
  ) {
    streaming.mode = params.resolvedMode;
    if (hadLegacyStreamMode) {
      movedStreamMode = true;
      params.changes.push(
        `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`,
      );
    } else if (typeof beforeStreaming === "boolean") {
      params.changes.push(
        `Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`,
      );
    } else if (typeof beforeStreaming === "string") {
      params.changes.push(
        `Moved ${params.pathPrefix}.streaming (scalar) → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`,
      );
    }
    changed = true;
  }
  if (hadLegacyStreamMode) {
    if (!movedStreamMode) {
      // Every mutation needs a change message: doctor discards mutations with
      // empty change lists, which would leave the schema-invalid flat key in
      // the persisted config forever.
      params.changes.push(
        `Removed ${params.pathPrefix}.streamMode (${params.pathPrefix}.streaming.mode already set).`,
      );
    }
    delete updated.streamMode;
    changed = true;
  }
  // Even shadowed flat aliases must be removed: runtime schemas reject them.
  const moveOrRemoveAlias = (
    flatKey: string,
    target: Record<string, unknown>,
    slot: string,
    nestedPath: string,
  ) => {
    if (updated[flatKey] === undefined) {
      return;
    }
    const nested = `${params.pathPrefix}.streaming.${nestedPath}`;
    if (target[slot] === undefined) {
      target[slot] = updated[flatKey];
      params.changes.push(`Moved ${params.pathPrefix}.${flatKey} → ${nested}.`);
    } else {
      params.changes.push(`Removed ${params.pathPrefix}.${flatKey} (${nested} already set).`);
    }
    delete updated[flatKey];
    changed = true;
  };
  moveOrRemoveAlias("chunkMode", streaming, "chunkMode", "chunkMode");
  moveOrRemoveAlias("blockStreaming", block, "enabled", "block.enabled");
  if (params.includePreviewChunk === true) {
    moveOrRemoveAlias("draftChunk", preview, "chunk", "preview.chunk");
  }
  moveOrRemoveAlias("blockStreamingCoalesce", block, "coalesce", "block.coalesce");
  if (updated.nativeStreaming !== undefined && params.resolvedNativeTransport !== undefined) {
    if (streaming.nativeTransport === undefined) {
      streaming.nativeTransport = params.resolvedNativeTransport;
      params.changes.push(
        `Moved ${params.pathPrefix}.nativeStreaming → ${params.pathPrefix}.streaming.nativeTransport.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.nativeStreaming (${params.pathPrefix}.streaming.nativeTransport already set).`,
      );
    }
    delete updated.nativeStreaming;
    changed = true;
  } else if (
    typeof beforeStreaming === "boolean" &&
    streaming.nativeTransport === undefined &&
    params.resolvedNativeTransport !== undefined
  ) {
    streaming.nativeTransport = params.resolvedNativeTransport;
    params.changes.push(
      `Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.streaming.nativeTransport.`,
    );
    changed = true;
  }

  // Discord's absent-object default differs from its absent-mode default. Pin it
  // only when an alias creates streaming; accounts inheriting root streaming
  // suppress aliasOnlyMode and receive the root seed instead.
  if (
    changed &&
    beforeStreaming === undefined &&
    streaming.mode === undefined &&
    params.aliasOnlyMode !== undefined
  ) {
    streaming.mode = params.aliasOnlyMode;
    params.changes.push(
      `Set ${params.pathPrefix}.streaming.mode (${params.aliasOnlyMode}) to keep the previous default while migrating flat streaming keys.`,
    );
  }

  if (Object.keys(preview).length > 0) {
    streaming.preview = preview;
  }
  if (Object.keys(block).length > 0) {
    streaming.block = block;
  }
  updated.streaming = streaming;
  return { entry: updated, changed };
}

/** Capture flat inheritance before root migration removes its aliases. */
function buildRootFlatDeliverySeed(
  entry: Record<string, unknown>,
  includePreviewChunk: boolean | undefined,
): Record<string, unknown> | null {
  const seed: Record<string, unknown> = {};
  if (entry.chunkMode !== undefined) {
    seed.chunkMode = entry.chunkMode;
  }
  const block: Record<string, unknown> = {};
  if (entry.blockStreaming !== undefined) {
    block.enabled = entry.blockStreaming;
  }
  if (entry.blockStreamingCoalesce !== undefined) {
    block.coalesce = entry.blockStreamingCoalesce;
  }
  if (Object.keys(block).length > 0) {
    seed.block = block;
  }
  if (includePreviewChunk === true && entry.draftChunk !== undefined) {
    seed.preview = { chunk: entry.draftChunk };
  }
  return Object.keys(seed).length > 0 ? seed : null;
}

/**
 * Preserve pre-migration precedence: merged-entry mode/block.enabled/preview.chunk
 * prefer root nested values, chunkMode prefers the account, and coalesce merges
 * account fields over root fields. Preview chunks remain atomic. Materialization
 * freezes inheritance at fix time so replacing the root object loses no settings.
 */
function seedMaterializedAccountStreaming(params: {
  created: Record<string, unknown>;
  rootNestedBefore: Record<string, unknown> | null;
  rootFlat: Record<string, unknown> | null;
  rootAfter: Record<string, unknown>;
}): Record<string, unknown> {
  const { created } = params;
  const rootNested = params.rootNestedBefore ?? {};
  const rootFlat = params.rootFlat ?? {};
  // Root-first base for the merged-entry slots plus inherited root extras
  // (progress, preview.toolProgress, ...). Account values fill the gaps.
  const seeded = { ...structuredClone(rootNested) };
  fillMissingRecordFields(seeded, created);
  fillMissingRecordFields(seeded, rootFlat);
  // Root migration can restore mode from scalar aliases; inherit that intent too.
  fillMissingRecordFields(seeded, params.rootAfter);
  // chunkMode: account-entry-first resolver, so the account alias wins.
  if (created.chunkMode !== undefined) {
    seeded.chunkMode = created.chunkMode;
  }
  // block.coalesce: account fields merge over the root pick per field.
  const createdCoalesce = asObjectRecord(asObjectRecord(created.block)?.coalesce);
  if (createdCoalesce) {
    const rootCoalesce =
      asObjectRecord(asObjectRecord(rootNested.block)?.coalesce) ??
      asObjectRecord(asObjectRecord(rootFlat.block)?.coalesce);
    seeded.block = {
      ...asObjectRecord(seeded.block),
      coalesce: { ...structuredClone(rootCoalesce ?? {}), ...structuredClone(createdCoalesce) },
    };
  }
  // preview.chunk: merged-entry resolver picks the whole object atomically, so
  // never blend a root nested chunk with an account draftChunk-derived one.
  const rootNestedPreviewChunk = asObjectRecord(rootNested.preview)?.chunk;
  if (
    rootNestedPreviewChunk !== undefined &&
    asObjectRecord(created.preview)?.chunk !== undefined
  ) {
    seeded.preview = {
      ...asObjectRecord(seeded.preview),
      chunk: structuredClone(rootNestedPreviewChunk),
    };
  }
  return seeded;
}

/** Fills an owned seed; source values are copied before they join it. */
function fillMissingRecordFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): boolean {
  let filled = false;
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined) {
      continue;
    }
    const existing = target[key];
    if (existing === undefined) {
      // Copy so later account-level edits never alias the root config object.
      target[key] = structuredClone(sourceValue);
      filled = true;
      continue;
    }
    const existingRecord = asObjectRecord(existing);
    const sourceRecord = asObjectRecord(sourceValue);
    if (!existingRecord || !sourceRecord) {
      continue;
    }
    const merged = { ...existingRecord };
    if (fillMissingRecordFields(merged, sourceRecord)) {
      target[key] = merged;
      filled = true;
    }
  }
  return filled;
}

/**
 * Runs generic channel doctor alias migration for the root entry and accounts.
 *
 * Channel plugins provide streaming resolution and optional account-specific
 * migrations so core can keep one compatibility path for all channel shapes.
 */
export function normalizeLegacyChannelAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
  normalizeDm?: boolean;
  rootDmPromoteAllowFrom?: boolean;
  normalizeAccountDm?: boolean;
  /**
   * Set for channels whose runtime account merge replaces the root `streaming`
   * object wholesale (`streaming` not deep-merged). Doctor then seeds account
   * objects it materializes with the inherited root settings. Channels that
   * deep-merge streaming (slack, imessage) must NOT seed: their runtime keeps
   * composing root+account, and seeded copies would freeze inheritance.
   */
  seedAccountStreamingFromRoot?: boolean;
  resolveStreamingOptions: (entry: Record<string, unknown>) => LegacyStreamingAliasOptions;
  normalizeAccountExtra?: (params: NormalizeLegacyChannelAccountParams) => CompatMutationResult;
}): CompatMutationResult {
  let updated = params.entry;
  let changed = false;

  // Captured before root migration deletes the flat keys / rewrites the
  // nested object, because seeding must reproduce the per-slot precedence the
  // resolvers applied pre-migration: root.nested > account.flat > root.flat.
  const rootFlatDeliverySeed =
    params.seedAccountStreamingFromRoot === true
      ? buildRootFlatDeliverySeed(
          params.entry,
          params.resolveStreamingOptions(params.entry).includePreviewChunk,
        )
      : null;
  const rootNestedStreamingBefore =
    params.seedAccountStreamingFromRoot === true ? asObjectRecord(params.entry.streaming) : null;

  if (params.normalizeDm === true) {
    const dm = normalizeLegacyDmAliases({
      entry: updated,
      pathPrefix: params.pathPrefix,
      changes: params.changes,
      promoteAllowFrom: params.rootDmPromoteAllowFrom,
    });
    updated = dm.entry;
    changed = dm.changed;
  }

  const streaming = normalizeLegacyStreamingAliases({
    entry: updated,
    pathPrefix: params.pathPrefix,
    changes: params.changes,
    ...params.resolveStreamingOptions(updated),
  });
  updated = streaming.entry;
  changed = changed || streaming.changed;

  const rootStreaming = asObjectRecord(updated.streaming);

  const accounts = normalizeChannelAccounts({
    entry: updated,
    pathPrefix: params.pathPrefix,
    changes: params.changes,
    normalizeAccount: ({ account, accountId, pathPrefix: accountPathPrefix }) => {
      let accountEntry = account;
      let accountChanged = false;

      if (params.normalizeAccountDm === true) {
        const accountDm = normalizeLegacyDmAliases({
          entry: accountEntry,
          pathPrefix: accountPathPrefix,
          changes: params.changes,
        });
        accountEntry = accountDm.entry;
        accountChanged = accountDm.changed;
      }

      const accountStreamingOptions = { ...params.resolveStreamingOptions(accountEntry) };
      if (rootStreaming) {
        // A root object owns the inherited mode, including its absent-mode default.
        delete accountStreamingOptions.aliasOnlyMode;
      }
      const beforeAccountStreaming = accountEntry.streaming;
      const accountStreaming = normalizeLegacyStreamingAliases({
        entry: accountEntry,
        pathPrefix: accountPathPrefix,
        changes: params.changes,
        ...accountStreamingOptions,
      });
      accountEntry = accountStreaming.entry;
      accountChanged = accountChanged || accountStreaming.changed;

      if (
        params.seedAccountStreamingFromRoot === true &&
        accountStreaming.changed &&
        beforeAccountStreaming === undefined &&
        rootStreaming
      ) {
        const created = asObjectRecord(accountEntry.streaming);
        if (created) {
          const seeded = seedMaterializedAccountStreaming({
            created,
            rootNestedBefore: rootNestedStreamingBefore,
            rootFlat: rootFlatDeliverySeed,
            rootAfter: rootStreaming,
          });
          if (JSON.stringify(seeded) !== JSON.stringify(created)) {
            accountEntry = { ...accountEntry, streaming: seeded };
            params.changes.push(
              `Copied ${params.pathPrefix}.streaming into ${accountPathPrefix}.streaming to keep inherited settings while migrating flat streaming keys.`,
            );
          }
        }
      } else if (rootFlatDeliverySeed && beforeAccountStreaming !== undefined) {
        // Existing account streaming replaces the root object. Preserve the flat
        // fallback only in unset slots, per-field for coalesce and atomically for
        // preview.chunk; the recorded change makes this frozen inheritance explicit.
        const accountStreamingObject = asObjectRecord(accountEntry.streaming);
        if (accountStreamingObject) {
          let seededAccount = accountStreamingObject;
          if (
            rootFlatDeliverySeed.chunkMode !== undefined &&
            seededAccount.chunkMode === undefined
          ) {
            seededAccount = { ...seededAccount, chunkMode: rootFlatDeliverySeed.chunkMode };
          }
          const rootFlatBlock = asObjectRecord(rootFlatDeliverySeed.block);
          const rootFlatBlockEnabled = rootFlatBlock?.enabled;
          if (
            rootFlatBlockEnabled !== undefined &&
            asObjectRecord(seededAccount.block)?.enabled === undefined
          ) {
            seededAccount = {
              ...seededAccount,
              block: {
                ...asObjectRecord(seededAccount.block),
                enabled: rootFlatBlockEnabled,
              },
            };
          }
          const rootFlatCoalesce = asObjectRecord(rootFlatBlock?.coalesce);
          if (rootFlatCoalesce) {
            const accountCoalesce = asObjectRecord(asObjectRecord(seededAccount.block)?.coalesce);
            const mergedCoalesce = {
              ...structuredClone(rootFlatCoalesce),
              ...structuredClone(accountCoalesce ?? {}),
            };
            if (JSON.stringify(mergedCoalesce) !== JSON.stringify(accountCoalesce ?? {})) {
              seededAccount = {
                ...seededAccount,
                block: {
                  ...asObjectRecord(seededAccount.block),
                  coalesce: mergedCoalesce,
                },
              };
            }
          }
          const rootFlatPreviewChunk = asObjectRecord(rootFlatDeliverySeed.preview)?.chunk;
          // Atomic slot: only copy the whole chunk object when the account has none.
          if (
            rootFlatPreviewChunk !== undefined &&
            asObjectRecord(seededAccount.preview)?.chunk === undefined
          ) {
            seededAccount = {
              ...seededAccount,
              preview: {
                ...asObjectRecord(seededAccount.preview),
                chunk: structuredClone(rootFlatPreviewChunk),
              },
            };
          }
          if (seededAccount !== accountStreamingObject) {
            accountEntry = { ...accountEntry, streaming: seededAccount };
            accountChanged = true;
            params.changes.push(
              `Copied flat ${params.pathPrefix} delivery keys into ${accountPathPrefix}.streaming to keep inherited settings while migrating flat streaming keys.`,
            );
          }
        }
      }

      const accountExtra = params.normalizeAccountExtra?.({
        account: accountEntry,
        accountId,
        pathPrefix: accountPathPrefix,
        changes: params.changes,
      });
      if (accountExtra) {
        accountEntry = accountExtra.entry;
        accountChanged = accountChanged || accountExtra.changed;
      }

      return { entry: accountEntry, changed: accountChanged };
    },
  });
  return { entry: accounts.entry, changed: changed || accounts.changed };
}

/** Detects legacy streaming aliases on one channel or account config entry. */
export function hasLegacyStreamingAliases(
  value: unknown,
  options?: { includePreviewChunk?: boolean; includeNativeTransport?: boolean },
): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  return (
    entry.streamMode !== undefined ||
    typeof entry.streaming === "boolean" ||
    typeof entry.streaming === "string" ||
    entry.chunkMode !== undefined ||
    entry.blockStreaming !== undefined ||
    entry.blockStreamingCoalesce !== undefined ||
    (options?.includePreviewChunk === true && entry.draftChunk !== undefined) ||
    (options?.includeNativeTransport === true && entry.nativeStreaming !== undefined)
  );
}
