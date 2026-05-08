import { stripUrlUserInfo } from "../shared/net/url-userinfo.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
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

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNullableNumber(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (record[key] === null) {
    return null;
  }
  return readNumber(record, key);
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" && typeof entry !== "number") {
      continue;
    }
    const trimmed = String(entry).trim();
    if (trimmed) {
      normalized.push(trimmed);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

function readCredentialStatus(record: Record<string, unknown>, key: CredentialStatusKey) {
  const value = record[key];
  return value === "available" || value === "configured_unavailable" || value === "missing"
    ? value
    : undefined;
}

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

export function hasConfiguredUnavailableCredentialStatus(account: unknown): boolean {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return false;
  }
  return CREDENTIAL_STATUS_KEYS.some(
    (key) => readCredentialStatus(record, key) === "configured_unavailable",
  );
}

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
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }
  const tokenSource = normalizeOptionalString(record.tokenSource);
  const botTokenSource = normalizeOptionalString(record.botTokenSource);
  const appTokenSource = normalizeOptionalString(record.appTokenSource);
  const signingSecretSource = normalizeOptionalString(record.signingSecretSource);
  const tokenStatus = readCredentialStatus(record, "tokenStatus");
  const botTokenStatus = readCredentialStatus(record, "botTokenStatus");
  const appTokenStatus = readCredentialStatus(record, "appTokenStatus");
  const signingSecretStatus = readCredentialStatus(record, "signingSecretStatus");
  const userTokenStatus = readCredentialStatus(record, "userTokenStatus");

  return {
    ...(tokenSource ? { tokenSource } : {}),
    ...(botTokenSource ? { botTokenSource } : {}),
    ...(appTokenSource ? { appTokenSource } : {}),
    ...(signingSecretSource ? { signingSecretSource } : {}),
    ...(tokenStatus ? { tokenStatus } : {}),
    ...(botTokenStatus ? { botTokenStatus } : {}),
    ...(appTokenStatus ? { appTokenStatus } : {}),
    ...(signingSecretStatus ? { signingSecretStatus } : {}),
    ...(userTokenStatus ? { userTokenStatus } : {}),
  };
}

export function projectSafeChannelAccountSnapshotFields(
  account: unknown,
): Partial<ChannelAccountSnapshot> {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }
  const name = normalizeOptionalString(record.name);
  const statusState = normalizeOptionalString(record.statusState);
  const healthState = normalizeOptionalString(record.healthState);
  const mode = normalizeOptionalString(record.mode);
  const dmPolicy = normalizeOptionalString(record.dmPolicy);
  const baseUrl = normalizeOptionalString(record.baseUrl);
  const cliPath = normalizeOptionalString(record.cliPath);
  const dbPath = normalizeOptionalString(record.dbPath);
  const linked = readBoolean(record, "linked");
  const running = readBoolean(record, "running");
  const connected = readBoolean(record, "connected");
  const restartPending = readBoolean(record, "restartPending");
  const reconnectAttempts = readNumber(record, "reconnectAttempts");
  const lastConnectedAt = readNullableNumber(record, "lastConnectedAt");
  const lastInboundAt = readNumber(record, "lastInboundAt");
  const lastOutboundAt = readNullableNumber(record, "lastOutboundAt");
  const lastMessageAt = readNullableNumber(record, "lastMessageAt");
  const lastEventAt = readNullableNumber(record, "lastEventAt");
  const lastTransportActivityAt = readNumber(record, "lastTransportActivityAt");
  const busy = readBoolean(record, "busy");
  const activeRuns = readNumber(record, "activeRuns");
  const lastRunActivityAt = readNullableNumber(record, "lastRunActivityAt");
  const allowFrom = readStringArray(record, "allowFrom");
  const allowUnmentionedGroups = readBoolean(record, "allowUnmentionedGroups");
  const port = readNumber(record, "port");

  return {
    ...(name ? { name } : {}),
    ...(linked !== undefined ? { linked } : {}),
    ...(running !== undefined ? { running } : {}),
    ...(connected !== undefined ? { connected } : {}),
    ...(restartPending !== undefined ? { restartPending } : {}),
    ...(reconnectAttempts !== undefined ? { reconnectAttempts } : {}),
    ...(lastConnectedAt !== undefined ? { lastConnectedAt } : {}),
    ...(lastInboundAt !== undefined ? { lastInboundAt } : {}),
    ...(lastOutboundAt !== undefined ? { lastOutboundAt } : {}),
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(lastEventAt !== undefined ? { lastEventAt } : {}),
    ...(lastTransportActivityAt !== undefined ? { lastTransportActivityAt } : {}),
    ...(statusState ? { statusState } : {}),
    ...(healthState ? { healthState } : {}),
    ...(busy !== undefined ? { busy } : {}),
    ...(activeRuns !== undefined ? { activeRuns } : {}),
    ...(lastRunActivityAt !== undefined ? { lastRunActivityAt } : {}),
    ...(mode ? { mode } : {}),
    ...(dmPolicy ? { dmPolicy } : {}),
    ...(allowFrom ? { allowFrom } : {}),
    ...projectCredentialSnapshotFields(account),
    ...(baseUrl ? { baseUrl: stripUrlUserInfo(baseUrl) } : {}),
    ...(allowUnmentionedGroups !== undefined ? { allowUnmentionedGroups } : {}),
    ...(cliPath ? { cliPath } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}
