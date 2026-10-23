import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  normalizeGatewayClientId,
  normalizeGatewayClientMode,
  type GatewayClientInfo,
} from "../../packages/gateway-protocol/src/client-info.js";

/** Reported transport facts, separate from authenticated sender identity. */
export type MessageClientSource = Pick<GatewayClientInfo, "id" | "mode" | "displayName">;

export function messageClientSourcesKey(sources: readonly MessageClientSource[]): string {
  return JSON.stringify(
    sources.map(({ id, mode, displayName }) => [id, mode, displayName ?? null]),
  );
}

export function normalizeMessageClientSources(value: unknown): MessageClientSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const sources = new Map<string, MessageClientSource>();
  for (const item of value) {
    const record = asOptionalRecord(item);
    const id = normalizeGatewayClientId(typeof record?.id === "string" ? record.id : undefined);
    const mode = normalizeGatewayClientMode(
      typeof record?.mode === "string" ? record.mode : undefined,
    );
    if (!id || !mode) {
      continue;
    }
    const name = normalizeOptionalString(record?.displayName);
    const source = {
      id,
      mode,
      ...(name ? { displayName: truncateUtf16Safe(name, 200) } : {}),
    };
    sources.set(messageClientSourcesKey([source]), source);
  }
  return [...sources.values()];
}

export function readMessageClientSources(message: unknown): MessageClientSource[] {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return normalizeMessageClientSources(asOptionalRecord(metadata?.transport)?.clients);
}
