// Claude CLI session history importer.
// Converts Claude project JSONL into OpenClaw transcript-compatible messages.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  asFiniteNumber,
  parseDateStringTimestampMs,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  readCliImageTurnContext,
  stripCliImageTurnContext,
} from "../agents/cli-image-turn-correlation.js";
import { hashCliReseedPrompt, parseCliReseedPrompt } from "../agents/cli-runner/reseed-envelope.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import { redactTranscriptMessage } from "../agents/transcript-redact.js";
import {
  isToolCallBlock,
  isToolResultBlock,
  resolveToolUseId,
  type ToolContentBlock,
} from "../chat/tool-content.js";
import type { CliSessionReseedReceipt, SessionEntry } from "../config/sessions.js";
import {
  getCliSessionBinding,
  normalizeCliSessionReseedReceipt,
} from "../config/sessions/cli-session-binding.js";
import { attachOpenClawTranscriptMeta } from "./session-transcript-readers.js";

export const CLAUDE_CLI_PROVIDER = "claude-cli";
const CLAUDE_PROJECTS_RELATIVE_DIR = path.join(".claude", "projects");

export type ClaudeCliProjectEntry = {
  type?: unknown;
  subtype?: unknown;
  content?: unknown;
  summary?: unknown;
  timestamp?: unknown;
  uuid?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  isVisibleInTranscriptOnly?: unknown;
  origin?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    model?: unknown;
    stop_reason?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
};

type ClaudeCliMessage = NonNullable<ClaudeCliProjectEntry["message"]>;
type ClaudeCliUsage = ClaudeCliMessage["usage"];
type TranscriptLikeMessage = Record<string, unknown>;
type ToolNameRegistry = Map<string, string>;
type ReseedImportState = {
  receipt?: CliSessionReseedReceipt;
  inspectedFirstUser: boolean;
};

export function decodeClaudeCliProjectEntry(line: string): ClaudeCliProjectEntry {
  return JSON.parse(line) as ClaudeCliProjectEntry;
}

export function redactClaudeCliHistoryMessage(
  message: TranscriptLikeMessage,
): TranscriptLikeMessage {
  return redactTranscriptMessage(
    message as unknown as AgentMessage,
  ) as unknown as TranscriptLikeMessage;
}

function resolveHistoryHomeDir(homeDir?: string): string {
  return normalizeOptionalString(homeDir) || process.env.HOME || os.homedir();
}

function resolveClaudeProjectsDir(homeDir?: string): string {
  return path.join(resolveHistoryHomeDir(homeDir), CLAUDE_PROJECTS_RELATIVE_DIR);
}

function normalizeClaudeCliSessionId(value: string): string | undefined {
  const sessionId = value.trim();
  return !sessionId ||
    sessionId === "." ||
    sessionId === ".." ||
    path.isAbsolute(sessionId) ||
    sessionId.includes("/") ||
    sessionId.includes("\\")
    ? undefined
    : sessionId;
}

function resolveClaudeSessionCandidate(projectDir: string, sessionId: string): string | undefined {
  const candidate = path.resolve(projectDir, `${sessionId}.jsonl`);
  return candidate.startsWith(`${path.resolve(projectDir)}${path.sep}`) ? candidate : undefined;
}

export function createClaudeReseedImportState(params: {
  localSessionId?: string;
  reseedReceipt?: CliSessionReseedReceipt;
}): ReseedImportState {
  const localSessionId = normalizeOptionalString(params.localSessionId);
  const normalizedReceipt = normalizeCliSessionReseedReceipt(params.reseedReceipt);
  return {
    receipt:
      normalizedReceipt && normalizedReceipt.localSessionId === localSessionId
        ? normalizedReceipt
        : undefined,
    inspectedFirstUser: false,
  };
}

export function resolveClaudeCliBindingSessionId(
  entry: SessionEntry | undefined,
): string | undefined {
  return getCliSessionBinding(entry, CLAUDE_CLI_PROVIDER)?.sessionId;
}

export function resolveClaudeCliTimestampMs(value: unknown): number | undefined {
  return parseDateStringTimestampMs(value);
}

function resolveClaudeCliUsage(raw: ClaudeCliUsage) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const input = asFiniteNumber(raw.input_tokens);
  const output = asFiniteNumber(raw.output_tokens);
  const cacheRead = asFiniteNumber(raw.cache_read_input_tokens);
  const cacheWrite = asFiniteNumber(raw.cache_creation_input_tokens);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function removeContentBlock<T>(content: T[], blockIndex: number): T[] | null {
  const nextContent = structuredClone(content);
  nextContent.splice(blockIndex, 1);
  return nextContent.length > 0 ? nextContent : null;
}

