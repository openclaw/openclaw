import { jsonSchemaValuesEqual } from "@openclaw/normalization-core/json-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  collectBaseArrayPaths,
  formatConfigPatchPath,
} from "../../../../src/config/patch-replace-paths.js";
import { isSecretRefShape } from "../../../../src/config/redact-snapshot.secret-ref.js";
import type { ConfigSnapshot, ConfigUiHints } from "../../api/types.ts";
import {
  resolveChannelConfigValue,
  type ChannelConfigBase,
  type ChannelConfigEdit,
} from "../../lib/channels/index.ts";
import {
  isEnvPlaceholder,
  isSecretConfigField,
  pruneEmptyConfigForm,
  REDACTED_SENTINEL,
  removePathValue,
  setPathValue,
  type JsonSchema,
} from "../../lib/config-form-utils.ts";
import { coerceConfigFormValues } from "../../lib/config/config-draft-model.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { storedSecretSource } from "../../lib/config/stored-secret-source.ts";

/** The form's view of a channel: its saved values with the unsaved edits on top. */
export function applyChannelConfigEdits(
  base: Record<string, unknown> | null,
  channelId: string,
  edits: readonly ChannelConfigEdit[],
): Record<string, unknown> {
  const root: Record<string, unknown> = {
    channels: { [channelId]: structuredClone(base ?? {}) },
  };
  for (const { path, value } of edits) {
    if (value === undefined) {
      removePathValue(root, path);
    } else {
      setPathValue(root, path, structuredClone(value));
    }
  }
  return (root.channels as Record<string, Record<string, unknown>>)[channelId] ?? {};
}

function savedAt(
  base: Record<string, unknown> | null,
  channelId: string,
  path: ReadonlyArray<string | number>,
): unknown {
  let node: unknown = { channels: { [channelId]: base ?? {} } };
  for (const segment of path) {
    node =
      isRecord(node) || Array.isArray(node)
        ? (node as Record<string, unknown>)[segment]
        : undefined;
  }
  return node;
}

/** Emptying a field typed over a stored secret keeps the secret; nothing here deletes it. */
function emptiesStoredSecret(
  base: Record<string, unknown> | null,
  channelId: string,
  path: ReadonlyArray<string | number>,
  value: unknown,
): boolean {
  return (
    (value === undefined || value === "") && savedAt(base, channelId, path) === REDACTED_SENTINEL
  );
}

/**
 * Whether an edit would land on a stored secret that isn't proven plain text in the file. The
 * field is read-only then, so only a reference that arrived after typing began gets here, and
 * Save leaves it alone.
 */
function writesOverReference(
  snapshot: ConfigSnapshot | null | undefined,
  path: ReadonlyArray<string | number>,
  hints: ConfigUiHints = {},
): boolean {
  let node: unknown = resolveEditableSnapshotConfig(snapshot);
  for (const segment of path) {
    if (isRecord(node) && isSecretRefShape(node)) {
      return true;
    }
    node =
      isRecord(node) || Array.isArray(node)
        ? (node as Record<string, unknown>)[segment]
        : undefined;
  }
  if (isRecord(node) && isSecretRefShape(node)) {
    return true;
  }
  if (typeof node === "string" && isEnvPlaceholder(node)) {
    return isSecretConfigField(path, hints);
  }
  return node === REDACTED_SENTINEL && storedSecretSource(snapshot, path).kind !== "literal";
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * A list or object edited whole keeps each stored secret inside it, as a single field does:
 * emptying one keeps it, and one that isn't proven plain text in the file is never written over.
 * Returns undefined when, after that, the edit changes nothing.
 */
function keepStoredSecrets(params: {
  base: Record<string, unknown> | null;
  snapshot: ConfigSnapshot | null | undefined;
  hints?: ConfigUiHints;
  channelId: string;
  path: ReadonlyArray<string | number>;
  value: unknown;
}): { value: unknown } | undefined {
  const { base, snapshot, channelId } = params;
  const keep = (path: ReadonlyArray<string | number>, value: unknown): unknown => {
    if (
      emptiesStoredSecret(base, channelId, path, value) ||
      (value !== REDACTED_SENTINEL && writesOverReference(snapshot, path, params.hints))
    ) {
      return savedAt(base, channelId, path);
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => keep([...path, index], item));
    }
    if (!isRecord(value)) {
      return value;
    }
    const saved = savedAt(base, channelId, path);
    const kept: Record<string, unknown> = {};
    for (const key of new Set([
      ...Object.keys(value),
      ...(isRecord(saved) ? Object.keys(saved) : []),
    ])) {
      const next = keep([...path, key], value[key]);
      if (next !== undefined) {
        kept[key] = next;
      }
    }
    return kept;
  };
  const value = keep(params.path, params.value);
  return sameValue(value, savedAt(base, channelId, params.path)) ? undefined : { value };
}

