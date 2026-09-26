import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { stripUrlUserInfo } from "@openclaw/net-policy/url-userinfo";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { isRecord } from "../utils.js";
import { asBoolean } from "../utils/boolean.js";
import type { ChannelAccountSnapshot } from "./plugins/types.core.js";

type CredentialUnavailableDiagnostic = {
  code: "CREDENTIAL_FILE_UNAVAILABLE";
  path: string;
  reason: string;
};

export const CREDENTIAL_STATUS_KEYS = [
  "tokenStatus",
  "botTokenStatus",
  "appTokenStatus",
  "signingSecretStatus",
  "userTokenStatus",
] as const;

type CredentialStatusKey = (typeof CREDENTIAL_STATUS_KEYS)[number];
const CREDENTIAL_SOURCE_KEYS = [
  "tokenSource",
  "botTokenSource",
  "appTokenSource",
  "signingSecretSource",
  "userTokenSource",
  "credentialSource",
  "secretSource",
] as const;
type CredentialSnapshotFields = Pick<
  Partial<ChannelAccountSnapshot>,
  CredentialStatusKey | (typeof CREDENTIAL_SOURCE_KEYS)[number]
>;

/** Redacts a plugin-provided base URL after status hooks have produced their final record. */
export function redactChannelStatusSummaryBaseUrl<T>(summary: T): T {
  if (!isRecord(summary) || typeof summary.baseUrl !== "string" || !summary.baseUrl) {
    return summary;
  }
  const redactedBaseUrl = stripUrlUserInfo(redactSensitiveUrlLikeString(summary.baseUrl));
  return redactedBaseUrl === summary.baseUrl
    ? summary
    : ({ ...summary, baseUrl: redactedBaseUrl } as T);
}

/** Redacts a plugin-provided base URL at the public account-snapshot boundary. */
export function redactChannelAccountSnapshotBaseUrl<T extends Partial<ChannelAccountSnapshot>>(
  snapshot: T,
): T {
  return redactChannelStatusSummaryBaseUrl(snapshot);
}

function readNullableNumber(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  return record[key] === null ? null : asFiniteNumber(record[key]);
}

function setSnapshotField<TKey extends keyof ChannelAccountSnapshot>(
  snapshot: Partial<ChannelAccountSnapshot>,
  key: TKey,
  value: ChannelAccountSnapshot[TKey],
): void {
  if (value !== undefined) {
    snapshot[key] = value;
  }
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = normalizeStringEntries(
    value.map((entry) => (typeof entry === "string" || typeof entry === "number" ? entry : "")),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function readCredentialStatus(
  record: Record<string, unknown>,
  key: CredentialStatusKey | "apiCredentialStatus",
) {
  const value = record[key];
  return value === "available" || value === "configured_unavailable" || value === "missing"
    ? value
    : undefined;
}

/** Status inspection must not redeem credentials to detect configured-but-unavailable accounts. */
export function resolveConfiguredFromCredentialStatuses(account: unknown): boolean | undefined {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return undefined;
  }
  let sawCredentialStatus = false;
  for (const key of CREDENTIAL_STATUS_KEYS) {
    const status = readCredentialStatus(record, key);
    if (!status) {
      continue;
    }
    sawCredentialStatus = true;
    if (status !== "missing") {
      return true;
    }
  }
  return sawCredentialStatus ? false : undefined;
}

/** Infers configured state only from the credential status keys required by a channel. */
export function resolveConfiguredFromRequiredCredentialStatuses(
  account: unknown,
  requiredKeys: CredentialStatusKey[],
): boolean | undefined {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return undefined;
  }
  let sawCredentialStatus = false;
  for (const key of requiredKeys) {
    const status = readCredentialStatus(record, key);
    if (!status) {
      continue;
    }
    sawCredentialStatus = true;
    if (status === "missing") {
      return false;
    }
  }
  return sawCredentialStatus ? true : undefined;
}

/** Returns true when a credential exists but cannot be resolved at status-render time. */
export function hasConfiguredUnavailableCredentialStatus(account: unknown): boolean {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return false;
  }
  return CREDENTIAL_STATUS_KEYS.some(
    (key) => readCredentialStatus(record, key) === "configured_unavailable",
  );
}

