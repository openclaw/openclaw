import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { stripAssistantInternalScaffolding } from "../shared/text/assistant-visible-text.js";
import type { ContinuityCaptureInput, ContinuityExtractionMatch } from "./types.js";

const EXPLICIT_REMEMBER_RE =
  /\b(?:remember this|remember that|please remember|make a note|note that)\b/i;
const PREFERENCE_RE =
  /\b(?:i prefer|i like|i love|i hate|i don't like|i do not like|please keep|keep replies|prefer .* updates?)\b/i;
const DECISION_RE = /\b(?:we decided|let'?s use|we will use|switch to|use .* for|settled on)\b/i;
const OPEN_LOOP_RE =
  /\b(?:todo|follow up|next step|need to|still need to|pending|remind me|later today|circle back)\b/i;
const FACT_RE =
  /\b(?:my name is|my email is|my phone|our project codename is|project codename is|timezone is|deadline is)\b/i;
const ASSISTANT_COMMITMENT_RE = /\b(?:i will|i'll|next step|i can follow up|todo|follow up)\b/i;
const PROMPT_INJECTION_PATTERNS = [
  /ignore (?:all|any|previous|above|prior) instructions/i,
  /do not follow (?:the )?(?:system|developer)/i,
  /system prompt/i,
  /developer message/i,
  /<\s*(?:system|assistant|developer|tool|function|relevant-memories)\b/i,
  /\b(?:run|execute|call|invoke)\b.{0,40}\b(?:tool|command)\b/i,
];

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeText(text: string, role: "user" | "assistant"): string {
  const base =
    role === "assistant" ? stripAssistantInternalScaffolding(text) : text.replace(/<[^>]+>/g, " ");
  return normalizeSpaces(base);
}

function looksLikePromptInjection(text: string): boolean {
  if (!text) {
    return false;
  }
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function extractMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  const text = extractTextFromChatContent(content ?? "", {
    sanitizeText: (value) => value,
  });
  return typeof text === "string" ? text : "";
}

function firstSentence(text: string): string {
  let boundary = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") {
      continue;
    }
    const next = text[i + 1];
    if (!next || /\s/.test(next)) {
      boundary = i + 1;
      break;
    }
  }
  const candidate = normalizeSpaces(boundary >= 0 ? text.slice(0, boundary) : text);
  return candidate.length > 280 ? `${candidate.slice(0, 277)}...` : candidate;
}

function matchContinuity(text: string, role: "user" | "assistant"): ContinuityExtractionMatch[] {
  const normalized = sanitizeText(text, role);
  if (!normalized || looksLikePromptInjection(normalized)) {
    return [];
  }
  const matches: ContinuityExtractionMatch[] = [];
  if (role === "user") {
    if (EXPLICIT_REMEMBER_RE.test(normalized) || FACT_RE.test(normalized)) {
      matches.push({ kind: "fact", text: firstSentence(normalized), confidence: 0.94, role });
    }
    if (PREFERENCE_RE.test(normalized)) {
      matches.push({ kind: "preference", text: firstSentence(normalized), confidence: 0.9, role });
    }
    if (DECISION_RE.test(normalized)) {
      matches.push({ kind: "decision", text: firstSentence(normalized), confidence: 0.88, role });
    }
    if (OPEN_LOOP_RE.test(normalized)) {
      matches.push({ kind: "open_loop", text: firstSentence(normalized), confidence: 0.82, role });
    }
  } else if (ASSISTANT_COMMITMENT_RE.test(normalized)) {
    const kind = OPEN_LOOP_RE.test(normalized) ? "open_loop" : "decision";
    matches.push({ kind, text: firstSentence(normalized), confidence: 0.76, role });
  }
  return matches;
}

export function extractContinuityMatches(
  params: ContinuityCaptureInput,
): ContinuityExtractionMatch[] {
  const matches: ContinuityExtractionMatch[] = [];
  for (const message of params.messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    const text = extractMessageText(message);
    if (!text) {
      continue;
    }
    matches.push(...matchContinuity(text, message.role));
  }
  return matches;
}