function diffInto(
  base: Record<string, unknown>,
  target: Record<string, unknown>,
  parentPath: string,
  replacePaths: string[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(target)])) {
    const path = formatConfigPatchPath(parentPath, key);
    if (!Object.hasOwn(target, key)) {
      patch[key] = null;
      replacePaths.push(...collectBaseArrayPaths(base[key], path));
      continue;
    }
    const baseValue = base[key];
    const targetValue = target[key];
    if (!Object.hasOwn(base, key)) {
      patch[key] = structuredClone(targetValue);
    } else if (isRecord(baseValue) && isRecord(targetValue)) {
      const child = diffInto(baseValue, targetValue, path, replacePaths);
      if (Object.keys(child).length > 0) {
        patch[key] = child;
      }
    } else if (!sameValue(baseValue, targetValue)) {
      patch[key] = structuredClone(targetValue);
      // The edit is the whole array, including any entries it removed.
      if (Array.isArray(baseValue)) {
        replacePaths.push(path);
      }
    }
  }
  return patch;
}

/** Only what the edits changed goes out, so untouched secrets stay redacted and off the wire. */
export function buildChannelConfigPatch(params: {
  base: Record<string, unknown> | null;
  channelId: string;
  edits: readonly ChannelConfigEdit[];
  schema: unknown;
}): { patch: Record<string, unknown>; replacePaths: string[] } | null {
  const { channelId, edits, schema } = params;
  const base = params.base ?? {};
  const edited = { channels: { [channelId]: applyChannelConfigEdits(base, channelId, edits) } };
  const coerced = isRecord(schema)
    ? (coerceConfigFormValues(edited, schema as JsonSchema) as Record<string, unknown>)
    : edited;
  const original = { channels: { [channelId]: base } };
  const pruned = pruneEmptyConfigForm(coerced, original);
  const target = (pruned.channels as Record<string, Record<string, unknown>> | undefined)?.[
    channelId
  ];
  const replacePaths: string[] = [];
  const changes = diffInto(base, target ?? {}, `channels.${channelId}`, replacePaths);
  if (Object.keys(changes).length === 0) {
    return null;
  }
  return { patch: { channels: { [channelId]: changes } }, replacePaths };
}

type ConfigPath = ChannelConfigBase["path"];

