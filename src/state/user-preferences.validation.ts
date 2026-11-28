import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  normalizeBackgroundPreference,
  USER_BACKGROUND_PREFERENCE_KEY,
} from "../../packages/gateway-protocol/src/schema/background-preferences.js";
import { CRON_FAILURE_DISMISSALS_KEY } from "../../packages/gateway-protocol/src/schema/cron-failure-dismissals.js";
import {
  normalizeGitCoauthorOrganizationIdentity,
  GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY,
} from "../../packages/gateway-protocol/src/schema/git-coauthor-identity.js";
import {
  USER_PREFS_ENTRY_LIMIT,
  USER_PREFS_VALUE_BYTES,
} from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import {
  assertVoiceSnippetCatalogTransition,
  createVoiceSnippetCatalog,
  validateVoiceSnippetCatalog,
  VOICE_SNIPPETS_PREFERENCE_KEY,
  VOICE_SNIPPET_CATALOG_BYTES,
  VoiceSnippetValidationError,
} from "../shared/voice-snippets.js";
import type {
  PreparedUserPreferenceUpdate,
  UserPreferenceError,
} from "./user-preferences.types.js";

function prepareEntries(
  entries: Record<string, unknown>,
  trustedProxyGitCoauthor = false,
  expected = false,
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
    if (prefKey === GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY && !trustedProxyGitCoauthor) {
      return err({ code: "invalid-key", key: prefKey });
    }
    // JSON null is the additive removal form for this record-shaped RPC.
    if (value === null) {
      if (prefKey === VOICE_SNIPPETS_PREFERENCE_KEY && !expected) {
        return err({ code: "invalid-snippet-catalog", reason: "invalid-schema" });
      }
      deletionKeys.push(prefKey);
      continue;
    }
    let valueJson: string | undefined;
    try {
      if (prefKey === VOICE_SNIPPETS_PREFERENCE_KEY) {
        validateVoiceSnippetCatalog(value);
      }
      const background =
        prefKey === USER_BACKGROUND_PREFERENCE_KEY
          ? normalizeBackgroundPreference(value)
          : undefined;
      const credit =
        prefKey === GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY
          ? normalizeGitCoauthorOrganizationIdentity(value)
          : undefined;
      if (prefKey === GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY && !credit) {
        return err({ code: "invalid-value", key: prefKey });
      }
      if (prefKey === USER_BACKGROUND_PREFERENCE_KEY && !background) {
        return err({ code: "invalid-value", key: prefKey });
      }
      valueJson = JSON.stringify(credit ?? background ?? value);
    } catch (error) {
      if (error instanceof VoiceSnippetValidationError) {
        return err({ code: "invalid-snippet-catalog", reason: error.code });
      }
      return err({ code: "invalid-value", key: prefKey });
    }
    if (valueJson === undefined) {
      return err({ code: "invalid-value", key: prefKey });
    }
    const valueLimit =
      prefKey === VOICE_SNIPPETS_PREFERENCE_KEY
        ? VOICE_SNIPPET_CATALOG_BYTES
        : USER_PREFS_VALUE_BYTES;
    if (Buffer.byteLength(valueJson, "utf8") > valueLimit) {
      return err({ code: "value-too-large", key: prefKey });
    }
    serialized.push({ prefKey, valueJson });
  }
  return ok({ serialized, deletionKeys });
}

export function prepareUserPreferenceUpdate(
  entries: Record<string, unknown>,
  expectedEntries: Record<string, unknown> = {},
  options: {
    trustedProxyGitCoauthor?: true;
    organizationPolicy?: string | null;
  } = {},
): Result<PreparedUserPreferenceUpdate, UserPreferenceError> {
  if (Object.hasOwn(entries, CRON_FAILURE_DISMISSALS_KEY)) {
    return err({ code: "invalid-key", key: CRON_FAILURE_DISMISSALS_KEY });
  }
  const prepared = prepareEntries(entries, options.trustedProxyGitCoauthor);
  if (!prepared.ok) {
    return prepared;
  }
  const expected = prepareEntries(expectedEntries, true, true);
  if (!expected.ok) {
    return expected;
  }
  if (Object.hasOwn(entries, VOICE_SNIPPETS_PREFERENCE_KEY)) {
    if (!Object.hasOwn(expectedEntries, VOICE_SNIPPETS_PREFERENCE_KEY)) {
      return err({ code: "conflict" });
    }
    try {
      const previous = expectedEntries[VOICE_SNIPPETS_PREFERENCE_KEY];
      assertVoiceSnippetCatalogTransition(
        previous === null ? createVoiceSnippetCatalog() : validateVoiceSnippetCatalog(previous),
        validateVoiceSnippetCatalog(entries[VOICE_SNIPPETS_PREFERENCE_KEY]),
      );
    } catch (error) {
      return error instanceof VoiceSnippetValidationError && error.code === "conflict"
        ? err({ code: "conflict" })
        : err({ code: "invalid-snippet-catalog", reason: "invalid-schema" });
    }
  }
  return ok({
    ...prepared.value,
    ...(options.organizationPolicy !== undefined
      ? { organizationPolicy: options.organizationPolicy }
      : {}),
    expected: [
      ...expected.value.serialized,
      ...expected.value.deletionKeys.map((prefKey) => ({ prefKey, valueJson: null })),
    ],
  });
}
