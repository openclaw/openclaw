type UnknownRecord = Record<string, unknown>;

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
}

function normalizeProvider(value: string): string {
  return value.trim().toLowerCase();
}

export function migrateLegacyCronPayload(payload: UnknownRecord): boolean {
  let mutated = false;

  const providerValue = readString(payload.provider);
  const channelValue = readString(payload.channel);

  const nextProvider =
    typeof providerValue === "string" && providerValue.trim().length > 0
      ? normalizeProvider(providerValue)
      : typeof channelValue === "string" && channelValue.trim().length > 0
        ? normalizeProvider(channelValue)
        : "";

  if (nextProvider) {
    if (providerValue !== nextProvider) {
      payload.provider = nextProvider;
      mutated = true;
    }
  }

  if ("channel" in payload) {
    delete payload.channel;
    mutated = true;
  }

  return mutated;
}
