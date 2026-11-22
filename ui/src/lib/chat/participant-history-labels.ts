import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionParticipant } from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import { resolveMessageSender, sessionParticipantIdentityKey } from "./sender-label.ts";

/** Older sessions may retain names in their already-loaded messages. This labels only
 * an existing exact source; it does not add people, establish links, or fetch history. */
export function withParticipantHistoryLabels(
  people: readonly SessionParticipant[],
  history: () => readonly unknown[],
): readonly SessionParticipant[] {
  const missing = new Set(
    people.flatMap(({ identity, label }) =>
      !label && (identity.type === "observation" || identity.type === "remote")
        ? [sessionParticipantIdentityKey(identity)]
        : [],
    ),
  );
  if (!missing.size) return people;
  const labels = new Map<string, string>();
  const messages = history();
  for (let i = messages.length - 1; i >= 0 && missing.size; i--) {
    const message = asOptionalRecord(messages[i]);
    if (message?.role !== "user") continue;
    const sender = resolveMessageSender(asOptionalRecord(message.__openclaw));
    if (!sender?.identity || sender.identity.id !== sender.id) continue;
    const name = sender.name || sender.username;
    if (!name) continue;
    const key = sessionParticipantIdentityKey(sender.identity);
    if (missing.delete(key)) labels.set(key, name);
  }
  return labels.size
    ? people.map((p) => {
        const label = !p.label && labels.get(sessionParticipantIdentityKey(p.identity));
        return label ? { ...p, label } : p;
      })
    : people;
}
