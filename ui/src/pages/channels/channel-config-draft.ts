import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  collectBaseArrayPaths,
  formatConfigPatchPath,
} from "../../../../src/config/patch-replace-paths.js";
import type { ChannelConfigEdit } from "../../lib/channels/index.ts";
import {
  pruneEmptyConfigForm,
  removePathValue,
  setPathValue,
  type JsonSchema,
} from "../../lib/config-form-utils.ts";
import { coerceConfigFormValues } from "../../lib/config/config-draft-model.ts";

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

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
