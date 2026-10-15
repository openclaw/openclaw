import type { SessionProjectionEntry } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

/** Pairing media is delivered live; transcript and browser storage omit its setup secret. */
export function readPairingQrContent(message: unknown): Record<string, unknown>[] {
  const content = asNullableRecord(message)?.content;
  return Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> =>
          asNullableRecord(block)?.type === "openclaw_pairing_qr",
      )
    : [];
}

export function removePairingQrContent(message: unknown): unknown {
  const record = asNullableRecord(message);
  if (!record) {
    return message;
  }
  let result: Record<string, unknown> | undefined;
  for (const key of ["content", "openclawDisplayContent"]) {
    const original = record[key];
    if (!Array.isArray(original)) {
      continue;
    }
    const content = original.filter(
      (block) => asNullableRecord(block)?.type !== "openclaw_pairing_qr",
    );
    if (content.length !== original.length) {
      result ??= { ...record };
      result[key] = content;
    }
  }
  return result ?? message;
}

/** Enrich only admitted rows; canonical history still owns text, identity, and removal. */
export function retainPairingQrEntries(
  previous: readonly SessionProjectionEntry[],
  incoming: readonly SessionProjectionEntry[],
): readonly SessionProjectionEntry[] {
  const pairingById = new Map<string, Record<string, unknown>[]>();
  for (const { identity, message } of previous) {
    if (identity?.role === "assistant" && !identity.isImported && identity.id) {
      const qr = readPairingQrContent(message);
      if (qr.length) {
        pairingById.set(identity.id, qr);
      }
    }
  }
  if (!pairingById.size) {
    return incoming;
  }
  return incoming.map((entry) => {
    const { identity } = entry;
    const qr =
      identity?.role === "assistant" && !identity.isImported && identity.id
        ? pairingById.get(identity.id)
        : undefined;
    const message = asNullableRecord(entry.message);
    if (!qr || !Array.isArray(message?.content) || readPairingQrContent(message).length) {
      return entry;
    }
    return { ...entry, message: { ...message, content: [...message.content, ...qr] } };
  });
}