function normalizeClaudeCliContent(
  content: string | unknown[],
  toolNameRegistry: ToolNameRegistry,
): string | unknown[] {
  if (!Array.isArray(content)) {
    return content;
  }

  const normalized: ToolContentBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      normalized.push(structuredClone(item as ToolContentBlock));
      continue;
    }
    const block = structuredClone(item as ToolContentBlock);
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "tool_use") {
      // Claude stores tool calls as `tool_use` with `input`; OpenClaw history
      // expects `toolcall` plus `arguments` so replay remains provider-neutral.
      const id = normalizeOptionalString(block.id) ?? "";
      const name = normalizeOptionalString(block.name) ?? "";
      if (id && name) {
        toolNameRegistry.set(id, name);
      }
      if (block.input !== undefined && block.arguments === undefined) {
        block.arguments = structuredClone(block.input);
      }
      block.type = "toolcall";
      delete block.input;
    } else if (type === "tool_result") {
      const toolUseId = resolveToolUseId(block);
      if (!block.name && toolUseId) {
        const toolName = toolNameRegistry.get(toolUseId);
        if (toolName) {
          block.name = toolName;
        }
      }
    }
    normalized.push(block);
  }
  return normalized;
}

function coalesceClaudeCliToolMessages(messages: TranscriptLikeMessage[]): TranscriptLikeMessage[] {
  const coalesced: TranscriptLikeMessage[] = [];
  for (const message of messages) {
    appendCoalescedClaudeCliToolMessage(coalesced, message);
  }
  return coalesced;
}

export function appendCoalescedClaudeCliToolMessage(
  messages: TranscriptLikeMessage[],
  message: TranscriptLikeMessage,
): void {
  const prior = messages.at(-1);
  const callBlocks =
    prior?.role === "assistant" && Array.isArray(prior.content) ? prior.content : [];
  const resultBlocks =
    message.role === "user" && Array.isArray(message.content) ? message.content : [];
  if (
    callBlocks.length > 0 &&
    callBlocks.every(isToolCallBlock) &&
    resultBlocks.length > 0 &&
    resultBlocks.every(isToolResultBlock)
  ) {
    const callIds = new Set(
      callBlocks.map(resolveToolUseId).filter((id): id is string => Boolean(id)),
    );
    const allResultsMatch = resultBlocks.every((block) => {
      const toolUseId = resolveToolUseId(block);
      return Boolean(toolUseId && callIds.has(toolUseId));
    });
    if (allResultsMatch) {
      messages[messages.length - 1] = {
        ...prior,
        content: [...callBlocks, ...resultBlocks].map((block) => structuredClone(block)),
      };
      return;
    }
  }
  messages.push(message);
}

type ClaudeCliPromptTextCandidate = {
  text: string;
  blockIndex?: number;
};

// Claude keeps compact summaries and transcript-only rows as visible harness
// context. isMeta rows are private injections and never reach this projection.
function isClaudeCliVisibleHarnessContext(entry: ClaudeCliProjectEntry): boolean {
  return entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true;
}

function isClaudeCliTaskNotification(
  entry: ClaudeCliProjectEntry,
  content: string | unknown[],
): boolean {
  // Native origin establishes authorship; operator-pasted XML must stay a user turn.
  return (
    isRecord(entry.origin) &&
    entry.origin.kind === "task-notification" &&
    typeof content === "string" &&
    content.startsWith("<task-notification>") &&
    content.endsWith("</task-notification>")
  );
}

export function resolveClaudeCliPromptTextCandidates(
  entry: ClaudeCliProjectEntry,
  content: string | unknown[],
): ClaudeCliPromptTextCandidate[] {
  if (entry.isMeta === true || isClaudeCliVisibleHarnessContext(entry)) {
    return [];
  }
  if (typeof content === "string") {
    return [{ text: content }];
  }
  if (
    content.some(
      (item) =>
        item !== null && typeof item === "object" && "type" in item && item.type === "tool_result",
    )
  ) {
    return [];
  }
  return content.flatMap((item, blockIndex) =>
    item !== null &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string"
      ? [{ text: item.text, blockIndex }]
      : [],
  );
}

