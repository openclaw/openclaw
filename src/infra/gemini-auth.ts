import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";

/** Accepts an API key or serialized OAuth credentials containing a token. */
export function parseGeminiAuth(apiKey: string): { headers: Record<string, string> } {
  const token = apiKey.startsWith("{") ? safeParseJsonRecord(apiKey)?.token : undefined;
  return {
    headers: {
      ...(typeof token === "string" && token
        ? { Authorization: `Bearer ${token}` }
        : { "x-goog-api-key": apiKey }),
      "Content-Type": "application/json",
    },
  };
}
