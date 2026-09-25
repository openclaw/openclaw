import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactToolPayloadText } from "../logging/redact.js";
import type { SessionCompanionThread } from "./session-companion-state.js";
import type { SessionObserverCompanionSnapshot } from "./session-observer-contract.js";

const ANSWER_MAX_CHARS = 1200;
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
  deltaNotes: Array<{ sequence: number; text: string }>;
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
  notes: Array<{ sequence: number; text: string }>;
  lastSequence: number;
} {
  const candidates = snapshot.notes
    .filter((note) => note.sequence > afterSequence)
    .toSorted((left, right) => left.sequence - right.sequence);
  const selected: Array<{ sequence: number; text: string }> = [];
  let bytes = 2;
  for (const note of candidates.toReversed()) {
    const noteBytes = Buffer.byteLength(JSON.stringify(note), "utf8") + 1;
    if (bytes + noteBytes > DELTA_MAX_BYTES) {
      break;
    }
    selected.unshift(note);
    bytes += noteBytes;
  }
  return {
    notes: selected,
    lastSequence: candidates.at(-1)?.sequence ?? afterSequence,
  };
}

export function composePromptMessages(params: {
  thread: SessionCompanionThread;
  question: string;
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
    content: params.question,
    ts: params.now,
  });
  return messages;
}

function isPrivateReferenceEcho(value: string): boolean {
  return value.includes(PRIVATE_REFERENCE_BEGIN) || value.includes(PRIVATE_REFERENCE_END);
}

export function sanitizeAnswer(value: string): string {
  const redacted = redactToolPayloadText(value).trim();
  if (isPrivateReferenceEcho(redacted)) {
    return "";
  }
  return truncateUtf16Safe(redacted, ANSWER_MAX_CHARS);
}