export function parseClaudeCliHistoryEntry(
  entry: ClaudeCliProjectEntry,
  cliSessionId: string,
  sourceLineNumber: number,
  toolNameRegistry: ToolNameRegistry,
  options: {
    reseedMode: "recover" | "preserve";
    reseedState?: ReseedImportState;
  },
): TranscriptLikeMessage | null {
  if (
    entry.isSidechain === true ||
    entry.isMeta === true ||
    !entry.message ||
    typeof entry.message !== "object"
  ) {
    return null;
  }
  const type = typeof entry.type === "string" ? entry.type : undefined;
  const role = typeof entry.message.role === "string" ? entry.message.role : undefined;
  if ((type !== "user" && type !== "assistant") || role !== type) {
    return null;
  }

  const timestamp = resolveClaudeCliTimestampMs(entry.timestamp);
  const externalId = normalizeOptionalString(entry.uuid);
  const baseMeta = {
    id: externalId ?? `${CLAUDE_CLI_PROVIDER}:${cliSessionId}:line:${sourceLineNumber}`,
    importedFrom: CLAUDE_CLI_PROVIDER,
    cliSessionId,
    ...(externalId ? { externalId } : {}),
  };

  let content =
    typeof entry.message.content === "string" || Array.isArray(entry.message.content)
      ? normalizeClaudeCliContent(entry.message.content, toolNameRegistry)
      : undefined;
  if (content === undefined) {
    return null;
  }

  if (type === "user") {
    const reseedState = options.reseedState;
    const promptTextCandidates = resolveClaudeCliPromptTextCandidates(entry, content);
    if (
      options.reseedMode === "recover" &&
      reseedState &&
      !reseedState.inspectedFirstUser &&
      promptTextCandidates.length > 0
    ) {
      reseedState.inspectedFirstUser = true;
      if (reseedState.receipt) {
        // The binding is trusted state for this native session. Do not scan
        // later rows or a repeated user message could be suppressed.
        const candidate = promptTextCandidates.length === 1 ? promptTextCandidates[0] : undefined;
        if (candidate && hashCliReseedPrompt(candidate.text) === reseedState.receipt.promptHash) {
          if (candidate.blockIndex === undefined || !Array.isArray(content)) {
            return null;
          }
          // The receipt proves only the matching text block is synthetic.
          // Preserve sibling images or other native content that has no local duplicate proof.
          const nextContent = removeContentBlock(content, candidate.blockIndex);
          if (!nextContent) {
            return null;
          }
          content = nextContent;
        }
      } else {
        for (const candidate of promptTextCandidates) {
          const reseedPrompt = parseCliReseedPrompt(candidate.text);
          if (reseedPrompt.kind === "legacy") {
            if (candidate.blockIndex === undefined) {
              if (!reseedPrompt.userMessage) {
                return null;
              }
              content = reseedPrompt.userMessage;
            } else if (Array.isArray(content)) {
              if (!reseedPrompt.userMessage) {
                const contentWithoutReseed = removeContentBlock(content, candidate.blockIndex);
                if (!contentWithoutReseed) {
                  return null;
                }
                content = contentWithoutReseed;
                break;
              }
              const nextContent = structuredClone(content);
              const block = nextContent[candidate.blockIndex];
              if (block && typeof block === "object") {
                (block as Record<string, unknown>).text = reseedPrompt.userMessage;
              }
              content = nextContent;
            }
            break;
          }
        }
      }
    }
    const cliImageTurnKey =
      typeof content === "string" ? readCliImageTurnContext(content) : undefined;
    if (cliImageTurnKey && typeof content === "string") {
      content = stripCliImageTurnContext(content, cliImageTurnKey);
    }
    // Record provenance here, where the native row shape is known, so downstream
    // display never has to infer operator authorship from message text.
    const sourceTool = isClaudeCliTaskNotification(entry, content)
      ? "claude_cli_task_notification"
      : isClaudeCliVisibleHarnessContext(entry)
        ? "cli_harness_context"
        : undefined;
    return attachOpenClawTranscriptMeta(
      {
        role: "user",
        content,
        ...(sourceTool ? { provenance: { kind: "internal_system", sourceTool } } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
      },
      { ...baseMeta, ...(cliImageTurnKey ? { cliImageTurnKey } : {}) },
    ) as TranscriptLikeMessage;
  }

  const usage = resolveClaudeCliUsage(entry.message.usage);
  return attachOpenClawTranscriptMeta(
    {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: CLAUDE_CLI_PROVIDER,
      ...(normalizeOptionalString(entry.message.model) ? { model: entry.message.model } : {}),
      ...(normalizeOptionalString(entry.message.stop_reason)
        ? { stopReason: entry.message.stop_reason }
        : {}),
      ...(usage ? { usage } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    },
    baseMeta,
  ) as TranscriptLikeMessage;
}

function resolveClaudeCliSessionFilePath(params: {
  cliSessionId: string;
  homeDir?: string;
}): string | undefined {
  const sessionId = normalizeClaudeCliSessionId(params.cliSessionId);
  if (!sessionId) {
    return undefined;
  }
  const projectsDir = resolveClaudeProjectsDir(params.homeDir);
  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of projectEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const projectDir = path.join(projectsDir, entry.name);
    const candidate = resolveClaudeSessionCandidate(projectDir, sessionId);
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function resolveClaudeCliSessionFilePathAsync(params: {
  cliSessionId: string;
  homeDir?: string;
}): Promise<string | undefined> {
  const sessionId = normalizeClaudeCliSessionId(params.cliSessionId);
  if (!sessionId) {
    return undefined;
  }
  const projectsDir = resolveClaudeProjectsDir(params.homeDir);
  let projectEntries: fs.Dirent[];
  try {
    projectEntries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  // Bound filesystem work while preserving the first match in directory order.
  const batchSize = 16;
  for (let offset = 0; offset < projectEntries.length; offset += batchSize) {
    const candidates = await Promise.all(
      projectEntries.slice(offset, offset + batchSize).map(async (entry) => {
        if (!entry.isDirectory()) {
          return undefined;
        }
        const candidate = resolveClaudeSessionCandidate(
          path.join(projectsDir, entry.name),
          sessionId,
        );
        if (!candidate) {
          return undefined;
        }
        try {
          await fs.promises.access(candidate);
          return candidate;
        } catch {
          return undefined;
        }
      }),
    );
    const candidate = candidates.find((value) => value !== undefined);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

/** Reads visible messages for a bound Claude CLI session. */
export function readClaudeCliSessionMessages(params: {
  cliSessionId: string;
  homeDir?: string;
  localSessionId?: string;
  reseedReceipt?: CliSessionReseedReceipt;
}): TranscriptLikeMessage[] {
  const filePath = resolveClaudeCliSessionFilePath(params);
  if (!filePath) {
    return [];
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const messages: TranscriptLikeMessage[] = [];
  const toolNameRegistry: ToolNameRegistry = new Map();
  const reseedState = createClaudeReseedImportState(params);
  const lines = content.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = decodeClaudeCliProjectEntry(line);
      const message = parseClaudeCliHistoryEntry(
        parsed,
        params.cliSessionId,
        lineIndex + 1,
        toolNameRegistry,
        {
          reseedMode: "recover",
          reseedState,
        },
      );
      if (message) {
        messages.push(message);
      }
    } catch {
      // Ignore malformed external history entries.
    }
  }
  const visibleMessages = coalesceClaudeCliToolMessages(messages);
  // Match local transcript persistence before dedupe so imported secrets cannot
  // bypass exact-text matching or reach chat history through the external copy.
  return visibleMessages.map(redactClaudeCliHistoryMessage);
}

export type ClaudeCliFallbackSeed = {
  summaryText?: string;
  recentTurns: TranscriptLikeMessage[];
};

export function readClaudeCliFallbackSeed(params: {
  cliSessionId: string;
  homeDir?: string;
}): ClaudeCliFallbackSeed | undefined {
  const filePath = resolveClaudeCliSessionFilePath(params);
  if (!filePath) {
    return undefined;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }

  let pendingSummary: string | undefined;
  let lastSummary: string | undefined;
  let lastBoundaryFallback: string | undefined;
  let windowedTurns: TranscriptLikeMessage[] = [];
  const toolNameRegistry: ToolNameRegistry = new Map();

  const lines = content.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    if (!line.trim()) {
      continue;
    }
    let parsed: ClaudeCliProjectEntry;
    try {
      parsed = decodeClaudeCliProjectEntry(line);
    } catch {
      continue;
    }

    const explicitSummary =
      parsed.type === "summary" ? normalizeOptionalString(parsed.summary) : undefined;
    if (explicitSummary) {
      pendingSummary = explicitSummary;
      continue;
    }

    if (parsed.type === "system" && parsed.subtype === "compact_boundary") {
      // Compact boundaries split Claude history into context windows. Keep the
      // latest summary plus only post-boundary turns for fallback seeding.
      lastSummary = pendingSummary;
      pendingSummary = undefined;
      lastBoundaryFallback = normalizeOptionalString(parsed.content) ?? lastBoundaryFallback;
      windowedTurns = [];
      toolNameRegistry.clear();
      continue;
    }

    const message = parseClaudeCliHistoryEntry(
      parsed,
      params.cliSessionId,
      lineIndex + 1,
      toolNameRegistry,
      {
        reseedMode: "preserve",
      },
    );
    if (message) {
      windowedTurns.push(message);
    }
  }

  const recentTurns = coalesceClaudeCliToolMessages(windowedTurns);
  const resolvedSummaryText = lastSummary ?? pendingSummary ?? lastBoundaryFallback;
  if (!resolvedSummaryText && recentTurns.length === 0) {
    return undefined;
  }
  return {
    ...(resolvedSummaryText ? { summaryText: resolvedSummaryText } : {}),
    recentTurns,
  };
}
