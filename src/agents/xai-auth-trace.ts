import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";

const DEFAULT_KEY_PREVIEW = { head: 4, tail: 4 };

function formatApiKeyPreview(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "…";
  }
  const { head, tail } = DEFAULT_KEY_PREVIEW;
  if (trimmed.length <= head + tail) {
    const shortHead = Math.min(2, trimmed.length);
    const shortTail = Math.min(2, trimmed.length - shortHead);
    if (shortTail <= 0) {
      return `${trimmed.slice(0, shortHead)}…`;
    }
    return `${trimmed.slice(0, shortHead)}…${trimmed.slice(-shortTail)}`;
  }
  return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
}

export function shouldTraceProviderAuth(provider: string): boolean {
  return provider.trim().toLowerCase() === "xai";
}

export function summarizeProviderAuthKey(apiKey: string | undefined): string {
  const trimmed = apiKey?.trim() ?? "";
  if (!trimmed) {
    return "missing";
  }
  if (isNonSecretApiKeyMarker(trimmed)) {
    return `marker:${trimmed}`;
  }
  return formatApiKeyPreview(trimmed);
}
