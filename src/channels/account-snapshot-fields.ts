import type { ChannelAccountSnapshot } from "./plugins/types.core.js";

// Read-only status commands project a safe subset of account fields into snapshots
// so renderers can preserve "configured but unavailable" state without touching
// strict runtime-only credential helpers.

const CREDENTIAL_STATUS_KEYS = [
  "tokenStatus",
  "botTokenStatus",
  "appTokenStatus",
  "signingSecretStatus",
  "userTokenStatus",
] as const;

type CredentialStatusKey = (typeof CREDENTIAL_STATUS_KEYS)[number];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" || typeof entry === "number" ? String(entry) : ""))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function readCredentialStatus(record: Record<string, unknown>, key: CredentialStatusKey) {
  const value = record[key];
  return value === "available" || value === "configured_unavailable" || value === "missing"
    ? value
    : undefined;
}

export function resolveConfiguredFromCredentialStatuses(account: unknown): boolean | undefined {
  const record = asRecord(account);
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

export function resolveConfiguredFromRequiredCredentialStatuses(
  account: unknown,
  requiredKeys: CredentialStatusKey[],
): boolean | undefined {
  const record = asRecord(account);
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

export function hasConfiguredUnavailableCredentialStatus(account: unknown): boolean {
  const record = asRecord(account);
  if (!record) {
    return false;
  }
  return CREDENTIAL_STATUS_KEYS.some(
    (key) => readCredentialStatus(record, key) === "configured_unavailable",
  );
}

export function hasResolvedCredentialValue(account: unknown): boolean {
  const record = asRecord(account);
  if (!record) {
    return false;
  }
  return (
    ["token", "botToken", "appToken", "signingSecret", "userToken"].some((key) => {
      const value = record[key];
      return typeof value === "string" && value.trim().length > 0;
    }) || CREDENTIAL_STATUS_KEYS.some((key) => readCredentialStatus(record, key) === "available")
  );
}

export function projectCredentialSnapshotFields(
  account: unknown,
): Pick<
  Partial<ChannelAccountSnapshot>,
  | "tokenSource"
  | "botTokenSource"
  | "appTokenSource"
  | "signingSecretSource"
  | "tokenStatus"
  | "botTokenStatus"
  | "appTokenStatus"
  | "signingSecretStatus"
  | "userTokenStatus"
> {
  const record = asRecord(account);
  if (!record) {
    return {};
  }

  return {
    ...(readTrimmedString(record, "tokenSource")
      ? { tokenSource: readTrimmedString(record, "tokenSource") }
      : {}),
    ...(readTrimmedString(record, "botTokenSource")
      ? { botTokenSource: readTrimmedString(record, "botTokenSource") }
      : {}),
    ...(readTrimmedString(record, "appTokenSource")
      ? { appTokenSource: readTrimmedString(record, "appTokenSource") }
      : {}),
    ...(readTrimmedString(record, "signingSecretSource")
      ? { signingSecretSource: readTrimmedString(record, "signingSecretSource") }
      : {}),
    ...(readCredentialStatus(record, "tokenStatus")
      ? { tokenStatus: readCredentialStatus(record, "tokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "botTokenStatus")
      ? { botTokenStatus: readCredentialStatus(record, "botTokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "appTokenStatus")
      ? { appTokenStatus: readCredentialStatus(record, "appTokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "signingSecretStatus")
      ? { signingSecretStatus: readCredentialStatus(record, "signingSecretStatus") }
      : {}),
    ...(readCredentialStatus(record, "userTokenStatus")
      ? { userTokenStatus: readCredentialStatus(record, "userTokenStatus") }
      : {}),
  };
}

export function projectSafeChannelAccountSnapshotFields(
  account: unknown,
): Partial<ChannelAccountSnapshot> {
  const record = asRecord(account);
  if (!record) {
    return {};
  }

  return {
    ...(readTrimmedString(record, "name") ? { name: readTrimmedString(record, "name") } : {}),
    ...(readBoolean(record, "linked") !== undefined
      ? { linked: readBoolean(record, "linked") }
      : {}),
    ...(readBoolean(record, "running") !== undefined
      ? { running: readBoolean(record, "running") }
      : {}),
    ...(readBoolean(record, "connected") !== undefined
      ? { connected: readBoolean(record, "connected") }
      : {}),
    ...(readNumber(record, "reconnectAttempts") !== undefined
      ? { reconnectAttempts: readNumber(record, "reconnectAttempts") }
      : {}),
    ...(readTrimmedString(record, "mode") ? { mode: readTrimmedString(record, "mode") } : {}),
    ...(readTrimmedString(record, "dmPolicy")
      ? { dmPolicy: readTrimmedString(record, "dmPolicy") }
      : {}),
    ...(readStringArray(record, "allowFrom")
      ? { allowFrom: readStringArray(record, "allowFrom") }
      : {}),
    ...projectCredentialSnapshotFields(account),
    ...(readTrimmedString(record, "baseUrl")
      ? { baseUrl: readTrimmedString(record, "baseUrl") }
      : {}),
    ...(readBoolean(record, "allowUnmentionedGroups") !== undefined
      ? { allowUnmentionedGroups: readBoolean(record, "allowUnmentionedGroups") }
      : {}),
    ...(readTrimmedString(record, "cliPath")
      ? { cliPath: readTrimmedString(record, "cliPath") }
      : {}),
    ...(readTrimmedString(record, "dbPath") ? { dbPath: readTrimmedString(record, "dbPath") } : {}),
    ...(readNumber(record, "port") !== undefined ? { port: readNumber(record, "port") } : {}),
  };
}
