/**
 * Owns results produced for a chat. A result is a stored pending-input row from the moment its
 * producer finishes; it leaves that state only when a turn appends it to the transcript, keyed by
 * its id, or when it is withheld with a cause.
 */
import { randomUUID } from "node:crypto";
import type {
  CommandOwnerRequester,
  SessionEventRequesterOwner,
} from "../auto-reply/reply/session-event-target.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionPendingInputEndCause } from "../config/sessions/session-pending-input-end-cause.types.js";
import { readSessionQueuedInputPage } from "../config/sessions/session-pending-input-history.js";
import { preparePendingInputStore } from "../config/sessions/session-pending-input-store.js";
import { readOwedKind, type OwedKind } from "../config/sessions/session-pending-input-value.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import type { ChatRef } from "./chat-ref.js";

/**
 * Who produced the result, saved as data. Consumption does not read it yet; a later slice
 * intersects it with current policy without a migration.
 */
type OwedOriginFacts = Readonly<{
  requester?: SessionEventRequesterOwner["requester"];
  commandOwner?: CommandOwnerRequester;
  operatorProfileId?: string;
}>;

export type Owed = {
  id: string;
  to: ChatRef;
  kind: OwedKind;
  text: string;
  originFacts?: OwedOriginFacts;
};

/** Opens the owed row's store at the chat's current transcript and reads the row by its id. */
async function openOwed(item: Owed) {
  const entry = await readSessionEntryReadOnlyInWorker({ ...item.to });
  if (!entry) {
    return undefined;
  }
  const store = await preparePendingInputStore(
    { ...item.to, sessionId: entry.sessionId },
    () => {},
  );
  try {
    const identity = {
      sessionKey: store.sessionKey,
      sessionId: entry.sessionId,
      idempotencyKey: item.id,
    };
    const snapshot = await store.read({ ...identity, kind: "stage", trackCompletion: false });
    if (snapshot.kind !== "stage" || !snapshot.current) {
      throw new Error("Owed result lost its chat");
    }
    const row = snapshot.existing;
    const pending = row?.state === "queued" && row.consumed_event_id == null ? row : undefined;
    return { store, identity, snapshot, pending };
  } catch (error) {
    await store.release();
    throw error;
  }
}

const owedMessage = (item: Owed) => ({
  role: "user",
  content: item.text,
  timestamp: Date.now(),
  idempotencyKey: item.id,
  provenance: { kind: "internal_system", sourceTool: item.kind },
  kind: item.kind,
  ...(item.originFacts ? { originFacts: item.originFacts } : {}),
});

/** The only writer of new owed rows. A second write of the same id keeps the first row. */
export async function owe(item: Owed): Promise<void> {
  const opened = await openOwed(item);
  if (!opened) {
    throw new Error("Owed result has no chat to wait in");
  }
  const { store, identity, snapshot } = opened;
  try {
    if (snapshot.existing || snapshot.committed) {
      return;
    }
    const message = owedMessage(item);
    await store.mutate(
      {
        ...identity,
        kind: "stage",
        expected: snapshot,
        trackCompletion: false,
        runId: item.id,
        requestHash: `owed:${item.id}`,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        inputId: randomUUID(),
        messageJson: JSON.stringify(message),
      },
      () => {},
    );
  } finally {
    await store.release();
  }
}

/**
 * One shared turn answers several owed results. In one transaction the first row takes their
 * joined text and the other rows are consumed, so each result is delivered exactly once even if
 * the Gateway stops at any point.
 */
export async function fold(first: Owed, others: readonly Owed[]): Promise<void> {
  const opened = await openOwed(first);
  if (!opened?.pending) {
    await opened?.store.release();
    return;
  }
  const { store, identity, snapshot, pending } = opened;
  try {
    await store.mutate(
      {
        ...identity,
        kind: "stage",
        expected: snapshot,
        trackCompletion: false,
        runId: pending.run_id,
        requestHash: pending.request_hash,
        lifecycleGeneration: pending.lifecycle_generation,
        inputId: pending.input_id,
        messageJson: JSON.stringify(owedMessage(first)),
        absorbedIdempotencyKeys: others.map((other) => other.id),
      },
      () => {},
    );
  } finally {
    await store.release();
  }
}

/** The stored item while its row is neither appended nor withheld; a folded row has joined text. */
export async function readPendingOwed(item: Owed): Promise<Owed | undefined> {
  const opened = await openOwed(item);
  await opened?.store.release();
  const content = opened?.pending && JSON.parse(opened.pending.message_json).content;
  return typeof content === "string" ? { ...item, text: content } : undefined;
}

/**
 * Ends a still-pending owed row; no-op once appended. `cancelled` shows the cause in the chat;
 * `interrupted` hides a row whose text another turn's input already carries.
 */
export async function withhold(
  item: Owed,
  cause: SessionPendingInputEndCause,
  disposition: "cancelled" | "interrupted" = "cancelled",
): Promise<void> {
  const opened = await openOwed(item);
  if (!opened) {
    return;
  }
  const { store, identity, pending } = opened;
  try {
    if (!pending) {
      return;
    }
    await store.mutate(
      {
        ...identity,
        kind: "finish",
        runId: pending.run_id,
        requestHash: pending.request_hash,
        lifecycleGeneration: pending.lifecycle_generation,
        inputId: pending.input_id,
        disposition,
        endCause: cause,
      },
      () => {},
    );
  } finally {
    await store.release();
  }
}

/** True while the chat has owed rows that no live turn holds: its next turn must append them. */
export async function shouldWake(chat: ChatRef): Promise<boolean> {
  const entry = await readSessionEntryReadOnlyInWorker({ ...chat });
  if (!entry) {
    return false;
  }
  const scope = { ...chat, sessionId: entry.sessionId };
  let before: number | undefined;
  do {
    const page = await readSessionQueuedInputPage(scope, { before });
    if (page.rows.some((row) => readOwedKind(row.message_json) !== undefined)) {
      return true;
    }
    before = page.nextBefore;
  } while (before !== undefined);
  return false;
}
