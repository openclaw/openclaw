// Nostr profile HTTP operations for the channels page: gateway REST calls for
// publishing and importing the relay profile, plus validation-error parsing.
import type { NostrProfile } from "../../api/types.ts";

const NOSTR_PROFILE_REQUEST_TIMEOUT_MS = 30_000;

export function parseValidationErrors(details: unknown): Record<string, string> {
  if (!Array.isArray(details)) {
    return {};
  }
  const errors: Record<string, string> = {};
  for (const entry of details) {
    if (typeof entry !== "string") {
      continue;
    }
    const [rawField, ...rest] = entry.split(":");
    if (!rawField || rest.length === 0) {
      continue;
    }
    const field = rawField.trim();
    const message = rest.join(":").trim();
    if (field && message) {
      errors[field] = message;
    }
  }
  return errors;
}

function buildNostrProfileUrl(accountId: string, suffix = ""): string {
  return `/api/channels/nostr/${encodeURIComponent(accountId)}/profile${suffix}`;
}

export async function putNostrProfile(params: {
  accountId: string;
  headers: Record<string, string>;
  values: NostrProfile;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("nostr profile publish timed out", "TimeoutError")),
    NOSTR_PROFILE_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(buildNostrProfileUrl(params.accountId), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...params.headers,
      },
      body: JSON.stringify(params.values),
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      details?: unknown;
      persisted?: boolean;
    } | null;
    return { data, response };
  } finally {
    clearTimeout(timeout);
  }
}

export async function importNostrProfile(params: {
  accountId: string;
  headers: Record<string, string>;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("nostr profile import timed out", "TimeoutError")),
    NOSTR_PROFILE_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(buildNostrProfileUrl(params.accountId, "/import"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...params.headers,
      },
      body: JSON.stringify({ autoMerge: true }),
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      imported?: NostrProfile;
      merged?: NostrProfile;
      saved?: boolean;
    } | null;
    return { data, response };
  } finally {
    clearTimeout(timeout);
  }
}
