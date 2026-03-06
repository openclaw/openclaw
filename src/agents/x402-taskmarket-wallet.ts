import { createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const TASKMARKET_SENTINEL_PREFIX = "taskmarket:";
const TASKMARKET_SENTINEL_VERSION = 1;
const DEFAULT_TASKMARKET_API_URL =
  process.env.TASKMARKET_API_URL || "https://api-market.daydreams.systems";
const DEFAULT_ACCOUNT_CACHE_TTL_MS = 15 * 60 * 1000;
const WALLET_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;

export type TaskmarketWalletConfig = {
  v: 1;
  keystorePath: string;
  apiUrl: string;
};

type TaskmarketKeystore = {
  encryptedKey: string;
  walletAddress: string;
  deviceId: string;
  apiToken: string;
};

type CachedTaskmarketAccount = {
  account: PrivateKeyAccount;
  ownerAddress: `0x${string}`;
  expiresAtMs: number;
};

export class TaskmarketWalletError extends Error {
  constructor(
    public readonly code:
      | "sentinel"
      | "keystore"
      | "network"
      | "device_auth"
      | "device_not_found"
      | "decrypt"
      | "address_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "TaskmarketWalletError";
  }
}

const accountCache = new Map<string, CachedTaskmarketAccount>();

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function resolveHomePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function normalizeApiUrl(value: string): string {
  const raw = value.trim() || DEFAULT_TASKMARKET_API_URL;
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

function parseTaskmarketKeystore(raw: unknown, sourcePath: string): TaskmarketKeystore {
  if (!raw || typeof raw !== "object") {
    throw new TaskmarketWalletError(
      "keystore",
      `Invalid Taskmarket keystore JSON at ${sourcePath}`,
    );
  }

  const record = raw as Record<string, unknown>;
  const encryptedKey =
    typeof record.encryptedKey === "string" ? record.encryptedKey.trim() : undefined;
  const walletAddress =
    typeof record.walletAddress === "string" ? record.walletAddress.trim() : undefined;
  const deviceId = typeof record.deviceId === "string" ? record.deviceId.trim() : undefined;
  const apiToken = typeof record.apiToken === "string" ? record.apiToken.trim() : undefined;

  if (
    !encryptedKey ||
    !/^[0-9a-fA-F]+$/.test(encryptedKey) ||
    encryptedKey.length < 58 ||
    encryptedKey.length % 2 !== 0
  ) {
    throw new TaskmarketWalletError(
      "keystore",
      `Taskmarket keystore at ${sourcePath} has an invalid encryptedKey`,
    );
  }
  if (!walletAddress || !WALLET_ADDRESS_REGEX.test(walletAddress)) {
    throw new TaskmarketWalletError(
      "keystore",
      `Taskmarket keystore at ${sourcePath} has an invalid walletAddress`,
    );
  }
  if (!deviceId) {
    throw new TaskmarketWalletError(
      "keystore",
      `Taskmarket keystore at ${sourcePath} is missing deviceId`,
    );
  }
  if (!apiToken) {
    throw new TaskmarketWalletError(
      "keystore",
      `Taskmarket keystore at ${sourcePath} is missing apiToken`,
    );
  }

  return { encryptedKey, walletAddress, deviceId, apiToken };
}

function decodeTaskmarketEncryptedKey(encryptedHex: string): {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
} {
  const data = Buffer.from(encryptedHex, "hex");
  if (data.length <= 28) {
    throw new TaskmarketWalletError("decrypt", "Taskmarket encryptedKey payload is too short");
  }
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  if (ciphertext.length === 0) {
    throw new TaskmarketWalletError("decrypt", "Taskmarket encryptedKey has empty ciphertext");
  }
  return { iv, tag, ciphertext };
}

export function parseTaskmarketWalletConfig(
  apiKey: string | undefined,
): TaskmarketWalletConfig | null {
  if (!apiKey) {
    return null;
  }
  const trimmed = apiKey.trim();
  if (!trimmed.startsWith(TASKMARKET_SENTINEL_PREFIX)) {
    return null;
  }

  const encodedPayload = trimmed.slice(TASKMARKET_SENTINEL_PREFIX.length).trim();
  if (!encodedPayload) {
    throw new TaskmarketWalletError("sentinel", "Taskmarket wallet sentinel has an empty payload");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(encodedPayload));
  } catch {
    throw new TaskmarketWalletError(
      "sentinel",
      "Taskmarket wallet sentinel is invalid. Re-run `openclaw onboard --auth-choice x402`.",
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new TaskmarketWalletError(
      "sentinel",
      "Taskmarket wallet sentinel payload must be an object",
    );
  }
  const record = parsed as Record<string, unknown>;
  const version = record.v;
  const keystorePath = typeof record.keystorePath === "string" ? record.keystorePath.trim() : "";
  const apiUrl =
    typeof record.apiUrl === "string" ? record.apiUrl.trim() : DEFAULT_TASKMARKET_API_URL;

  if (version !== TASKMARKET_SENTINEL_VERSION || !keystorePath) {
    throw new TaskmarketWalletError(
      "sentinel",
      "Taskmarket wallet sentinel is missing required fields. Re-run `taskmarket init` and onboarding.",
    );
  }

  return {
    v: TASKMARKET_SENTINEL_VERSION,
    keystorePath,
    apiUrl: normalizeApiUrl(apiUrl),
  };
}

async function loadTaskmarketKeystore(
  keystorePath: string,
): Promise<{ keystore: TaskmarketKeystore; resolvedPath: string }> {
  const resolvedPath = resolveHomePath(keystorePath);
  if (!resolvedPath) {
    throw new TaskmarketWalletError("keystore", "Taskmarket keystore path is empty");
  }

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new TaskmarketWalletError(
        "keystore",
        `Taskmarket keystore not found at ${resolvedPath}. Run taskmarket init.`,
      );
    }
    throw new TaskmarketWalletError(
      "keystore",
      `Taskmarket keystore at ${resolvedPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TaskmarketWalletError(
      "keystore",
      `Taskmarket keystore at ${resolvedPath} is not valid JSON. Reprovision the wallet.`,
    );
  }

  return {
    keystore: parseTaskmarketKeystore(parsed, resolvedPath),
    resolvedPath,
  };
}

async function fetchTaskmarketDeviceEncryptionKey(params: {
  apiUrl: string;
  deviceId: string;
  apiToken: string;
  fetchFn: typeof fetch;
}): Promise<string> {
  const apiUrl = normalizeApiUrl(params.apiUrl);
  const url = `${apiUrl}/api/devices/${encodeURIComponent(params.deviceId)}/key`;
  let response: Response;
  try {
    response = await params.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: params.deviceId, apiToken: params.apiToken }),
    });
  } catch (error) {
    throw new TaskmarketWalletError(
      "network",
      `Taskmarket device-key request failed at ${apiUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    if (response.status === 404) {
      throw new TaskmarketWalletError(
        "device_not_found",
        `Taskmarket device not found (${params.deviceId}). Reprovision wallet via taskmarket init.`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new TaskmarketWalletError(
        "device_auth",
        `Taskmarket device token rejected (${response.status}). Reprovision wallet via taskmarket init.`,
      );
    }
    throw new TaskmarketWalletError(
      "network",
      `Taskmarket device-key request failed (${response.status}): ${bodyText.slice(0, 180)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch {
    throw new TaskmarketWalletError("network", "Taskmarket device-key response was not valid JSON");
  }

  const dek =
    parsed &&
    typeof parsed === "object" &&
    typeof (parsed as { deviceEncryptionKey?: unknown }).deviceEncryptionKey === "string"
      ? (parsed as { deviceEncryptionKey: string }).deviceEncryptionKey.trim()
      : "";
  if (!/^[0-9a-fA-F]{64}$/.test(dek)) {
    throw new TaskmarketWalletError(
      "network",
      "Taskmarket device-key response is missing a valid DEK",
    );
  }
  return dek;
}

function decryptTaskmarketPrivateKey(deviceEncryptionKeyHex: string, encryptedHex: string): string {
  let key: Buffer;
  try {
    key = Buffer.from(deviceEncryptionKeyHex, "hex");
  } catch {
    throw new TaskmarketWalletError("decrypt", "Taskmarket DEK is not valid hex");
  }
  if (key.length !== 32) {
    throw new TaskmarketWalletError("decrypt", "Taskmarket DEK must be 32 bytes");
  }

  const { iv, tag, ciphertext } = decodeTaskmarketEncryptedKey(encryptedHex);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    const normalized = decrypted.trim().startsWith("0X")
      ? `0x${decrypted.trim().slice(2)}`
      : decrypted.trim();
    if (!PRIVATE_KEY_REGEX.test(normalized)) {
      throw new TaskmarketWalletError(
        "decrypt",
        "Decrypted Taskmarket key is not a valid private key",
      );
    }
    return normalized;
  } catch (error) {
    if (error instanceof TaskmarketWalletError) {
      throw error;
    }
    throw new TaskmarketWalletError("decrypt", "Failed to decrypt Taskmarket keystore payload");
  }
}

function resolveAccountCacheKey(params: {
  apiUrl: string;
  deviceId: string;
  walletAddress: string;
}): string {
  return `${normalizeApiUrl(params.apiUrl)}|${params.deviceId}|${params.walletAddress.toLowerCase()}`;
}

export async function createTaskmarketAccount(params: {
  config: TaskmarketWalletConfig;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
  ttlMs?: number;
}): Promise<{ account: PrivateKeyAccount; ownerAddress: `0x${string}` }> {
  const fetchFn = params.fetchFn ?? globalThis.fetch;
  const nowMs = params.nowMs ?? Date.now;
  const ttlMs = params.ttlMs ?? DEFAULT_ACCOUNT_CACHE_TTL_MS;

  const { keystore } = await loadTaskmarketKeystore(params.config.keystorePath);
  const cacheKey = resolveAccountCacheKey({
    apiUrl: params.config.apiUrl,
    deviceId: keystore.deviceId,
    walletAddress: keystore.walletAddress,
  });

  const cached = accountCache.get(cacheKey);
  const now = nowMs();
  if (cached && cached.expiresAtMs > now) {
    return { account: cached.account, ownerAddress: cached.ownerAddress };
  }

  const attemptResolveAccount = async (): Promise<{
    account: PrivateKeyAccount;
    ownerAddress: `0x${string}`;
  }> => {
    const dek = await fetchTaskmarketDeviceEncryptionKey({
      apiUrl: params.config.apiUrl,
      deviceId: keystore.deviceId,
      apiToken: keystore.apiToken,
      fetchFn,
    });
    const privateKey = decryptTaskmarketPrivateKey(dek, keystore.encryptedKey);
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    if (account.address.toLowerCase() !== keystore.walletAddress.toLowerCase()) {
      throw new TaskmarketWalletError(
        "address_mismatch",
        "Taskmarket keystore address mismatch after decryption. Reprovision wallet via taskmarket init.",
      );
    }
    accountCache.set(cacheKey, {
      account,
      ownerAddress: account.address,
      expiresAtMs: nowMs() + Math.max(ttlMs, 1_000),
    });
    return { account, ownerAddress: account.address };
  };

  try {
    return await attemptResolveAccount();
  } catch (error) {
    // Clear any stale cache and retry once for transient auth/network failures.
    accountCache.delete(cacheKey);
    if (
      error instanceof TaskmarketWalletError &&
      (error.code === "network" ||
        error.code === "device_auth" ||
        error.code === "device_not_found")
    ) {
      return attemptResolveAccount();
    }
    throw error;
  }
}

export function clearTaskmarketAccountCache(): void {
  accountCache.clear();
}

export const __testing = {
  decodeBase64Url,
  resolveHomePath,
  normalizeApiUrl,
  parseTaskmarketKeystore,
  decryptTaskmarketPrivateKey,
  resolveAccountCacheKey,
  loadTaskmarketKeystore,
  fetchTaskmarketDeviceEncryptionKey,
};
