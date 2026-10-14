// Persists pairing challenges and approved channel account bindings through the shared-state owner.
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getPairingAdapter } from "../channels/plugins/pairing.js";
import type { ChannelPairingAdapter } from "../channels/plugins/pairing.types.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { resolveAllowFromAccountId, safeChannelKey } from "./pairing-store-keys.js";
import { readChannelAllowEntries } from "./pairing-store-sqlite.js";
import type { PairingChannel, PairingRequestRecord } from "./pairing-store.types.js";
import type { PairingMutation, PairingSelector } from "./pairing-store.worker-contract.js";

export {
  CHANNEL_PAIRING_PENDING_TTL_MS,
  CHANNEL_PAIRING_PENDING_MAX,
  resolveChannelPairingRequestId,
} from "./pairing-store-model.js";
export { readChannelAllowFromStore } from "./pairing-store.read.js";
export type PairingRequest = PairingRequestRecord;

function resolvePairingAdapter(channel: PairingChannel, pairingAdapter?: ChannelPairingAdapter) {
  return pairingAdapter ?? getPairingAdapter(channel) ?? undefined;
}

function normalizeAllowFromInput(
  entry: string | number,
  pairingAdapter?: ChannelPairingAdapter,
): string {
  const trimmed = normalizeStringifiedOptionalString(entry) ?? "";
  if (!trimmed || trimmed === "*") {
    return "";
  }
  const adapter = pairingAdapter;
  const normalized = adapter?.normalizeAllowEntry ? adapter.normalizeAllowEntry(trimmed) : trimmed;
  const normalizedEntry = normalizeOptionalString(normalized) ?? "";
  return normalizedEntry === "*" ? "" : normalizedEntry;
}

type PairingOptions = {
  channel: PairingChannel;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
  assertCurrent?: () => void;
};

function mutatePairing(params: PairingOptions, mutation: PairingMutation) {
  const channel = safeChannelKey(params.channel);
  const assertCurrent = params.assertCurrent;
  const adapter =
    mutation.action === "resolve" && mutation.approval !== "dismiss"
      ? resolvePairingAdapter(params.channel, params.pairingAdapter)
      : undefined;
  if (
    mutation.action === "resolve" &&
    (adapter?.normalizeAllowEntry || adapter?.resolveApprovalStoreEntry)
  ) {
    mutation.approval = "host";
  }
  const context = captureOpenClawStateWorkerContext({ env: params.env ?? process.env });
  return runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "channelPairing.mutate",
        input: { channel, mutation },
      }),
    {
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          context.admission.assertCurrent();
          assertCurrent?.();
          const facts = request.facts;
          if (!isRecord(facts) || facts.channel !== channel) {
            throw new Error("Channel pairing requires its captured mutation authority");
          }
          if (
            request.stage === "prepare" &&
            facts.kind === "channel-pairing-approval" &&
            mutation.action === "resolve" &&
            mutation.approval === "host" &&
            isRecord(facts.entry) &&
            typeof facts.entry.id === "string" &&
            facts.replyPort instanceof MessagePort
          ) {
            const meta: Record<string, string> = {};
            if (facts.entry.meta !== undefined) {
              if (!isRecord(facts.entry.meta)) {
                throw new Error("Invalid channel pairing approval metadata");
              }
              for (const [key, value] of Object.entries(facts.entry.meta)) {
                if (typeof value !== "string") {
                  throw new Error("Invalid channel pairing approval metadata");
                }
                meta[key] = value;
              }
            }
            // The private worker port carries the selected row; plugin code stays outside SQL.
            const entry = { id: facts.entry.id, ...(facts.entry.meta ? { meta } : {}) };
            const approval = adapter?.resolveApprovalStoreEntry
              ? adapter.resolveApprovalStoreEntry({
                  id: entry.id,
                  ...(entry.meta ? { meta: entry.meta } : {}),
                })
              : entry.id;
            const normalized = approval == null ? "" : normalizeAllowFromInput(approval, adapter);
            context.admission.assertCurrent();
            assertCurrent?.();
            facts.replyPort.postMessage(normalized, []);
          } else if (
            facts.kind !== "channel-pairing" ||
            (request.stage !== "transaction" && request.stage !== "commit")
          ) {
            throw new Error("Unexpected channel pairing admission request");
          }
          grant();
        }),
      }),
    },
  );
}

