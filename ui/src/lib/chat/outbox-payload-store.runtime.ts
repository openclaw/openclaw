import { readOfflineStorageScope, type OfflineStorageClient } from "../../app/boot-record.ts";
import type { ChatQueueItem, DurableComposerDraftAttachment } from "./chat-types.ts";

export type OutboxPayloadFailure = "capacity" | "unavailable" | "missing";
export type PayloadReference = NonNullable<ChatQueueItem["attachmentPayload"]>;
export type PayloadOwner = {
  tabId: string;
  gatewayOwner: string;
  recoveryScope: string;
  queueId: string;
};
export type PayloadResult<T> =
  | { status: "ready"; value: T }
  | { status: "failed"; reason: OutboxPayloadFailure };

export async function writeOutboxPayload(
  owner: PayloadOwner,
  attachments: DurableComposerDraftAttachment[],
): Promise<PayloadResult<PayloadReference>> {
  try {
    const runtime = await import("./outbox-payload-store.io.ts");
    return await runtime.writeOutboxPayload(owner, attachments);
  } catch {
    return { status: "failed", reason: "unavailable" };
  }
}

export async function readOutboxPayload(
  owner: PayloadOwner,
  reference: PayloadReference,
): Promise<PayloadResult<DurableComposerDraftAttachment[]>> {
  try {
    const runtime = await import("./outbox-payload-store.io.ts");
    return await runtime.readOutboxPayload(owner, reference);
  } catch {
    return { status: "failed", reason: "unavailable" };
  }
}

export async function removeOutboxPayloads(references: readonly PayloadReference[]): Promise<void> {
  try {
    const runtime = await import("./outbox-payload-store.io.ts");
    await runtime.removeOutboxPayloads(references);
  } catch {
    // Metadata retirement remains authoritative when optional cleanup cannot load.
  }
}

export async function outboxPayloadTab(): Promise<string> {
  const runtime = await import("./outbox-payload-store.io.ts");
  return runtime.outboxPayloadTab();
}

type RecoveryHost = {
  client?: OfflineStorageClient | null;
  connected?: boolean;
  settings?: { gatewayUrl?: string | null };
};
export function outboxStorageScope(host: RecoveryHost): string | undefined {
  const owner = readOfflineStorageScope(host);
  return owner
    ? JSON.stringify([host.settings?.gatewayUrl?.trim() || "default", owner])
    : undefined;
}

/** Explicit legacy review may assign unowned input, but never another account's input. */
export function outboxPayloadCanRecover(host: RecoveryHost, item: ChatQueueItem): boolean {
  return (
    (!item.storageScope || item.storageScope === outboxStorageScope(host)) &&
    (!item.attachmentPayload ||
      item.attachmentPayload.recoveryScope === readOfflineStorageScope(host))
  );
}

/** Normal projection and delivery require provenance captured by an admission owner. */
export function outboxPayloadMatchesOwner(host: RecoveryHost, item: ChatQueueItem): boolean {
  return Boolean(item.storageScope && outboxPayloadCanRecover(host, item));
}
