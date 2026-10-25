import type { GatewaySessionRow } from "../../api/types.ts";

export function sessionRow(key: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, sessionId: `${key}-id`, kind: "direct", updatedAt: 1, ...extra };
}