/** Reads typed, redacted credential diagnostics from a resolved channel account. */
export function getCredentialUnavailableDiagnostics(
  account: unknown,
): CredentialUnavailableDiagnostic[] {
  const record = isRecord(account) ? account : null;
  if (!record || !Array.isArray(record.credentialDiagnostics)) {
    return [];
  }
  const diagnostics: CredentialUnavailableDiagnostic[] = [];
  for (const value of record.credentialDiagnostics) {
    if (!isRecord(value) || value.code !== "CREDENTIAL_FILE_UNAVAILABLE") {
      continue;
    }
    const path = normalizeOptionalString(value.path);
    const reason = normalizeOptionalString(value.reason);
    if (path && reason) {
      diagnostics.push({ code: value.code, path, reason });
    }
  }
  return diagnostics;
}

/** Returns true when account data contains a resolved credential value or available status. */
export function hasResolvedCredentialValue(account: unknown): boolean {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return false;
  }
  return (
    ["token", "botToken", "appToken", "signingSecret", "userToken"].some((key) => {
      return normalizeOptionalString(record[key]) !== undefined;
    }) || CREDENTIAL_STATUS_KEYS.some((key) => readCredentialStatus(record, key) === "available")
  );
}

/** Projects credential source/status metadata while omitting raw credential values. */
export function projectCredentialSnapshotFields(account: unknown): CredentialSnapshotFields {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }
  const snapshot: CredentialSnapshotFields = {};
  // Only the explicit source/status allowlist crosses the credential boundary.
  for (const key of CREDENTIAL_SOURCE_KEYS) {
    setSnapshotField(snapshot, key, normalizeOptionalString(record[key]));
  }
  for (const key of CREDENTIAL_STATUS_KEYS) {
    setSnapshotField(snapshot, key, readCredentialStatus(record, key));
  }
  return snapshot;
}

/** Explicitly allowlist status fields so new account fields cannot expose credentials. */
export function projectSafeChannelAccountSnapshotFields(
  account: unknown,
): Partial<ChannelAccountSnapshot> {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }
  const snapshot: Partial<ChannelAccountSnapshot> = {};
  for (const key of [
    "name",
    "statusState",
    "healthState",
    "mode",
    "dmPolicy",
    "identity",
    "audienceType",
    "webhookPath",
    "cliPath",
    "dbPath",
  ] as const) {
    setSnapshotField(snapshot, key, normalizeOptionalString(record[key]));
  }
  for (const key of [
    "linked",
    "running",
    "connected",
    "restartPending",
    "terminalDisconnect",
    "busy",
    "allowUnmentionedGroups",
  ] as const) {
    setSnapshotField(snapshot, key, asBoolean(record[key]));
  }
  for (const key of [
    "reconnectAttempts",
    "lastInboundAt",
    "lastTransportActivityAt",
    "activeRuns",
    "port",
  ] as const) {
    setSnapshotField(snapshot, key, asFiniteNumber(record[key]));
  }
  for (const key of [
    "lastConnectedAt",
    "lastOutboundAt",
    "lastMessageAt",
    "lastEventAt",
    "lastRunActivityAt",
    "activeRunStartedAt",
  ] as const) {
    setSnapshotField(snapshot, key, readNullableNumber(record, key));
  }
  const lifecycle = record.lifecycle;
  if (
    lifecycle === "starting" ||
    lifecycle === "ready" ||
    lifecycle === "recovering" ||
    lifecycle === "blocked" ||
    lifecycle === "stopped"
  ) {
    snapshot.lifecycle = lifecycle;
  }
  // False or absent ingress means unknown, never evidence that ingress is healthy.
  if (asBoolean(record.ingressUnavailable) === true) {
    snapshot.ingressUnavailable = true;
  }
  setSnapshotField(snapshot, "allowFrom", readStringArray(record, "allowFrom"));
  Object.assign(snapshot, projectCredentialSnapshotFields(account));
  setSnapshotField(
    snapshot,
    "apiCredentialStatus",
    readCredentialStatus(record, "apiCredentialStatus"),
  );

  for (const key of ["baseUrl", "audience"] as const) {
    const value = normalizeOptionalString(record[key]);
    if (value) {
      // Preserve diagnostics without allowing URL-embedded credentials to escape.
      snapshot[key] = stripUrlUserInfo(redactSensitiveUrlLikeString(value));
    }
  }
  return snapshot;
}
