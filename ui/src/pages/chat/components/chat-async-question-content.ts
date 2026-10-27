import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { QuestionDraft } from "../../../app/question-prompt.ts";
import type { AsyncQuestions } from "./chat-async-question.types.ts";

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && value.trim().length > 0;
}

export function readAsyncQuestions(message: unknown): AsyncQuestions | null {
  if (!isRecord(message) || message.role !== "assistant") {
    return null;
  }
  const metadata = message.openclawAsyncDelivery;
  if (
    !isRecord(metadata) ||
    !boundedText(metadata.itemId, 256) ||
    !Array.isArray(metadata.questions) ||
    metadata.questions.length === 0 ||
    metadata.questions.length > 12
  ) {
    return null;
  }
  const questions: AsyncQuestions["questions"] = [];
  for (const question of metadata.questions) {
    if (
      !isRecord(question) ||
      !boundedText(question.title, 4096) ||
      (question.options !== undefined &&
        (!Array.isArray(question.options) ||
          question.options.length === 0 ||
          question.options.length > 4 ||
          !question.options.every((option) => boundedText(option, 256))))
    ) {
      return null;
    }
    questions.push({ title: question.title, options: question.options });
  }
  const identity = readSessionMessageIdentity(message);
  const sourceMessageId =
    identity?.id && identity.sequence !== null && !identity.isImported ? identity.id : undefined;
  return { itemId: metadata.itemId, ...(sourceMessageId ? { sourceMessageId } : {}), questions };
}

export function parseGeneratedAsyncAnswer(
  question: AsyncQuestions,
  message: string,
): Map<string, QuestionDraft> | null {
  if (!message.startsWith("> ")) {
    return null;
  }
  let offset = 0;
  const answers = new Map<string, QuestionDraft>();
  for (const [index, current] of question.questions.entries()) {
    const prefix = `${quoteQuestion(current.title)}\n\n`;
    if (!message.startsWith(prefix, offset)) {
      return null;
    }
    offset += prefix.length;
    const next = question.questions[index + 1];
    const separator = next ? `\n\n${quoteQuestion(next.title)}\n\n` : undefined;
    const answerEnd = separator ? message.indexOf(separator, offset) : message.length;
    // Free text can contain quoted headings. Do not guess a section boundary.
    if (
      answerEnd < offset ||
      (separator && message.includes(separator, answerEnd + separator.length))
    ) {
      return null;
    }
    const answer = message.slice(offset, answerEnd);
    if (!answer.trim()) {
      return null;
    }
    const values = answer.split(", ");
    const selected = values.every((value) => current.options?.includes(value))
      ? new Set(values)
      : new Set<string>();
    answers.set(String(index), { selected, freeText: selected.size > 0 ? "" : answer });
    offset = answerEnd + (separator ? 2 : 0);
  }
  return offset === message.length ? answers : null;
}

export function quoteQuestion(title: string): string {
  const encoder = new TextEncoder();
  let quote = "";
  let bytes = 0;
  for (const character of title) {
    bytes += encoder.encode(character).length;
    if (bytes > 512) {
      break;
    }
    quote += character;
  }
  return `> ${quote.replace(/[\r\n]/g, " ")}`;
}
