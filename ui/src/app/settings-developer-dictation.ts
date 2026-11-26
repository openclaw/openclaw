import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  DEVELOPER_LIMITS,
  type DeveloperMode,
} from "../../../src/shared/dictation-developer-types.ts";

/** Browser-local selection and authored imports; never stores dictated content. */
export type DeveloperDictationSettings = {
  schemaVersion: 1;
  enabled: boolean;
  mode: DeveloperMode;
  locale: string;
  profileId: string;
  profiles: readonly string[];
};

export const DEFAULT_DEVELOPER_DICTATION_SETTINGS: DeveloperDictationSettings = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  mode: "prose",
  // A user must choose a supported language before enabling grammar rules.
  locale: "",
  profileId: "en-us-plain-code",
  profiles: Object.freeze([]),
});

export const DEVELOPER_DICTATION_MAX_PROFILES = 8;

const settingKeys = new Set([
  "schemaVersion",
  "enabled",
  "mode",
  "locale",
  "profileId",
  "profiles",
]);

/**
 * Consume only the supported envelope. Unknown envelopes stay opaque in the
 * settings owner for export and downgrade recovery, rather than becoming defaults.
 * The profile registry owns semantic validation when a profile is imported/used.
 */
export function normalizeDeveloperDictationSettings(
  value: unknown,
): DeveloperDictationSettings | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    Object.keys(value).some((key) => !settingKeys.has(key)) ||
    typeof value.enabled !== "boolean" ||
    (value.mode !== "prose" && value.mode !== "literal" && value.mode !== "developer") ||
    typeof value.locale !== "string" ||
    value.locale.length > 64 ||
    typeof value.profileId !== "string" ||
    !value.profileId ||
    value.profileId.length > 128 ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > DEVELOPER_DICTATION_MAX_PROFILES
  ) {
    return undefined;
  }
  const profiles: string[] = [];
  const encoder = new TextEncoder();
  for (const profile of value.profiles) {
    if (
      typeof profile !== "string" ||
      profile.length > DEVELOPER_LIMITS.profileBytes ||
      encoder.encode(profile).byteLength > DEVELOPER_LIMITS.profileBytes
    ) {
      return undefined;
    }
    profiles.push(profile);
  }
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    mode: value.mode,
    locale: value.locale,
    profileId: value.profileId,
    profiles,
  };
}
