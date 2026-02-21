import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { resolveStateDir } from "../../config/paths.js";
import { withFileLock } from "../../infra/file-lock.js";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { normalizeAccountId as normalizeSharedAccountId } from "../../routing/account-id.js";

const MODEL_PICKER_PREFERENCES_LOCK_OPTIONS = {
  retries: {
    retries: 8,
    factor: 2,
    minTimeout: 50,
    maxTimeout: 5_000,
    randomize: true,
  },
  stale: 15_000,
} as const;

const DEFAULT_RECENT_LIMIT = 5;

type ModelPickerPreferencesEntry = {
  recent: string[];
  updatedAt: string;
};

type ModelPickerPreferencesStore = {
  version: 1;
  entries: Record<string, ModelPickerPreferencesEntry>;
};

export type DiscordModelPickerPreferenceScope = {
  accountId?: string;
  guildId?: string;
  userId: string;
};

function resolvePreferencesStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
  return path.join(stateDir, "discord", "model-picker-preferences.json");
}

function normalizeId(value?: string): string {
  return value?.trim() ?? "";
}

export function buildDiscordModelPickerPreferenceKey(
  scope: DiscordModelPickerPreferenceScope,
): string | null {
  const userId = normalizeId(scope.userId);
  if (!userId) {
    return null;
  }
  const accountId = normalizeSharedAccountId(scope.accountId);
  const guildId = normalizeId(scope.guildId);
  if (guildId) {
    return `discord:${accountId}:guild:${guildId}:user:${userId}`;
  }
  return `discord:${accountId}:dm:user:${userId}`;
}

function normalizeModelRef(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= value.length - 1) {
    return null;
  }
  const provider = normalizeProviderId(value.slice(0, slashIndex));
  const model = value.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return `${provider}/${model}`;
}

function sanitizeRecentModels(models: string[] | undefined, limit: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of models ?? []) {
    const normalized = normalizeModelRef(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= limit) {
      break;
    }
  }
  return deduped;
}

async function readJsonFileWithFallback<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as T;
    return { value: parsed, exists: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { value: fallback, exists: false };
    }
    return { value: fallback, exists: false };
  }
}

async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.promises.chmod(tmp, 0o600);
  await fs.promises.rename(tmp, filePath);
}

async function readPreferencesStore(filePath: string): Promise<ModelPickerPreferencesStore> {
  const { value } = await readJsonFileWithFallback<ModelPickerPreferencesStore>(filePath, {
    version: 1,
    entries: {},
  });
  if (!value || typeof value !== "object" || value.version !== 1) {
    return { version: 1, entries: {} };
  }
  return {
    version: 1,
    entries: value.entries && typeof value.entries === "object" ? value.entries : {},
  };
}

export async function readDiscordModelPickerRecentModels(params: {
  scope: DiscordModelPickerPreferenceScope;
  limit?: number;
  allowedModelRefs?: Set<string>;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const key = buildDiscordModelPickerPreferenceKey(params.scope);
  if (!key) {
    return [];
  }
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
  const filePath = resolvePreferencesStorePath(params.env);
  const store = await readPreferencesStore(filePath);
  const entry = store.entries[key];
  const recent = sanitizeRecentModels(entry?.recent, limit);
  if (!params.allowedModelRefs || params.allowedModelRefs.size === 0) {
    return recent;
  }
  return recent.filter((modelRef) => params.allowedModelRefs?.has(modelRef));
}

export async function recordDiscordModelPickerRecentModel(params: {
  scope: DiscordModelPickerPreferenceScope;
  modelRef: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const key = buildDiscordModelPickerPreferenceKey(params.scope);
  const normalizedModelRef = normalizeModelRef(params.modelRef);
  if (!key || !normalizedModelRef) {
    return;
  }

  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
  const filePath = resolvePreferencesStorePath(params.env);

  await withFileLock(filePath, MODEL_PICKER_PREFERENCES_LOCK_OPTIONS, async () => {
    const store = await readPreferencesStore(filePath);
    const existing = sanitizeRecentModels(store.entries[key]?.recent, limit);
    const next = [
      normalizedModelRef,
      ...existing.filter((entry) => entry !== normalizedModelRef),
    ].slice(0, limit);

    store.entries[key] = {
      recent: next,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomically(filePath, store);
  });
}
