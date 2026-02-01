import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";

const CONFIRMING_CODE_LENGTH = 6;
const CONFIRMING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CONFIRMING_PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CONFIRMING_PENDING_MAX = 50;
const CONFIRMING_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

export type ConfirmingChannel = "whatsapp" | "telegram" | "signal" | "discord";

export type PendingResponseStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "auto-approved";

export type PendingResponse = {
  /** Unique request ID (short code for user reference). */
  code: string;
  /** Sender identifier (e.g., phone number, user ID). */
  senderId: string;
  /** Sender display name. */
  senderName?: string;
  /** The JID/chat ID to reply to. */
  replyTo: string;
  /** Original message from the sender. */
  originalMessage: string;
  /** AI-generated suggested response. */
  suggestedResponse: string;
  /** Current status. */
  status: PendingResponseStatus;
  /** ISO timestamp when created. */
  createdAt: string;
  /** ISO timestamp when resolved (approved/rejected). */
  resolvedAt?: string;
  /** Edited response (if owner edited before approving). */
  editedResponse?: string;
  /** Account ID for multi-account setups. */
  accountId?: string;
};

type ConfirmingStore = {
  version: 1;
  responses: PendingResponse[];
};

function resolveCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return resolveOAuthDir(env, stateDir);
}

function safeChannelKey(channel: ConfirmingChannel): string {
  const raw = String(channel).trim().toLowerCase();
  if (!raw) {
    throw new Error("invalid confirming channel");
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid confirming channel");
  }
  return safe;
}

function resolveConfirmingPath(
  channel: ConfirmingChannel,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveCredentialsDir(env), `${safeChannelKey(channel)}-confirming.json`);
}

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readJsonFile<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = safeParseJson<T>(raw);
    if (parsed == null) {
      return { value: fallback, exists: true };
    }
    return { value: parsed, exists: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { value: fallback, exists: false };
    }
    return { value: fallback, exists: false };
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
  });
  await fs.promises.chmod(tmp, 0o600);
  await fs.promises.rename(tmp, filePath);
}

async function ensureJsonFile(filePath: string, fallback: unknown) {
  try {
    await fs.promises.access(filePath);
  } catch {
    await writeJsonFile(filePath, fallback);
  }
}

async function withFileLock<T>(
  filePath: string,
  fallback: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureJsonFile(filePath, fallback);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(filePath, CONFIRMING_STORE_LOCK_OPTIONS);
    return await fn();
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // ignore unlock errors
      }
    }
  }
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function isExpired(entry: PendingResponse, nowMs: number): boolean {
  const createdAt = parseTimestamp(entry.createdAt);
  if (!createdAt) {
    return true;
  }
  return nowMs - createdAt > CONFIRMING_PENDING_TTL_MS;
}

function pruneExpiredResponses(responses: PendingResponse[], nowMs: number) {
  const kept: PendingResponse[] = [];
  let removed = false;
  for (const resp of responses) {
    // Keep resolved responses for a shorter time (1 hour) for history
    if (resp.status !== "pending") {
      const resolvedAt = parseTimestamp(resp.resolvedAt);
      if (resolvedAt && nowMs - resolvedAt > 60 * 60 * 1000) {
        removed = true;
        continue;
      }
    }
    if (isExpired(resp, nowMs)) {
      removed = true;
      continue;
    }
    kept.push(resp);
  }
  return { responses: kept, removed };
}

function pruneExcessResponses(responses: PendingResponse[], maxPending: number) {
  const pending = responses.filter((r) => r.status === "pending");
  const resolved = responses.filter((r) => r.status !== "pending");

  if (maxPending <= 0 || pending.length <= maxPending) {
    return { responses, removed: false };
  }

  // Sort by createdAt and keep only the most recent
  const sorted = pending.toSorted((a, b) => {
    const aTime = parseTimestamp(a.createdAt) ?? 0;
    const bTime = parseTimestamp(b.createdAt) ?? 0;
    return aTime - bTime;
  });

  return {
    responses: [...sorted.slice(-maxPending), ...resolved],
    removed: true,
  };
}

function randomCode(): string {
  let out = "";
  for (let i = 0; i < CONFIRMING_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, CONFIRMING_CODE_ALPHABET.length);
    out += CONFIRMING_CODE_ALPHABET[idx];
  }
  return out;
}

function generateUniqueCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const code = randomCode();
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error("failed to generate unique confirming code");
}