/** @deprecated Use readChannelAllowFromStore; retained for the v2026.9.8 SDK until the next Plugin SDK major. */
export function readChannelAllowFromStoreSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string[] {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);
  return (
    readChannelAllowEntries(openOpenClawStateDatabase({ env }).db, channel)[resolvedAccountId] ?? []
  ).slice();
}

type AllowFromStoreEntryUpdateParams = PairingOptions & {
  entry: string | number;
  accountId?: string;
};

async function updateAllowFromStoreEntry(params: AllowFromStoreEntryUpdateParams, remove: boolean) {
  const accountId = resolveAllowFromAccountId(params.accountId);
  const entry = normalizeAllowFromInput(
    params.entry,
    resolvePairingAdapter(params.channel, params.pairingAdapter),
  );
  const result = await mutatePairing(params, { action: "allow", accountId, entry, remove });
  if (result.action !== "allow") {
    throw new Error("Unexpected channel pairing allowlist result");
  }
  return { changed: result.changed, allowFrom: result.allowFrom };
}

export async function addChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return updateAllowFromStoreEntry(params, false);
}

export async function removeChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return updateAllowFromStoreEntry(params, true);
}

export async function listChannelPairingRequests(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
  assertCurrent?: () => void,
): Promise<PairingRequest[]> {
  const result = await mutatePairing(
    { channel, env, assertCurrent },
    { action: "list", accountId: normalizeLowercaseStringOrEmpty(accountId) },
  );
  if (result.action !== "list") {
    throw new Error("Unexpected channel pairing list result");
  }
  return result.requests;
}

export async function upsertChannelPairingRequest(params: {
  channel: PairingChannel;
  id: string | number;
  accountId: string;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
  /** Extension channels can pass their adapter directly to bypass registry lookup. */
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{ code: string; created: boolean }> {
  const accountId = normalizeLowercaseStringOrEmpty(params.accountId) || DEFAULT_ACCOUNT_ID;
  const meta = {
    ...Object.fromEntries(
      Object.entries(params.meta ?? {})
        .map(([key, value]) => [key, normalizeOptionalString(value) ?? ""] as const)
        .filter(([, value]) => Boolean(value)),
    ),
    accountId,
  };
  const result = await mutatePairing(params, {
    action: "upsert",
    id: normalizeStringifiedOptionalString(params.id) ?? "",
    accountId,
    meta,
  });
  if (result.action !== "upsert") {
    throw new Error("Unexpected channel pairing request result");
  }
  return { code: result.code, created: result.created };
}

async function resolveChannelPairingRequest(
  params: PairingOptions & { accountId?: string },
  selector: PairingSelector,
  approve: boolean,
) {
  const result = await mutatePairing(params, {
    action: "resolve",
    accountId: normalizeLowercaseStringOrEmpty(params.accountId),
    selector,
    approval: approve ? "sender" : "dismiss",
  });
  if (result.action !== "resolve") {
    throw new Error("Unexpected channel pairing resolution result");
  }
  return result.result;
}

export async function approveChannelPairingCode(
  params: PairingOptions & { code: string; accountId?: string },
): Promise<{ id: string; entry: PairingRequest } | null> {
  const code = (normalizeNullableString(params.code) ?? "").toUpperCase();
  return code ? resolveChannelPairingRequest(params, { code }, true) : null;
}

/** Approves a pending request by opaque id without exposing its pairing code. */
export async function approveChannelPairingRequest(params: {
  channel: PairingChannel;
  requestId: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{ id: string; entry: PairingRequest } | null> {
  const requestId = normalizeOptionalString(params.requestId);
  return requestId
    ? resolveChannelPairingRequest(params, { requestId, channel: params.channel }, true)
    : null;
}

/** Dismisses a pending request without blocking the sender from requesting again. */
export async function dismissChannelPairingRequest(params: {
  channel: PairingChannel;
  requestId: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; entry: PairingRequest } | null> {
  const requestId = normalizeOptionalString(params.requestId);
  return requestId
    ? resolveChannelPairingRequest(params, { requestId, channel: params.channel }, false)
    : null;
}
