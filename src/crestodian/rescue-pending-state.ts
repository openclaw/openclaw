import { createHash } from "node:crypto";
import {
  createCorePluginStateKeyedStore,
  type PluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import type { CrestodianOperation } from "./operations.js";

export type RescuePendingOperation = {
  id: string;
  createdAt: string;
  expiresAt: string;
  operation: CrestodianOperation;
  auditDetails: Record<string, unknown>;
};

export const CRESTODIAN_RESCUE_PENDING_OWNER_ID = "core:crestodian";
export const CRESTODIAN_RESCUE_PENDING_NAMESPACE = "rescue-pending";
export const CRESTODIAN_RESCUE_PENDING_MAX_ENTRIES = 10_000;

export function createCrestodianRescuePendingStore(): PluginStateKeyedStore<RescuePendingOperation> {
  return createCorePluginStateKeyedStore<RescuePendingOperation>({
    ownerId: CRESTODIAN_RESCUE_PENDING_OWNER_ID,
    namespace: CRESTODIAN_RESCUE_PENDING_NAMESPACE,
    maxEntries: CRESTODIAN_RESCUE_PENDING_MAX_ENTRIES,
  });
}

export function resolveCrestodianRescuePendingKey(params: {
  channel?: string;
  from?: string;
  senderId?: string;
}): string {
  const key = JSON.stringify({
    channel: params.channel,
    from: params.from,
    senderId: params.senderId,
  });
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export function isRescuePendingOperation(value: unknown): value is RescuePendingOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.expiresAt === "string" &&
    !!record.operation &&
    typeof record.operation === "object" &&
    !Array.isArray(record.operation) &&
    !!record.auditDetails &&
    typeof record.auditDetails === "object" &&
    !Array.isArray(record.auditDetails)
  );
}
