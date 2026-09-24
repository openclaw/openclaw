import { isDecisionAssistanceEligible } from "../agents/decision-assistance.js";
import {
  resolveScheduledToolPolicyContext,
  type ScheduledToolPolicyContext,
} from "../agents/scheduled-tool-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertCronJobScratchContent } from "../cron/scratch-contract.js";

const DOCUMENT_KIND = "openclaw-heartbeat-questions";
const QUESTION_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_QUESTIONS = 32;
const MAX_GROUPS = 16;

type HeartbeatQuestion = { id: string; question: string };
export type HeartbeatQuestionGroup = {
  id: string;
  commands: string[];
  questions: HeartbeatQuestion[];
  execution: {
    toolsAllow: string[];
    scheduledToolPolicy: ScheduledToolPolicyContext;
  };
};
export type HeartbeatQuestionDocument = {
  kind: typeof DOCUMENT_KIND;
  version: 2;
  notes: string;
  groups: HeartbeatQuestionGroup[];
};
export type HeartbeatQuestionParseResult =
  | { status: "legacy" | "valid"; document: HeartbeatQuestionDocument }
  | { status: "invalid"; error: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeQuestion(value: unknown): HeartbeatQuestion {
  if (!record(value) || typeof value.id !== "string" || !QUESTION_ID.test(value.id)) {
    throw new Error(
      "Heartbeat question IDs must use 1–64 letters, digits, underscores, or hyphens.",
    );
  }
  if (typeof value.question !== "string") {
    throw new Error("Heartbeat questions must be text.");
  }
  const question = value.question.trim();
  if (!question || question.length > 2000) {
    throw new Error("Heartbeat questions must contain 1–2000 characters after trimming.");
  }
  return { id: value.id, question };
}

function normalizeGroup(value: unknown): HeartbeatQuestionGroup {
  if (!record(value) || typeof value.id !== "string" || !QUESTION_ID.test(value.id)) {
    throw new Error("Heartbeat group IDs must use 1–64 letters, digits, underscores, or hyphens.");
  }
  if (
    !Array.isArray(value.commands) ||
    value.commands.length < 1 ||
    value.commands.length > 5 ||
    value.commands.some(
      (command) => typeof command !== "string" || !command.trim() || command.length > 4000,
    )
  ) {
    throw new Error("Each heartbeat group needs 1–5 commands of 1–4000 characters.");
  }
  if (
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > MAX_QUESTIONS
  ) {
    throw new Error(`Each heartbeat group needs 1–${MAX_QUESTIONS} questions.`);
  }
  const questions = value.questions.map(normalizeQuestion);
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new Error("Heartbeat question IDs must be unique within their group.");
  }
  const execution = record(value.execution) ? value.execution : undefined;
  const scheduledToolPolicy = resolveScheduledToolPolicyContext({
    toolsAllow: ["exec"],
    scheduledToolPolicy: execution?.scheduledToolPolicy,
  });
  if (
    !scheduledToolPolicy ||
    !Array.isArray(execution?.toolsAllow) ||
    execution.toolsAllow.length !== 1 ||
    execution.toolsAllow[0] !== "exec"
  ) {
    throw new Error(
      "Heartbeat command execution authority is missing. Re-save this group from an authorized agent turn.",
    );
  }
  return {
    id: value.id,
    commands: value.commands.map((command: string) => command.trim()),
    questions,
    execution: { toolsAllow: ["exec"], scheduledToolPolicy },
  };
}

function normalizeDocument(value: unknown): HeartbeatQuestionDocument {
  if (
    !record(value) ||
    value.kind !== DOCUMENT_KIND ||
    value.version !== 2 ||
    typeof value.notes !== "string" ||
    !Array.isArray(value.groups)
  ) {
    throw new Error("Invalid heartbeat question document: expected version 2, notes, and groups.");
  }
  if (value.groups.length > MAX_GROUPS) {
    throw new Error(`Heartbeat supports at most ${MAX_GROUPS} groups.`);
  }
  const groups = value.groups.map(normalizeGroup);
  if (new Set(groups.map((group) => group.id)).size !== groups.length) {
    throw new Error("Heartbeat group IDs must be unique.");
  }
  const document: HeartbeatQuestionDocument = {
    kind: DOCUMENT_KIND,
    version: 2,
    notes: value.notes,
    groups,
  };
  assertCronJobScratchContent(JSON.stringify(document));
  return document;
}

/**
 * Question mode requires its explicit heartbeat mode, Decision assistance opt-in, and the
 * owning agent's selected decisionModel. Otherwise heartbeats keep ordinary agent turns.
 */
export function isHeartbeatQuestionModeActive(
  config: OpenClawConfig,
  agentId: string,
  heartbeat: { mode?: string } | undefined,
): boolean {
  return heartbeat?.mode === "questions" && isDecisionAssistanceEligible(config, agentId);
}

/** Call only for question-mode heartbeats; ordinary scratch remains opaque prose. */
export function parseHeartbeatQuestionDocument(content = ""): HeartbeatQuestionParseResult {
  let parsed: unknown;
  try {
    assertCronJobScratchContent(content);
    try {
      parsed = JSON.parse(content);
    } catch {
      // A damaged envelope must not become an empty question list and silently suppress work.
      if (/^\s*\{/.test(content) && /"kind"\s*:\s*"openclaw-heartbeat-questions"/.test(content)) {
        throw new Error("Invalid heartbeat question document JSON.");
      }
    }
    if (record(parsed) && parsed.kind === DOCUMENT_KIND) {
      return { status: "valid", document: normalizeDocument(parsed) };
    }
    return {
      status: "legacy",
      document: { kind: DOCUMENT_KIND, version: 2, notes: content, groups: [] },
    };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

export function serializeHeartbeatQuestionDocument(document: HeartbeatQuestionDocument): string {
  return JSON.stringify(normalizeDocument(document));
}

export function upsertHeartbeatQuestionGroup(
  document: HeartbeatQuestionDocument,
  group: HeartbeatQuestionGroup,
): HeartbeatQuestionDocument {
  const normalized = normalizeDocument(document);
  const next = normalizeGroup(group);
  const index = normalized.groups.findIndex((entry) => entry.id === next.id);
  if (index < 0) {
    normalized.groups.push(next);
  } else {
    normalized.groups[index] = next;
  }
  return normalizeDocument(normalized);
}

export function removeHeartbeatQuestionGroup(
  document: HeartbeatQuestionDocument,
  id: string,
): HeartbeatQuestionDocument {
  if (!QUESTION_ID.test(id)) {
    throw new Error(
      "Heartbeat question IDs must use 1–64 letters, digits, underscores, or hyphens.",
    );
  }
  const normalized = normalizeDocument(document);
  return {
    ...normalized,
    groups: normalized.groups.filter((group) => group.id !== id),
  };
}
