import type { GatewayBrowserClient } from "../../api/gateway.ts";
// Nostr profile HTTP operations for the channels page: gateway REST calls for
// publishing and importing the relay profile, plus validation-error parsing.
import type { NostrProfile } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";

export type NostrOperation = {
  generation: number;
  gateway: ApplicationContext["gateway"];
  channels: ApplicationContext["channels"];
  client: GatewayBrowserClient;
  abortController: AbortController;
  formAccountId: string | null;
  accountId: string;
  headers: Record<string, string>;
};

export class NostrOperationController {
  private current: AbortController | null = null;

  abort() {
    this.current?.abort();
    this.current = null;
  }

  start(): AbortController {
    this.abort();
    this.current = new AbortController();
    return this.current;
  }

  finish(operation: NostrOperation) {
    if (this.current === operation.abortController) {
      this.current = null;
    }
  }
}

export function resolveNostrAccountId(
  channels: ApplicationContext["channels"],
  profileAccountId: string | null,
): string {
  const accounts = channels.state.channelsSnapshot?.channelAccounts?.nostr ?? [];
  return profileAccountId ?? accounts[0]?.accountId ?? "default";
}

export function mergeNostrProfileDraft(
  merged: NostrProfile,
  values: NostrProfile,
  original: NostrProfile,
): NostrProfile {
  const draft = { ...merged };
  for (const field of Object.keys(values) as Array<keyof NostrProfile>) {
    if (values[field] !== original[field]) {
      draft[field] = values[field];
    }
  }
  return draft;
}

export function isCurrentNostrOperation(
  operation: NostrOperation,
  connected: boolean,
  generation: number,
  formAccountId: string | null,
  context: ApplicationContext,
): boolean {
  return (
    connected &&
    generation === operation.generation &&
    formAccountId === operation.formAccountId &&
    context.gateway === operation.gateway &&
    context.channels === operation.channels &&
    operation.gateway.snapshot.client === operation.client &&
    operation.gateway.snapshot.connected
  );
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
  signal?: AbortSignal;
}) {
  const response = await fetch(buildNostrProfileUrl(params.accountId), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify(params.values),
    signal: params.signal,
  });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    details?: unknown;
    persisted?: boolean;
  } | null;
  return { data, response };
}

export async function importNostrProfile(params: {
  accountId: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}) {
  const response = await fetch(buildNostrProfileUrl(params.accountId, "/import"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify({ autoMerge: false }),
    signal: params.signal,
  });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    imported?: NostrProfile;
    merged?: NostrProfile;
  } | null;
  return { data, response };
}
