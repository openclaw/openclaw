import { normalizeProviderId } from "../../agents/model-selection.js";
import { getDcStateFromDb, setDcStateInDb } from "../../infra/state-db/channel-dc-state-sqlite.js";
import { normalizeAccountId as normalizeSharedAccountId } from "../../routing/account-id.js";

const DEFAULT_RECENT_LIMIT = 5;
const DC_STATE_KEY = "model_picker_preferences";

type ModelPickerPreferencesEntry = {
  recent: string[];
  updatedAt: string;
};

export type DiscordModelPickerPreferenceScope = {
  accountId?: string;
  guildId?: string;
  userId: string;
};

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
  const entry = getDcStateFromDb<ModelPickerPreferencesEntry>(DC_STATE_KEY, key);
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
  const existing = getDcStateFromDb<ModelPickerPreferencesEntry>(DC_STATE_KEY, key);
  const recentList = sanitizeRecentModels(existing?.recent, limit);
  const next = [
    normalizedModelRef,
    ...recentList.filter((entry) => entry !== normalizedModelRef),
  ].slice(0, limit);

  setDcStateInDb(DC_STATE_KEY, key, {
    recent: next,
    updatedAt: new Date().toISOString(),
  });
}
