import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  USER_PREFS_ENTRY_LIMIT,
  USER_PREFS_VALUE_BYTES,
} from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type {
  PreparedUserPreferenceUpdate,
  UserPreferenceError,
} from "./user-preferences.types.js";

function prepareEntries(
  entries: Record<string, unknown>,
): Result<Pick<PreparedUserPreferenceUpdate, "serialized" | "deletionKeys">, UserPreferenceError> {
  const rawEntries = Object.entries(entries);
  if (rawEntries.length > USER_PREFS_ENTRY_LIMIT) {
    return err({ code: "invalid-entry-count" });
  }
  const serialized: Array<{ prefKey: string; valueJson: string }> = [];
  const deletionKeys: string[] = [];
  for (const [prefKey, value] of rawEntries) {
    if (!prefKey || prefKey.length > 256) {
      return err({ code: "invalid-key", key: prefKey });
    }
    // JSON null is the additive removal form for this record-shaped RPC.
    if (value === null) {
      deletionKeys.push(prefKey);
      continue;
    }
    let valueJson: string | undefined;
    try {
      valueJson = JSON.stringify(value);
    } catch {
      return err({ code: "invalid-value", key: prefKey });
    }
    if (valueJson === undefined) {
      return err({ code: "invalid-value", key: prefKey });
    }
    if (Buffer.byteLength(valueJson, "utf8") > USER_PREFS_VALUE_BYTES) {
      return err({ code: "value-too-large", key: prefKey });
    }
    serialized.push({ prefKey, valueJson });
  }
  return ok({ serialized, deletionKeys });
}

export function prepareUserPreferenceUpdate(
  entries: Record<string, unknown>,
  expectedEntries: Record<string, unknown> = {},
): Result<PreparedUserPreferenceUpdate, UserPreferenceError> {
  const prepared = prepareEntries(entries);
  if (!prepared.ok) {
    return prepared;
  }
  const expected = prepareEntries(expectedEntries);
  if (!expected.ok) {
    return expected;
  }
  return ok({
    ...prepared.value,
    expected: [
      ...expected.value.serialized,
      ...expected.value.deletionKeys.map((prefKey) => ({ prefKey, valueJson: null })),
    ],
  });
}
