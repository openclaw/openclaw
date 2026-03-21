import { stripUrlUserInfo } from "../shared/net/url-userinfo.js";
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
    .map((entry) =>
      typeof entry === "string" || typeof entry === "number" ? String(entry).trim() : "",
    )
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

  const tokenSource = readTrimmedString(record, "tokenSource");
  const botTokenSource = readTrimmedString(record, "botTokenSource");
  const appTokenSource = readTrimmedString(record, "appTokenSource");
  const signingSecretSource = readTrimmedString(record, "signingSecretSource");
  const tokenStatus = readCredentialStatus(record, "tokenStatus");
  const botTokenStatus = readCredentialStatus(record, "botTokenStatus");
  const appTokenStatus = readCredentialStatus(record, "appTokenStatus");
  const signingSecretStatus = readCredentialStatus(record, "signingSecretStatus");
  const userTokenStatus = readCredentialStatus(record, "userTokenStatus");

  return {
    ...(tokenSource !== undefined ? { tokenSource } : {}),
    ...(botTokenSource !== undefined ? { botTokenSource } : {}),
    ...(appTokenSource !== undefined ? { appTokenSource } : {}),
    ...(signingSecretSource !== undefined ? { signingSecretSource } : {}),
    ...(tokenStatus !== undefined ? { tokenStatus } : {}),
    ...(botTokenStatus !== undefined ? { botTokenStatus } : {}),
    ...(appTokenStatus !== undefined ? { appTokenStatus } : {}),
    ...(signingSecretStatus !== undefined ? { signingSecretStatus } : {}),
    ...(userTokenStatus !== undefined ? { userTokenStatus } : {}),
  };
}

export function projectSafeChannelAccountSnapshotFields(
  account: unknown,
): Partial<ChannelAccountSnapshot> {
  const record = asRecord(account);
  if (!record) {
    return {};
  }

  const name = readTrimmedString(record, "name");
  const linked = readBoolean(record, "linked");
  const running = readBoolean(record, "running");
  const connected = readBoolean(record, "connected");
  const reconnectAttempts = readNumber(record, "reconnectAttempts");
  const mode = readTrimmedString(record, "mode");
  const dmPolicy = readTrimmedString(record, "dmPolicy");
  const allowFrom = readStringArray(record, "allowFrom");
  const rawBaseUrl = readTrimmedString(record, "baseUrl");
  const allowUnmentionedGroups = readBoolean(record, "allowUnmentionedGroups");
  const cliPath = readTrimmedString(record, "cliPath");
  const dbPath = readTrimmedString(record, "dbPath");
  const port = readNumber(record, "port");

  return {
    ...(name !== undefined ? { name } : {}),
    ...(linked !== undefined ? { linked } : {}),
    ...(running !== undefined ? { running } : {}),
    ...(connected !== undefined ? { connected } : {}),
    ...(reconnectAttempts !== undefined ? { reconnectAttempts } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(dmPolicy !== undefined ? { dmPolicy } : {}),
    ...(allowFrom !== undefined ? { allowFrom } : {}),
    ...projectCredentialSnapshotFields(account),
    ...(rawBaseUrl !== undefined ? { baseUrl: stripUrlUserInfo(rawBaseUrl) } : {}),
    ...(allowUnmentionedGroups !== undefined ? { allowUnmentionedGroups } : {}),
    ...(cliPath !== undefined ? { cliPath } : {}),
    ...(dbPath !== undefined ? { dbPath } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}
