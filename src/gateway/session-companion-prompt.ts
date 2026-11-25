import { SESSION_COMPANION_MAX_EXCHANGE_BYTES } from "../../packages/gateway-protocol/src/session-companion-contract.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import {
  selectSessionCompanionReferenceItems,
  type SessionCompanionThread,
} from "./session-companion-state.js";
import type { SessionObserverCompanionSnapshot } from "./session-observer-contract.js";

const DELTA_MAX_BYTES = 4 * 1024;

export type SessionCompanionPromptMessage = {
  role: "user" | "assistant";
  content: string;
  ts: number;
};

const PRIVATE_REFERENCE_BEGIN = "<private-session-reference>";
const PRIVATE_REFERENCE_END = "</private-session-reference>";

function escapeReferenceText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function formatObserverDigest(snapshot: SessionObserverCompanionSnapshot): string {
  const digest = snapshot.digest;
  if (!digest) {
    return "No observer status is available.";
  }
  return [
    `Status: ${digest.health}.`,
    `Headline: ${digest.headline}`,
    digest.assessment ? `Assessment: ${digest.assessment}` : "",
    digest.planProgress
      ? `Plan progress: ${digest.planProgress.completed} of ${digest.planProgress.total}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildReferenceContext(params: {
  thread: SessionCompanionThread;
  deltaNotes: SessionObserverCompanionSnapshot["notes"];
}): string {
  const history =
    params.thread.context.messages.length === 0
      ? params.thread.context.empty
        ? "The selected session has no messages."
        : "No bounded user/assistant transcript text was available; use the permitted session tools when needed."
      : params.thread.context.messages
          .map((message) => {
            const label = message.role === "assistant" ? "Assistant" : "Operator";
            return `${label}: ${escapeReferenceText(message.text)}`;
          })
          .join("\n");
  const notes =
    params.deltaNotes.length === 0
      ? "No new observer notes."
      : params.deltaNotes.map((note) => `- ${escapeReferenceText(note.text)}`).join("\n");
  return [
    PRIVATE_REFERENCE_BEGIN,
    "Selected session transcript:",
    history,
    "Selected session status:",
    escapeReferenceText(params.thread.digestText),
    "New observer notes:",
    notes,
    PRIVATE_REFERENCE_END,
  ].join("\n");
}

export function selectDeltaNotes(
  snapshot: SessionObserverCompanionSnapshot,
  afterSequence: number,
): {
  notes: SessionObserverCompanionSnapshot["notes"];
  lastSequence: number;
} {
  const candidates = snapshot.notes
    .filter((note) => note.sequence > afterSequence)
    // oxlint-disable-next-line unicorn/no-array-sort -- filter creates a private array, preserving snapshot note order.
    .sort((left, right) => left.sequence - right.sequence);
  return {
    notes: selectSessionCompanionReferenceItems(candidates.toReversed(), DELTA_MAX_BYTES),
    lastSequence: candidates.at(-1)?.sequence ?? afterSequence,
  };
}

export function composePromptMessages(params: {
  thread: SessionCompanionThread;
  question: string;
  selectionContext?: string;
  referenceContext: string;
  now: number;
}): SessionCompanionPromptMessage[] {
  const messages: SessionCompanionPromptMessage[] = [
    { role: "assistant", content: params.referenceContext, ts: params.now },
  ];
  for (const exchange of params.thread.exchanges) {
    messages.push({ role: "user", content: exchange.question, ts: exchange.ts });
    messages.push({ role: "assistant", content: exchange.answer, ts: exchange.ts });
  }
  messages.push({
    role: "user",
    content: params.selectionContext
      ? `${params.question}\n\n<selected-text-context>\n${escapeReferenceText(params.selectionContext)}\n</selected-text-context>`
      : params.question,
    ts: params.now,
  });
  return messages;
}

export function sanitizeAnswer(value: string, question: string): string {
  const redacted = value.trim();
  if (redacted.includes(PRIVATE_REFERENCE_BEGIN) || redacted.includes(PRIVATE_REFERENCE_END)) {
    return "";
  }
  const budget = SESSION_COMPANION_MAX_EXCHANGE_BYTES - Buffer.byteLength(question);
  if (Buffer.byteLength(redacted) <= budget) {
    return redacted;
  }
  const notice = "Side chat shortened this answer. Ask for a smaller section.";
  const prefix = truncateUtf8Prefix(redacted, budget - Buffer.byteLength(notice) - 2);
  // Never turn the partial tail of a URL into a different clickable destination.
  let end = prefix.length;
  if (!/\s/u.test(redacted[end] ?? "")) {
    while (end > 0 && !/\s/u.test(prefix[end - 1]!)) {
      end -= 1;
    }
  }
  const complete = prefix.slice(0, end).trimEnd();
  return complete ? `${complete}\n\n${notice}` : notice;
}
