/** Scans auth-profile stores for plaintext credentials, SecretRefs, and OAuth tokens. */
import { isNonEmptyString, isRecord } from "./shared.js";
import { AUTH_PROFILE_SECRET_FIELDS } from "./target-registry-data.js";

type StaticCredentialVisit = {
  profileId: string;
  provider: string;
  /** Original mutable profile record from auth-profiles.json. */
  profile: Record<string, unknown>;
  /** Canonical plaintext credential field name. */
  valueField: string;
  /** Canonical SecretRef sibling field name. */
  refField: string;
  value: unknown;
  refValue: unknown;
} & ({ kind: "api_key" } | { kind: "token" });

type OauthCredentialVisit = {
  kind: "oauth";
  profileId: string;
  provider: string;
  profile: Record<string, unknown>;
  /** Whether the profile currently stores a materialized OAuth access token. */
  hasAccess: boolean;
  /** Whether the profile currently stores a materialized OAuth refresh token. */
  hasRefresh: boolean;
};

type AuthProfileCredentialVisit = StaticCredentialVisit | OauthCredentialVisit;

/** Iterates credential-bearing auth profiles with normalized field metadata for audit/apply. */
export function* iterateAuthProfileCredentials(
  profiles: Record<string, unknown>,
): Iterable<AuthProfileCredentialVisit> {
  for (const [profileId, value] of Object.entries(profiles)) {
    if (!isRecord(value) || !isNonEmptyString(value.provider)) {
      continue;
    }
    const provider = value.provider;
    if (value.type === "api_key" || value.type === "token") {
      const spec = AUTH_PROFILE_SECRET_FIELDS[value.type];
      yield {
        kind: value.type,
        profileId,
        provider,
        profile: value,
        valueField: spec.valueField,
        refField: spec.refField,
        value: value[spec.valueField],
        refValue: value[spec.refField],
      };
      continue;
    }
    if (value.type === "oauth") {
      yield {
        kind: "oauth",
        profileId,
        provider,
        profile: value,
        hasAccess: isNonEmptyString(value.access),
        hasRefresh: isNonEmptyString(value.refresh),
      };
    }
  }
}
