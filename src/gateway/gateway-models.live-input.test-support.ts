export function parseFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") {
    return null;
  }
  const ids: string[] = [];
  for (const rawId of trimmed.split(",")) {
    const id = rawId.trim();
    if (id.length > 0) {
      ids.push(id);
    }
  }
  return ids.length ? new Set(ids) : null;
}

export function toInt(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function filterAttemptedGatewayLiveModels<T extends { id: string; provider: string }>(
  models: T[],
  attemptedModelKeys: ReadonlySet<string>,
): T[] {
  return models.filter((model) => attemptedModelKeys.has(`${model.provider}/${model.id}`));
}
