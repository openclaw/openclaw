import type { ModelCatalogEntry } from "../../../api/types.ts";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";

const CHAT_MODEL_PROVIDER_GROUP_ALIASES: Readonly<Record<string, string>> = {
  "google-gemini-cli": "google",
  "moonshot-ai": "moonshot",
  moonshotai: "moonshot",
  "opencode-go": "opencode",
  "opencode-zen": "opencode",
};

export function normalizeChatModelProviderGroupId(provider: string): string {
  const normalized = normalizeChatModelProviderId(provider);
  return CHAT_MODEL_PROVIDER_GROUP_ALIASES[normalized] ?? normalized;
}

export function prepareChatModelCatalog(catalog: ModelCatalogEntry[]) {
  const qualified = new Map<string, ModelCatalogEntry[]>();
  const ids = new Map<string, ModelCatalogEntry[]>();
  // Keep source order and duplicate rows: display metadata prefers the first
  // canonical entry, while a raw id is unambiguous only with exactly one row.
  for (const entry of catalog) {
    const id = entry.id.trim().toLowerCase();
    const key = `${normalizeChatModelProviderId(entry.provider)}/${id}`;
    const qualifiedRows = qualified.get(key) ?? [];
    qualifiedRows.push(entry);
    qualified.set(key, qualifiedRows);
    const idRows = ids.get(id) ?? [];
    idRows.push(entry);
    ids.set(id, idRows);
  }
  return {
    provider(value: string, providerHint = ""): string {
      const modelRef = value.trim();
      const normalizedModelRef = modelRef.toLowerCase();
      const qualifiedCatalogEntry = qualified.get(normalizedModelRef)?.[0];
      if (qualifiedCatalogEntry) {
        return normalizeChatModelProviderGroupId(qualifiedCatalogEntry.provider);
      }
      const idMatches = ids.get(normalizedModelRef) ?? [];
      const normalizedHint = normalizeChatModelProviderId(providerHint);
      const hintOwnsRawId = idMatches.some(
        (entry) => normalizeChatModelProviderId(entry.provider) === normalizedHint,
      );
      if (normalizedHint && (idMatches.length === 0 || hintOwnsRawId)) {
        return normalizeChatModelProviderGroupId(normalizedHint);
      }
      if (idMatches.length === 1) {
        return normalizeChatModelProviderGroupId(idMatches[0]?.provider ?? "");
      }
      const separator = modelRef.indexOf("/");
      if (separator > 0) {
        return normalizeChatModelProviderGroupId(modelRef.slice(0, separator));
      }
      return "other";
    },
    entry(value: string): ModelCatalogEntry | undefined {
      const trimmedValue = value.trim().toLowerCase();
      const separator = trimmedValue.indexOf("/");
      const normalizedValue =
        separator > 0
          ? `${normalizeChatModelProviderId(trimmedValue.slice(0, separator))}/${trimmedValue.slice(
              separator + 1,
            )}`
          : trimmedValue;
      if (!normalizedValue) {
        return undefined;
      }
      const matches = qualified.get(normalizedValue) ?? [];
      if (matches.length > 0) {
        return (
          matches.find((candidate) => candidate.provider.trim().toLowerCase() === "openai") ??
          matches[0]
        );
      }
      const idMatches = ids.get(normalizedValue) ?? [];
      return idMatches.length === 1 ? idMatches[0] : undefined;
    },
  };
}

export function resolveChatModelPickerLabel(
  entry: ModelCatalogEntry | undefined,
  fallbackLabel: string,
  runtimeId: string | null | undefined = entry?.agentRuntime?.id,
): string {
  const label =
    entry && normalizeChatModelProviderId(entry.provider) === "openai"
      ? entry.name.trim() || fallbackLabel
      : fallbackLabel;
  if (runtimeId !== "codex" || !entry) {
    return label;
  }
  const runtimeIds = new Set([
    entry.agentRuntime?.id,
    ...(entry.runtimeChoices ?? []).map((choice) => choice.agentRuntime.id),
  ]);
  return runtimeIds.has("openclaw") && runtimeIds.has("codex") ? `${label} codex` : label;
}