export async function listPendingResponses(
  channel: ConfirmingChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PendingResponse[]> {
  const filePath = resolveConfirmingPath(channel, env);
  return await withFileLock(
    filePath,
    { version: 1, responses: [] } satisfies ConfirmingStore,
    async () => {
      const { value } = await readJsonFile<ConfirmingStore>(filePath, {
        version: 1,
        responses: [],
      });
      const responses = Array.isArray(value.responses) ? value.responses : [];
      const nowMs = Date.now();
      const { responses: prunedExpired, removed: expiredRemoved } = pruneExpiredResponses(
        responses,
        nowMs,
      );
      const { responses: pruned, removed: cappedRemoved } = pruneExcessResponses(
        prunedExpired,
        CONFIRMING_PENDING_MAX,
      );
      if (expiredRemoved || cappedRemoved) {
        await writeJsonFile(filePath, {
          version: 1,
          responses: pruned,
        } satisfies ConfirmingStore);
      }
      return pruned
        .filter((r) => r && typeof r.code === "string" && typeof r.senderId === "string")
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  );
}

export async function createPendingResponse(params: {
  channel: ConfirmingChannel;
  senderId: string;
  senderName?: string;
  replyTo: string;
  originalMessage: string;
  suggestedResponse: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: string; created: boolean }> {
  const env = params.env ?? process.env;
  const filePath = resolveConfirmingPath(params.channel, env);
  return await withFileLock(
    filePath,
    { version: 1, responses: [] } satisfies ConfirmingStore,
    async () => {
      const { value } = await readJsonFile<ConfirmingStore>(filePath, {
        version: 1,
        responses: [],
      });
      const now = new Date().toISOString();
      const nowMs = Date.now();

      let responses = Array.isArray(value.responses) ? value.responses : [];
      const { responses: prunedExpired, removed: expiredRemoved } = pruneExpiredResponses(
        responses,
        nowMs,
      );
      responses = prunedExpired;

      const existingCodes = new Set(
        responses.map((r) =>
          String(r.code ?? "")
            .trim()
            .toUpperCase(),
        ),
      );

      const { responses: capped, removed: cappedRemoved } = pruneExcessResponses(
        responses,
        CONFIRMING_PENDING_MAX,
      );
      responses = capped;

      const pendingCount = responses.filter((r) => r.status === "pending").length;
      if (CONFIRMING_PENDING_MAX > 0 && pendingCount >= CONFIRMING_PENDING_MAX) {
        if (expiredRemoved || cappedRemoved) {
          await writeJsonFile(filePath, {
            version: 1,
            responses,
          } satisfies ConfirmingStore);
        }
        return { code: "", created: false };
      }

      const code = generateUniqueCode(existingCodes);
      const newResponse: PendingResponse = {
        code,
        senderId: params.senderId,
        senderName: params.senderName,
        replyTo: params.replyTo,
        originalMessage: params.originalMessage,
        suggestedResponse: params.suggestedResponse,
        status: "pending",
        createdAt: now,
        accountId: params.accountId,
      };

      await writeJsonFile(filePath, {
        version: 1,
        responses: [...responses, newResponse],
      } satisfies ConfirmingStore);

      return { code, created: true };
    },
  );
}

export async function approvePendingResponse(params: {
  channel: ConfirmingChannel;
  code: string;
  editedResponse?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PendingResponse | null> {
  const env = params.env ?? process.env;
  const code = params.code.trim().toUpperCase();
  if (!code) {
    return null;
  }

  const filePath = resolveConfirmingPath(params.channel, env);
  return await withFileLock(
    filePath,
    { version: 1, responses: [] } satisfies ConfirmingStore,
    async () => {
      const { value } = await readJsonFile<ConfirmingStore>(filePath, {
        version: 1,
        responses: [],
      });
      const responses = Array.isArray(value.responses) ? value.responses : [];
      const nowMs = Date.now();
      const { responses: pruned, removed } = pruneExpiredResponses(responses, nowMs);

      const idx = pruned.findIndex(
        (r) => String(r.code ?? "").toUpperCase() === code && r.status === "pending",
      );
      if (idx < 0) {
        if (removed) {
          await writeJsonFile(filePath, {
            version: 1,
            responses: pruned,
          } satisfies ConfirmingStore);
        }
        return null;
      }

      const entry = pruned[idx];
      if (!entry) {
        return null;
      }

      const updated: PendingResponse = {
        ...entry,
        status: "approved",
        resolvedAt: new Date().toISOString(),
        ...(params.editedResponse ? { editedResponse: params.editedResponse } : {}),
      };
      pruned[idx] = updated;

      await writeJsonFile(filePath, {
        version: 1,
        responses: pruned,
      } satisfies ConfirmingStore);

      return updated;
    },
  );
}

export async function rejectPendingResponse(params: {
  channel: ConfirmingChannel;
  code: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PendingResponse | null> {
  const env = params.env ?? process.env;
  const code = params.code.trim().toUpperCase();
  if (!code) {
    return null;
  }

  const filePath = resolveConfirmingPath(params.channel, env);
  return await withFileLock(
    filePath,
    { version: 1, responses: [] } satisfies ConfirmingStore,
    async () => {
      const { value } = await readJsonFile<ConfirmingStore>(filePath, {
        version: 1,
        responses: [],
      });
      const responses = Array.isArray(value.responses) ? value.responses : [];
      const nowMs = Date.now();
      const { responses: pruned, removed } = pruneExpiredResponses(responses, nowMs);

      const idx = pruned.findIndex(
        (r) => String(r.code ?? "").toUpperCase() === code && r.status === "pending",
      );
      if (idx < 0) {
        if (removed) {
          await writeJsonFile(filePath, {
            version: 1,
            responses: pruned,
          } satisfies ConfirmingStore);
        }
        return null;
      }

      const entry = pruned[idx];
      if (!entry) {
        return null;
      }

      const updated: PendingResponse = {
        ...entry,
        status: "rejected",
        resolvedAt: new Date().toISOString(),
      };
      pruned[idx] = updated;

      await writeJsonFile(filePath, {
        version: 1,
        responses: pruned,
      } satisfies ConfirmingStore);

      return updated;
    },
  );
}

export async function getPendingResponseByCode(params: {
  channel: ConfirmingChannel;
  code: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PendingResponse | null> {
  const env = params.env ?? process.env;
  const code = params.code.trim().toUpperCase();
  if (!code) {
    return null;
  }

  const responses = await listPendingResponses(params.channel, env);
  return responses.find((r) => String(r.code ?? "").toUpperCase() === code) ?? null;
}
