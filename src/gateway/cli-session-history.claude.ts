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
import { stripCliSessionDriftNote } from "../agents/cli-session.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import { sanitizeTranscriptMessage } from "../agents/transcript-sanitize.js";
import { HEARTBEAT_PROMPT, HEARTBEAT_RESPONSE_TOOL_PROMPT } from "../auto-reply/heartbeat.js";
import { isToolCallBlock, isToolResultBlock, resolveToolUseId } from "../chat/tool-content.js";
import type { CliSessionReseedReceipt, SessionEntry } from "../config/sessions.js";
import {
  getCliSessionBinding,
  normalizeCliSessionReseedReceipt,
} from "../config/sessions/cli-session-binding.js";
import {
  type InputProvenance,
  readInterSessionPromptEnvelope,
} from "../sessions/input-provenance.js";
import { formatSystemTurnPrompt } from "../sessions/system-turn-prompt.js";
import { stripCliPromptDecorations } from "./cli-session-history.prompt-text.js";
import { attachOpenClawTranscriptMeta } from "./session-transcript-readers.js";

const CLAUDE_CLI_PROVIDER = "claude-cli";
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
  const entry: unknown = JSON.parse(line);
  if (!isRecord(entry)) {
    throw new Error("Claude history row must be an object");
  }
  return entry;
}

export function redactClaudeCliHistoryMessage(
  message: TranscriptLikeMessage,
): TranscriptLikeMessage {
  return sanitizeTranscriptMessage(
    message as unknown as AgentMessage,
  ) as unknown as TranscriptLikeMessage;
}

function resolveClaudeProjectsDir(homeDir?: string): string {
  return path.join(
    normalizeOptionalString(homeDir) || process.env.HOME || os.homedir(),
    CLAUDE_PROJECTS_RELATIVE_DIR,
  );
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
  content.splice(blockIndex, 1);
  return content.length > 0 ? content : null;
}

function normalizeClaudeCliContent(
  content: string | unknown[],
  toolNameRegistry: ToolNameRegistry,
): string | unknown[] {
  if (!Array.isArray(content)) {
    return content;
  }

  return content.map((item) => {
    if (!isRecord(item)) {
      return item;
    }
    // Import owns decoded payloads; only normalization's top-level edits need a copy.
    const block = { ...item };
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
        block.arguments = block.input;
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
    return block;
  });
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
        content: [...callBlocks, ...resultBlocks],
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

// Read provenance through generated context, but preserve the raw content for
// display and literal matching against local transcript rows.
function readClaudeCliInterSessionProvenance(
  content: string | unknown[],
): InputProvenance | undefined {
  const blockIndex =
    typeof content === "string"
      ? -1
      : content.findIndex((item) => isRecord(item) && item.type === "text");
  const candidate = blockIndex === -1 ? undefined : content[blockIndex];
  const block = isRecord(candidate) ? candidate : undefined;
  const text = typeof content === "string" ? content : block?.text;
  if (typeof text !== "string") {
    return undefined;
  }
  return readInterSessionPromptEnvelope(stripCliPromptDecorations(text))?.provenance;
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

// Queued system events as drainFormattedSystemEvents writes them: the block opens with
// a timestamped line. A plain `System:` line a person typed does not match.
// Untimestamped channel-summary lines on a session's first turn are not matched.
const SYSTEM_EVENT_BLOCK =
  /System: \[(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\]\n]*|unknown-time)\] [^\n]*\n+(?:System: [^\n]*\n+)*/u
    .source;
const INTERNAL_PROMPT_PREFIX = new RegExp(
  `^(?:${SYSTEM_EVENT_BLOCK})?${/(?:Note: The previous agent run was interrupted\. [^\n]*\n\n)?/u.source}`,
  "u",
);

/**
 * Display copy of an imported user row that survived the history merge. The merge
 * matches on the original text first, so this must not run before it.
 */
