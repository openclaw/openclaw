import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../plugin-sdk/json-store.js";

const MCTL_AUTH_SUBDIR = path.join("mcp-auth", "mctl");
const MCTL_CREDENTIALS_FILE = "credentials.json";
const MCTL_PENDING_FILE = "pending-connect.json";

export type MctlConnectionRecord = {
  version: 1;
  apiBase: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
  login: string | null;
  connectedAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

export type MctlPendingConnectRecord = {
  version: 1;
  apiBase: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  startedAt: string;
};

export type MctlConnectStatus = {
  state: "connected" | "pending" | "expired" | "disconnected";
  connected: boolean;
  pending: boolean;
  apiBase: string;
  login: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
};

function resolveMctlAuthDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), MCTL_AUTH_SUBDIR);
}

export function resolveMctlCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMctlAuthDir(env), MCTL_CREDENTIALS_FILE);
}

export function resolveMctlPendingPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMctlAuthDir(env), MCTL_PENDING_FILE);
}

export async function readMctlCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MctlConnectionRecord | null> {
  const { value, exists } = await readJsonFileWithFallback<MctlConnectionRecord | null>(
    resolveMctlCredentialsPath(env),
    null,
  );
  if (!exists || !value || typeof value !== "object") {
    return null;
  }
  return value;
}

export async function writeMctlCredentials(
  record: MctlConnectionRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writeJsonFileAtomically(resolveMctlCredentialsPath(env), record);
}

export async function deleteMctlCredentials(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await fs.promises.rm(resolveMctlCredentialsPath(env), { force: true });
}

export async function readMctlPendingConnect(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MctlPendingConnectRecord | null> {
  const { value, exists } = await readJsonFileWithFallback<MctlPendingConnectRecord | null>(
    resolveMctlPendingPath(env),
    null,
  );
  if (!exists || !value || typeof value !== "object") {
    return null;
  }
  return value;
}

export async function writeMctlPendingConnect(
  record: MctlPendingConnectRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writeJsonFileAtomically(resolveMctlPendingPath(env), record);
}

export async function deleteMctlPendingConnect(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await fs.promises.rm(resolveMctlPendingPath(env), { force: true });
}

export async function clearMctlConnectState(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await Promise.all([deleteMctlCredentials(env), deleteMctlPendingConnect(env)]);
}

export function decodeJwtSubject(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : null;
  } catch {
    return null;
  }
}

export function buildMctlConnectStatus(params: {
  apiBase: string;
  credentials: MctlConnectionRecord | null;
  pending: MctlPendingConnectRecord | null;
  now?: number;
}): MctlConnectStatus {
  const now = params.now ?? Date.now();
  const expiresAtMs = params.credentials?.expiresAt
    ? Date.parse(params.credentials.expiresAt)
    : null;
  const expired =
    typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs) && expiresAtMs <= now;
  if (params.pending) {
    return {
      state: "pending",
      connected: false,
      pending: true,
      apiBase: params.pending.apiBase,
      login: params.credentials?.login ?? null,
      expiresAt: params.credentials?.expiresAt ?? null,
      updatedAt: params.credentials?.updatedAt ?? null,
      startedAt: params.pending.startedAt,
    };
  }
  if (params.credentials) {
    return {
      state: expired ? "expired" : "connected",
      connected: !expired,
      pending: false,
      apiBase: params.credentials.apiBase || params.apiBase,
      login: params.credentials.login,
      expiresAt: params.credentials.expiresAt,
      updatedAt: params.credentials.updatedAt,
      startedAt: null,
    };
  }
  return {
    state: "disconnected",
    connected: false,
    pending: false,
    apiBase: params.apiBase,
    login: null,
    expiresAt: null,
    updatedAt: null,
    startedAt: null,
  };
}
