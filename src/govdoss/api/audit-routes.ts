import { registerRealtimeClient } from "./realtime.js";
import { govdossAuditStore } from "../audit-store.js";

export function handleAuditListRoute(input: { tenantId?: string }) {
  return govdossAuditStore.listByTenant(input.tenantId, 200);
}

export function handleRealtimeStreamRoute(res: any) {
  registerRealtimeClient(res);
}
