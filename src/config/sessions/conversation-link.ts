import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionConversationLink } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";

/** Keep channel-supplied navigation safe at both ingress and persisted metadata reads. */
export function normalizeSessionConversationLink(
  value: unknown,
): SessionConversationLink | undefined {
  const record = asOptionalRecord(value);
  const url = typeof record?.url === "string" ? record.url.trim() : "";
  const label = typeof record?.label === "string" ? record.label.trim() : "";
  if (!url || url.length > 2048 || !label || label.length > 128) {
    return undefined;
  }
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return undefined;
  }
  return { url: parsed.href, label };
}
