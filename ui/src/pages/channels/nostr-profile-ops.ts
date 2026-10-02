// Nostr profile HTTP operations for the channels page: gateway REST calls for
// publishing and importing the relay profile, plus validation-error parsing.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { NostrProfile } from "../../api/types.ts";
import { fetchWithControlUiAuth, readControlUiJsonResponse } from "../../app/control-ui-auth.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";

const NOSTR_PROFILE_REQUEST_TIMEOUT_MS = 30_000;

type NostrProfileRequest = {
  accountId: string;
  authCandidates: readonly string[];
  isCurrent: () => boolean;
};

async function requestNostrProfile(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  auth: NostrProfileRequest,
) {
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
    return await readControlUiJsonResponse(response, controller.signal);
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
  return await requestNostrProfile(
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

function isNostrProfile(value: unknown): value is NostrProfile {
  return (
    isRecord(value) &&
    ["name", "displayName", "about", "picture", "banner", "website", "nip05", "lud16"].every(
      (field) =>
        value[field] === undefined || value[field] === null || typeof value[field] === "string",
    )
  );
}

export async function importNostrProfile(params: NostrProfileRequest) {
  const result = await requestNostrProfile(
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
  return {
    ...result,
    data: result.data && {
      ...result.data,
      ok: result.data.ok,
      saved: result.data.saved,
      imported: isNostrProfile(result.data.imported) ? result.data.imported : undefined,
      merged: isNostrProfile(result.data.merged) ? result.data.merged : undefined,
    },
  };
}