export function cleanClaudeCliImportedUserDisplay(message: unknown): unknown {
  const meta = isRecord(message) ? message["__openclaw"] : undefined;
  if (
    !isRecord(message) ||
    message.role !== "user" ||
    message.display === false ||
    !isRecord(meta) ||
    meta.importedFrom !== CLAUDE_CLI_PROVIDER
  ) {
    return message;
  }
  const { content } = message;
  if (typeof content === "string") {
    return { ...message, content: stripCliPromptDecorations(content) };
  }
  if (!Array.isArray(content) || content.some((block) => isToolResultBlock(block))) {
    return message;
  }
  // Generated prefixes belong to the beginning of the whole turn. Later text
  // blocks may quote the same frame and must retain the sender's evidence.
  const firstTextIndex = content.findIndex(
    (block) => isRecord(block) && block.type === "text" && typeof block.text === "string",
  );
  return {
    ...message,
    content: content.map((block, index) =>
      index === firstTextIndex && isRecord(block) && typeof block.text === "string"
        ? Object.assign({}, block, { text: stripCliPromptDecorations(block.text) })
        : block,
    ),
  };
}

function resolveClaudeCliInternalSourceTool(text: string): string | undefined {
  // Claude records Gateway SDK input and native commands as ordinary user rows,
  // without OpenClaw provenance. Recover only complete producer-owned frames at
  // this adapter; a matching canonical human row still wins during history merge.
  if (stripCliSessionDriftNote(`${text}\n\n`) === "") {
    return "cli_session_resume";
  }
  // A wake drains queued system events (for example Control UI reactions) and
  // the interrupted-run hint ahead of its prompt; neither makes it a user turn.
  const body = stripCliSessionDriftNote(text).replace(INTERNAL_PROMPT_PREFIX, "");
  if (
    body.startsWith(
      "An async command you ran earlier has completed. The command completion details are:\n\n",
    ) &&
    body.includes("\n\nTreat this completion as an internal continuation, not a new user request. ")
  ) {
    return "exec";
  }
  // Default prompts only; a configured heartbeat prompt is not recognized here.
  if (body.startsWith(HEARTBEAT_PROMPT) || body.startsWith(HEARTBEAT_RESPONSE_TOOL_PROMPT)) {
    return "heartbeat";
  }
  // Restart recovery only, by its full opening sentence behind the CLI timestamp envelope;
  // the bare system-turn tag is too easy for a person to type.
  if (
    body
      .replace(/^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]\n]*\] /u, "")
      .startsWith(
        formatSystemTurnPrompt(
          "Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. ",
        ),
      )
  ) {
    return "restart_recovery";
  }
  if (
    /^<command-name>\/compact<\/command-name>\s*<command-message>compact<\/command-message>\s*<command-args>[\s\S]*<\/command-args>$/u.test(
      body,
    ) ||
    /^<local-command-stdout>Compacted\s*<\/local-command-stdout>$/u.test(body)
  ) {
    return "claude_cli_command";
  }
  return undefined;
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

  const timestamp = parseDateStringTimestampMs(entry.timestamp);
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
              const block = content[candidate.blockIndex];
              if (block && typeof block === "object") {
                (block as Record<string, unknown>).text = reseedPrompt.userMessage;
              }
            }
            break;
          }
        }
      }
    }
    const candidates = resolveClaudeCliPromptTextCandidates(entry, content);
    const internalSourceTool =
      candidates.length === 1 ? resolveClaudeCliInternalSourceTool(candidates[0]!.text) : undefined;
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
        : internalSourceTool;
    const provenance = sourceTool
      ? { kind: "internal_system", sourceTool }
      : readClaudeCliInterSessionProvenance(content);
    return attachOpenClawTranscriptMeta(
      {
        role: "user",
        content,
        ...(internalSourceTool ? { display: false } : {}),
        ...(provenance ? { provenance } : {}),
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

export type ClaudeCliFallbackSeed = {
  summaryText?: string;
  recentTurns: TranscriptLikeMessage[];
};

export async function readClaudeCliFallbackSeed(params: {
  cliSessionId: string;
  homeDir?: string;
}): Promise<ClaudeCliFallbackSeed | undefined> {
  const filePath = await resolveClaudeCliSessionFilePathAsync(params);
  if (!filePath) {
    return undefined;
  }

  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf-8");
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
      appendCoalescedClaudeCliToolMessage(windowedTurns, message);
    }
  }

  const resolvedSummaryText = lastSummary ?? pendingSummary ?? lastBoundaryFallback;
  if (!resolvedSummaryText && windowedTurns.length === 0) {
    return undefined;
  }
  return {
    ...(resolvedSummaryText ? { summaryText: resolvedSummaryText } : {}),
    recentTurns: windowedTurns,
  };
}
