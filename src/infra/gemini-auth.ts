/** Accepts an API key or serialized OAuth credentials containing a token. */
export function parseGeminiAuth(apiKey: string): { headers: Record<string, string> } {
  if (apiKey.startsWith("{")) {
    try {
      const parsed = JSON.parse(apiKey) as { token?: string; projectId?: string };
      if (typeof parsed.token === "string" && parsed.token) {
        return {
          headers: {
            Authorization: `Bearer ${parsed.token}`,
            "Content-Type": "application/json",
          },
        };
      }
    } catch {
      // Malformed JSON remains an API key, matching non-JSON credentials.
    }
  }

  return {
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
  };
}