function readConfigPath(root: unknown, path: ConfigPath): unknown {
  let node = root;
  for (const segment of path) {
    if (Array.isArray(node) && typeof segment === "number") {
      node = node[segment];
    } else if (isRecord(node) && Object.hasOwn(node, segment)) {
      node = node[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

/** A field that was or became absent counts too: an added or removed key is a change. */
const sameConfigValue = (left: unknown, right: unknown) =>
  left === undefined || right === undefined ? left === right : jsonSchemaValuesEqual(left, right);

const startsWith = (path: ConfigPath, prefix: ConfigPath) =>
  prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);

/** The saved value an edit was made against, at the unit Save writes whole: the edited field,
    or the whole list when the edit lands in one, since lists go out in full. */
function channelConfigEditBase(
  saved: Readonly<Record<string, unknown>>,
  path: ConfigPath,
): ChannelConfigBase {
  let node: unknown = saved;
  for (const [index, segment] of path.entries()) {
    if (Array.isArray(node) || typeof segment === "number") {
      const unit = path.slice(0, index);
      return { path: unit, value: structuredClone(readConfigPath(saved, unit)) };
    }
    node = isRecord(node) && Object.hasOwn(node, segment) ? node[segment] : undefined;
  }
  return { path: [...path], value: structuredClone(node) };
}

/** Edited fields whose saved value changed since the edit: writing them would drop that change. */
export function findChannelConfigConflicts(
  bases: readonly ChannelConfigBase[],
  saved: Readonly<Record<string, unknown>>,
): ConfigPath[] {
  return bases
    .filter((base) => !sameConfigValue(base.value, readConfigPath(saved, base.path)))
    .map((base) => base.path);
}

/** Keep the edits: they now stand against the newer saved values. */
export function rebaseChannelConfigEdits(
  bases: readonly ChannelConfigBase[],
  saved: Readonly<Record<string, unknown>>,
): ChannelConfigBase[] {
  return bases.map((base) => ({
    path: base.path,
    value: structuredClone(readConfigPath(saved, base.path)),
  }));
}

/** Use the newer values: drop the edits to the changed fields, keep the rest. */
export function dropConflictingChannelConfigEdits(
  edits: readonly ChannelConfigEdit[],
  bases: readonly ChannelConfigBase[],
  conflicts: readonly ConfigPath[],
): { edits: ChannelConfigEdit[]; bases: ChannelConfigBase[] } {
  const overlaps = (path: ConfigPath) =>
    conflicts.some((conflict) => startsWith(path, conflict) || startsWith(conflict, path));
  return {
    edits: edits.filter((edit) => !overlaps(edit.path)),
    bases: bases.filter((base) => !overlaps(base.path)),
  };
}

type ChannelEditState = {
  configForm?: Record<string, unknown> | null;
  configSnapshot?: ConfigSnapshot | null;
  configUiHints?: ConfigUiHints;
};

/** Each edit with its stored secrets kept; an edit left changing nothing is dropped. */
export function keptChannelEdits(
  state: ChannelEditState,
  channelId: string,
  root: Record<string, unknown> | null,
  edits: readonly ChannelConfigEdit[],
): ChannelConfigEdit[] {
  const base = resolveChannelConfigValue(root, channelId);
  return edits.flatMap((edit) => {
    const { path, value } = edit;
    const kept = keepStoredSecrets({
      base,
      snapshot: state.configSnapshot,
      hints: state.configUiHints,
      channelId,
      path,
      value,
    });
    return kept ? [{ ...edit, value: kept.value }] : [];
  });
}

/**
 * Records a field's edit against the saved value it was made on. Inside a list edited whole too,
 * a stored secret is never emptied or written over, and an edit left changing nothing is dropped.
 */
export function editChannelField(
  channels: {
    editConfig: (channelId: string, edit: ChannelConfigEdit, base?: ChannelConfigBase) => void;
    restoreConfigField: (channelId: string, path: ChannelConfigEdit["path"]) => void;
  },
  state: ChannelEditState,
  channelId: string,
  edit: ChannelConfigEdit,
): void {
  const [kept] = keptChannelEdits(state, channelId, state.configForm ?? {}, [edit]);
  const saved = resolveEditableSnapshotConfig(state.configSnapshot);
  if (kept) {
    channels.editConfig(
      channelId,
      kept,
      saved ? channelConfigEditBase(saved, edit.path) : undefined,
    );
  } else {
    channels.restoreConfigField(channelId, edit.path);
  }
}
