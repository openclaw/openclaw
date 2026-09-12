// Nostr profile HTTP operations for the channels page: gateway REST calls for
// publishing and importing the relay profile, plus validation-error parsing.
import type { NostrProfile } from "../../api/types.ts";
import { fetchWithControlUiAuth } from "../../app/control-ui-auth.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";

const NOSTR_PROFILE_REQUEST_TIMEOUT_MS = 30_000;

type NostrProfileRequest = {
  accountId: string;
  authCandidates: readonly string[];
  isCurrent: () => boolean;
};

type NostrProfileHttpResult<T> = {
  data: T | null;
  response: Response;
};

async function requestNostrProfile<T>(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  auth: NostrProfileRequest,
): Promise<NostrProfileHttpResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException("Nostr profile request timed out after 30 seconds", "TimeoutError"),
      ),
    NOSTR_PROFILE_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetchWithControlUiAuth(
      url,
      { ...init, signal: controller.signal },
      auth.authCandidates,
      auth.isCurrent,
    );
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? error;
      }
    }
    return { data, response };
  } finally {
    clearTimeout(timeout);
  }
}

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
      errors[field] = formatUiExternalText(message);
    }
  }
  return errors;
}

function buildNostrProfileUrl(accountId: string, suffix = ""): string {
  return `/api/channels/nostr/${encodeURIComponent(accountId)}/profile${suffix}`;
}

export async function putNostrProfile(
  params: NostrProfileRequest & {
    values: NostrProfile;
  },
) {
  return await requestNostrProfile<{
    ok?: boolean;
    error?: string;
    details?: unknown;
    persisted?: boolean;
  }>(
    buildNostrProfileUrl(params.accountId),
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params.values),
    },
    params,
  );
}

export async function importNostrProfile(params: NostrProfileRequest) {
  return await requestNostrProfile<{
    ok?: boolean;
    error?: string;
    imported?: NostrProfile;
    merged?: NostrProfile;
    saved?: boolean;
  }>(
    buildNostrProfileUrl(params.accountId, "/import"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ autoMerge: true }),
    },
    params,
  );
}
