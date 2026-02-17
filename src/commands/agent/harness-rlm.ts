import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { inspect } from "node:util";
import vm from "node:vm";
import type { EmbeddedPiRunResult } from "../../agents/pi-embedded-runner/types.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { AgentStreamParams } from "./types.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { getLogger } from "../../logging/logger.js";

const RLM_MAX_CHILDREN = 64;
const RLM_MAX_ITERATIONS_PER_DEPTH = 24;
const RLM_MAX_TOTAL_LLM_CALLS = 256;
const RLM_MAX_HISTORY_ENTRIES = 24;
const RLM_MAX_SESSION_CONTEXT_CHUNKS = 200;
const RLM_MAX_CONTEXT_CHARS_PER_CHUNK = 1_500;
const RLM_MAX_CONTEXT_SEARCH_PREVIEW = 220;
const RLM_PROMPT_PREVIEW_CHARS = 120;
const RLM_MAX_STDOUT_CHARS = 8_000;
const RLM_MAX_ERROR_CHARS = 3_000;
const RLM_MAX_CODE_CHARS = 3_000;
const RLM_MAX_TOOL_RESULT_CHARS = 32_000;
const RLM_MAX_TOOL_PREVIEW_CHARS = 320;
const RLM_MAX_TOOL_CALLS_PER_STEP = 32;
const RLM_MAX_VISIBLE_HANDLES = 12;
const RLM_HANDLE_RECENCY_STEPS = 24;
const RLM_HANDLE_PREVIEW_CHARS = 180;
const RLM_CHUNK_STATS_TOPK = 8;
const RLM_MAX_REPO_FILES = 6_000;
// Allow modestly large corpora (e.g. books) for RLM slicing exercises.
// Keep this bounded to avoid indexing huge binaries or vendor bundles.
const RLM_MAX_REPO_FILE_SIZE_BYTES = 5_000_000;
const RLM_MAX_REPO_SAMPLE_CHARS = 2_000;
const RLM_MAX_REPO_SEARCH_RESULTS = 32;
const RLM_MAX_REPO_READ_CHARS = 48_000;
const RLM_MAX_REPO_SEARCH_CANDIDATES = 400;
const RLM_MAX_WARNINGS = 32;
const RLM_EMPTY_STEP_RETRIES = 5;
const RLM_EMPTY_STEP_ERROR_PREFIX = "RLM step returned empty model output.";

function promptRequiresJsonOnly(prompt: string): boolean {
  const text = String(prompt ?? "");
  return /\b(?:return|output)\s+json\s+only\b/i.test(text);
}

function promptRequiresRepoSearchAndRead(prompt: string): boolean {
  const text = String(prompt ?? "");
  return /\bMUST\s+call\s+repo_search\s+and\s+repo_read\b/i.test(text);
}

function assertJsonOnlyOutput(text: string): void {
  const trimmed = text.trim();
  // Enforce "JSON only" as "raw JSON container" (object/array), not prose, code fences, or primitives.
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) {
    throw new Error(
      "submit(answer) expected JSON-only output (a raw JSON object/array, no prose/code fences).",
    );
  }
  try {
    JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`submit(answer) returned invalid JSON: ${summarizeError(err)}`, {
      cause: err,
    });
  }
}

function readRuntimeTextArg(value: unknown, field: string): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim();
  }
  if (value === null || value === undefined) {
    return "";
  }
  throw new Error(`${field} expects text input. Pass a string (or scalar), not an object/array.`);
}

function readRuntimeShorthandTextArg(value: unknown, field: string, key: string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>)[key];
    if (candidate === undefined) {
      throw new Error(`${field} expects text or an object containing "${key}".`);
    }
    return readRuntimeTextArg(candidate, `${field}.${key}`);
  }
  return readRuntimeTextArg(value, field);
}

type RlmHarnessParams = {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentDir: string;
  workspaceDir: string;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  agentId?: string;
  messageChannel?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  thinkLevel?: ThinkLevel;
  verboseLevel?: VerboseLevel;
  timeoutMs: number;
  runId: string;
  lane?: string;
  abortSignal?: AbortSignal;
  extraSystemPrompt?: string;
  inputProvenance?: InputProvenance;
  streamParams?: AgentStreamParams;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  fallbacksOverride?: string[];
  maxDepth: number;
  userPrompt: string;
  maxIterations?: number;
  maxLlmCalls?: number;
  extractOnMaxIterations?: boolean;
};

type RlmContextChunk = {
  id: string;
  source: "prompt" | "session";
  text: string;
};

type RlmBoundedField = {
  preview: string;
  originalLength: number;
  omittedChars: number;
  truncated: boolean;
};

type RlmStepSummary = {
  depth: number;
  iteration: number;
  code: RlmBoundedField;
  stdout: RlmBoundedField;
  error?: RlmBoundedField;
  submitted: boolean;
};

type RlmHandleMeta = {
  id: string;
  kind: "prompt" | "subcall" | "tool";
  length: number;
  preview: string;
  touchedStep: number;
};

type RlmExecutionState = {
  final?: string;
  vars: Record<string, unknown>;
  llmCalls: number;
  repoSearchCalls: number;
  repoReadCalls: number;
  history: RlmStepSummary[];
  step: number;
  warnings: string[];
};

type RlmRepoFileRecord = {
  path: string;
  size: number;
  sample: string;
  sampleLower: string;
};

type RlmRepoIndex = {
  root: string;
  files: RlmRepoFileRecord[];
  scannedFiles: number;
  skippedFiles: number;
  truncated: boolean;
};

type RlmSolveContext = {
  depth: number;
  query: string;
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  persistToMainSession: boolean;
};

type RlmObjectStore = {
  putText: (kind: RlmHandleMeta["kind"], text: string, step: number) => Promise<string>;
  readTextSlice: (id: string, from?: number, to?: number) => Promise<string | null>;
  touch: (id: string, step: number) => void;
  has: (id: string) => boolean;
  visibleHandles: (step: number) => RlmHandleMeta[];
};

function extractPayloadText(result: EmbeddedPiRunResult): string {
  const lines = (result.payloads ?? [])
    .map((payload) => (typeof payload.text === "string" ? payload.text.trim() : ""))
    .filter(Boolean);
  return lines.join("\n\n").trim();
}

function summarizeEmptyPayload(result: EmbeddedPiRunResult): string {
  const stopReason = result.meta?.stopReason ?? "unknown";
  const payloads = result.payloads ?? [];
  const payloadCount = payloads.length;
  const textPayloadCount = payloads.filter(
    (payload) => typeof payload.text === "string" && payload.text.trim().length > 0,
  ).length;
  const errorPayloadCount = payloads.filter((payload) => payload.isError === true).length;
  return `stopReason=${stopReason}; payloads=${payloadCount}; textPayloads=${textPayloadCount}; errorPayloads=${errorPayloadCount}`;
}

function summarizeEmbeddedError(result: EmbeddedPiRunResult): string {
  const stopReason = result.meta?.stopReason ?? "unknown";
  const kind = result.meta?.error?.kind;
  const msg = result.meta?.error?.message;
  const aborted = result.meta?.aborted === true;
  const parts = [
    `stopReason=${stopReason}`,
    `aborted=${aborted ? "1" : "0"}`,
    kind ? `errorKind=${kind}` : null,
    msg ? `error=${preview(String(msg), 220)}` : null,
  ].filter(Boolean);
  return parts.join("; ");
}

function isEmptyStepError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.message.startsWith(RLM_EMPTY_STEP_ERROR_PREFIX);
}

const TRANSIENT_CONNECTION_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT",
  "UND_ERR_SOCKET",
]);

const TRANSIENT_CONNECTION_RE =
  /connection error|fetch failed|network error|socket hang up|getaddrinfo|timed? ?out|econnre/i;

function isTransientConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: string }).code;
  if (typeof code === "string" && TRANSIENT_CONNECTION_CODES.has(code.toUpperCase())) {
    return true;
  }
  const message = err instanceof Error ? err.message : "";
  return Boolean(message && TRANSIENT_CONNECTION_RE.test(message));
}

function trimForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function preview(value: string, maxChars = 280): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars)}...`;
}

function isPromiseSentinelText(text: string): boolean {
  return text.includes("[object Promise]");
}

function isObjectSentinelText(text: string): boolean {
  return text.includes("[object Object]");
}

function isInvalidFinalText(text: string): boolean {
  return isPromiseSentinelText(text) || isObjectSentinelText(text);
}

function safeStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null
  ) {
    return String(value);
  }
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded === "string") {
      return encoded;
    }
    return inspect(value, { depth: 2, maxArrayLength: 20, breakLength: 100 });
  } catch {
    return inspect(value, { depth: 2, maxArrayLength: 20, breakLength: 100 });
  }
}

function summarizeUnknown(value: unknown, maxChars = 220): string {
  return preview(safeStringify(value), maxChars);
}

function summarizeError(err: unknown, maxChars = 220): string {
  if (err instanceof Error) {
    return preview(err.message || String(err), maxChars);
  }
  return summarizeUnknown(err, maxChars);
}

type RlmToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<{
    content?: Array<{ type?: string; text?: string; isError?: boolean }>;
    details?: unknown;
  }>;
};

type RlmToolInvocationResult = {
  ok: boolean;
  tool: string;
  handle?: string;
  preview?: string;
  error?: string;
};

function appendWarning(state: RlmExecutionState, warning: string) {
  if (state.warnings.length >= RLM_MAX_WARNINGS) {
    return;
  }
  if (!state.warnings.includes(warning)) {
    state.warnings.push(warning);
  }
}

export function truncateHeadTail(value: string, maxChars: number): RlmBoundedField {
  const normalized = String(value ?? "");
  if (maxChars <= 0) {
    return {
      preview: "",
      originalLength: normalized.length,
      omittedChars: normalized.length,
      truncated: normalized.length > 0,
    };
  }
  if (normalized.length <= maxChars) {
    return {
      preview: normalized,
      originalLength: normalized.length,
      omittedChars: 0,
      truncated: false,
    };
  }
  const marker = "\n...[truncated]...\n";
  const available = Math.max(8, maxChars - marker.length);
  const headLen = Math.ceil(available / 2);
  const tailLen = Math.floor(available / 2);
  const head = normalized.slice(0, headLen);
  const tail = normalized.slice(normalized.length - tailLen);
  const previewText = `${head}${marker}${tail}`;
  return {
    preview: previewText,
    originalLength: normalized.length,
    omittedChars: Math.max(0, normalized.length - previewText.length),
    truncated: true,
  };
}

function redactLargeStringLiterals(code: string): { code: string; redactions: number } {
  let redactions = 0;
  let out = code.replace(/"([^"\\]|\\.){512,}"/g, (match) => {
    redactions += 1;
    return `"[redacted string literal len=${match.length - 2}]"`;
  });
  out = out.replace(/'([^'\\]|\\.){512,}'/g, (match) => {
    redactions += 1;
    return `'[redacted string literal len=${match.length - 2}]'`;
  });
  out = out.replace(/`([^`\\]|\\.){512,}`/g, (match) => {
    redactions += 1;
    return `\`[redacted template literal len=${match.length - 2}]\``;
  });
  return { code: out, redactions };
}

export function serializeCodeForHistory(code: string): RlmBoundedField {
  const redacted = redactLargeStringLiterals(String(code ?? ""));
  return truncateHeadTail(redacted.code, RLM_MAX_CODE_CHARS);
}

export function serializeStdoutForHistory(stdout: string): RlmBoundedField {
  return truncateHeadTail(String(stdout ?? ""), RLM_MAX_STDOUT_CHARS);
}

export function serializeErrorForHistory(errorText: string): RlmBoundedField {
  return truncateHeadTail(String(errorText ?? ""), RLM_MAX_ERROR_CHARS);
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const lines: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as Record<string, unknown>;
    if (typeof entry.text === "string") {
      lines.push(entry.text);
      continue;
    }
    if (typeof entry.content === "string") {
      lines.push(entry.content);
    }
  }
  return lines.join("\n");
}

async function loadSessionContextChunks(params: { sessionFile: string; prompt: string }) {
  const chunks: RlmContextChunk[] = [
    {
      id: "prompt",
      source: "prompt",
      text: trimForPrompt(params.prompt, RLM_MAX_CONTEXT_CHARS_PER_CHUNK),
    },
  ];

  let raw = "";
  try {
    raw = await fs.readFile(params.sessionFile, "utf8");
  } catch {
    return chunks;
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  let index = 0;
  for (const line of lines) {
    if (chunks.length >= RLM_MAX_SESSION_CONTEXT_CHUNKS + 1) {
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const entry = parsed as Record<string, unknown>;
    if (entry.type !== "message") {
      continue;
    }
    const message =
      entry.message && typeof entry.message === "object"
        ? (entry.message as Record<string, unknown>)
        : undefined;
    if (!message) {
      continue;
    }
    const role = typeof message.role === "string" ? message.role : "unknown";
    const text = extractTextFromMessageContent(message.content);
    if (!text.trim()) {
      continue;
    }
    chunks.push({
      id: `session-${index}`,
      source: "session",
      text: `${role}: ${trimForPrompt(text.trim(), RLM_MAX_CONTEXT_CHARS_PER_CHUNK)}`,
    });
    index += 1;
  }

  return chunks;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function isLikelyTextSample(buf: Buffer): boolean {
  if (buf.length === 0) {
    return true;
  }
  const nul = buf.indexOf(0x00);
  return nul === -1;
}

async function buildRepoIndex(workspaceDir: string): Promise<RlmRepoIndex> {
  const root = await fs
    .realpath(path.resolve(workspaceDir))
    .catch(() => path.resolve(workspaceDir));
  const files: RlmRepoFileRecord[] = [];
  const stack: string[] = [root];
  const skipDirs = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".openclaw",
  ]);
  let scannedFiles = 0;
  let skippedFiles = 0;
  let truncated = false;

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>;
    try {
      const rawEntries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
      entries = rawEntries.map((entry) => ({
        isDirectory: () => entry.isDirectory(),
        isFile: () => entry.isFile(),
        name: String(entry.name),
      }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          continue;
        }
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      scannedFiles += 1;
      if (files.length >= RLM_MAX_REPO_FILES) {
        truncated = true;
        break;
      }
      let size = 0;
      try {
        const stat = await fs.stat(abs);
        size = stat.size;
      } catch {
        skippedFiles += 1;
        continue;
      }
      if (size > RLM_MAX_REPO_FILE_SIZE_BYTES) {
        skippedFiles += 1;
        continue;
      }
      let sample = "";
      try {
        // Only read a small head sample; do not slurp entire files into memory.
        const headBytesLen = Math.min(size, RLM_MAX_REPO_SAMPLE_CHARS * 3);
        const fd = await fs.open(abs, "r");
        let head: Buffer;
        try {
          const buf = Buffer.alloc(headBytesLen);
          const res = await fd.read(buf, 0, headBytesLen, 0);
          head = buf.subarray(0, res.bytesRead);
        } finally {
          await fd.close().catch(() => undefined);
        }
        if (!isLikelyTextSample(head)) {
          skippedFiles += 1;
          continue;
        }
        sample = head.toString("utf8").slice(0, RLM_MAX_REPO_SAMPLE_CHARS);
      } catch {
        skippedFiles += 1;
        continue;
      }
      const rel = toPosixPath(path.relative(root, abs));
      files.push({
        path: rel,
        size,
        sample,
        sampleLower: sample.toLowerCase(),
      });
    }
    if (truncated) {
      break;
    }
  }

  return {
    root,
    files,
    scannedFiles,
    skippedFiles,
    truncated,
  };
}

async function resolveWorkspaceFilePath(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  const raw = String(requestedPath ?? "").trim();
  if (!raw) {
    throw new Error("path is required");
  }
  const root = await fs
    .realpath(path.resolve(workspaceRoot))
    .catch(() => path.resolve(workspaceRoot));
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const real = await fs.realpath(candidate);
  const prefix = `${root}${path.sep}`;
  if (real !== root && !real.startsWith(prefix)) {
    throw new Error("path resolves outside workspace root");
  }
  return real;
}

async function loadRlmToolDefinitions(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  workspaceDir: string;
  agentDir: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
  abortSignal?: AbortSignal;
  senderIsOwner?: boolean;
}) {
  try {
    // Lazy import to avoid module-cycle issues (harness -> pi-tools -> openclaw-tools -> rlm-call-tool -> harness).
    const [{ createOpenClawCodingTools }, { toToolDefinitions }] = await Promise.all([
      import("../../agents/pi-tools.js"),
      import("../../agents/pi-tool-definition-adapter.js"),
    ]);
    const toolDefs = toToolDefinitions(
      createOpenClawCodingTools({
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: params.cfg,
        sessionKey: params.sessionKey,
        messageProvider: params.messageChannel,
        modelProvider: params.provider,
        modelId: params.model,
        agentAccountId: params.agentAccountId,
        messageTo: params.messageTo,
        messageThreadId: params.messageThreadId,
        groupId: params.groupId,
        groupChannel: params.groupChannel,
        groupSpace: params.groupSpace,
        currentChannelId: params.currentChannelId,
        currentThreadTs: params.currentThreadTs,
        replyToMode: params.replyToMode,
        hasRepliedRef: params.hasRepliedRef,
        abortSignal: params.abortSignal,
        senderIsOwner: params.senderIsOwner,
      }),
    ) as RlmToolDefinition[];
    return toolDefs.filter((tool) => tool.name !== "rlm_call");
  } catch (err) {
    getLogger().warn(
      `rlm tool loading failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

function extractToolResultText(result: {
  content?: Array<{ type?: string; text?: string; isError?: boolean }>;
  details?: unknown;
}) {
  const textBlocks = (result.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => String(item.text ?? "").trim())
    .filter(Boolean);
  const text = textBlocks.join("\n\n").trim();
  const detailsText = result.details === undefined ? "" : safeStringify(result.details).trim();
  const joined = [text, detailsText].filter(Boolean).join("\n\n").trim();
  return joined;
}

function toolResultIsError(result: {
  content?: Array<{ type?: string; text?: string; isError?: boolean }>;
  details?: unknown;
}) {
  if ((result.content ?? []).some((item) => item?.isError === true)) {
    return true;
  }
  const details = result.details;
  if (details && typeof details === "object") {
    const rec = details as Record<string, unknown>;
    if (rec.status === "error" || typeof rec.error === "string") {
      return true;
    }
  }
  return false;
}

function extractCodeFromModelText(text: string): string {
  const fence = text.match(/```(?:javascript|js|ts|typescript)?\s*([\s\S]*?)```/i);
  const code = (fence?.[1] ?? text).trim();
  if (!code) {
    throw new Error("RLM step produced empty code output.");
  }
  return code;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
}

async function createObjectStore(tmpRoot: string): Promise<RlmObjectStore> {
  const dir = path.join(tmpRoot, "objects");
  await fs.mkdir(dir, { recursive: true });
  const metas = new Map<string, RlmHandleMeta>();

  return {
    putText: async (kind, text, step) => {
      const normalized = String(text ?? "");
      const id = randomUUID();
      await fs.writeFile(
        path.join(dir, `${id}.json`),
        JSON.stringify({ text: normalized }),
        "utf8",
      );
      metas.set(id, {
        id,
        kind,
        length: normalized.length,
        preview: truncateHeadTail(normalized, RLM_HANDLE_PREVIEW_CHARS).preview,
        touchedStep: step,
      });
      return id;
    },
    readTextSlice: async (id, from, to) => {
      if (!metas.has(id)) {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), "utf8"));
      } catch {
        return null;
      }
      const text =
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>).text === "string"
          ? ((parsed as Record<string, unknown>).text as string)
          : "";
      const start = typeof from === "number" && Number.isFinite(from) ? Math.max(0, from) : 0;
      const end = typeof to === "number" && Number.isFinite(to) ? Math.max(start, to) : text.length;
      return text.slice(start, end);
    },
    touch: (id, step) => {
      const meta = metas.get(id);
      if (!meta) {
        return;
      }
      meta.touchedStep = step;
      metas.set(id, meta);
    },
    has: (id) => metas.has(id),
    visibleHandles: (step) => {
      return [...metas.values()]
        .filter((meta) => step - meta.touchedStep <= RLM_HANDLE_RECENCY_STEPS)
        .toSorted((a, b) => b.touchedStep - a.touchedStep)
        .slice(0, RLM_MAX_VISIBLE_HANDLES)
        .map((meta) => ({ ...meta }));
    },
  };
}

function buildRlmPrompt(params: {
  depth: number;
  maxDepth: number;
  iteration: number;
  maxIterations: number;
  maxLlmCalls: number;
  state: RlmExecutionState;
  chunks: RlmContextChunk[];
  promptHandle: string;
  promptValue: string;
  workspaceDir: string;
  repo: RlmRepoIndex;
  handles: RlmHandleMeta[];
  tools: Array<{ name: string; description: string }>;
}) {
  const recentHistory = params.state.history.slice(-RLM_MAX_HISTORY_ENTRIES);

  const sourceCounts = params.chunks.reduce<Record<string, number>>((acc, chunk) => {
    acc[chunk.source] = (acc[chunk.source] ?? 0) + 1;
    return acc;
  }, {});

  const topChunkStats = [...params.chunks]
    .toSorted((a, b) => b.text.length - a.text.length)
    .slice(0, RLM_CHUNK_STATS_TOPK)
    .map((chunk) => ({
      id: chunk.id,
      source: chunk.source,
      chars: chunk.text.length,
    }));

  const promptMeta = {
    contextHandle: params.promptHandle,
    contextType: "string",
    contextLength: params.promptValue.length,
    contextPreview: truncateHeadTail(params.promptValue, RLM_PROMPT_PREVIEW_CHARS).preview,
    access: [
      "Use context_read(id, from?, to?) to slice chunk text.",
      "Use context_search(query, topK?) for symbolic retrieval.",
      "Use repo_search(query, topK?) for workspace file retrieval.",
      "Use repo_read(path, from?, to?) to read workspace file slices.",
      "Use llm_query(query) to recurse.",
    ],
    repoRoot: params.workspaceDir,
    repoIndexedFiles: params.repo.files.length,
    repoScannedFiles: params.repo.scannedFiles,
    repoSkippedFiles: params.repo.skippedFiles,
    repoIndexTruncated: params.repo.truncated,
    repoSample: params.repo.files.slice(0, 16).map((file) => ({
      path: file.path,
      size: file.size,
    })),
    chunkCount: params.chunks.length,
    chunkSources: sourceCounts,
    chunkCharsTotal: params.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
    chunkStatsTopK: topChunkStats,
    recentHandles: params.handles.map((meta) => ({
      id: meta.id,
      kind: meta.kind,
      length: meta.length,
      touchedStep: meta.touchedStep,
      preview: meta.preview,
    })),
    recentHistory,
    warnings: params.state.warnings,
    toolsAvailableCount: params.tools.length,
    toolsAvailable: params.tools.slice(0, 64),
  };

  return [
    "You are running inside a Recursive Language Model (RLM) REPL loop.",
    "Output JavaScript code only for this step. Do not output prose.",
    "Write small executable steps, observe outputs, then continue iteratively.",
    "When you have enough evidence, call submit(answer) with a direct, complete answer to the user's question. Do not include conversational filler, follow-up offers, or hedging — just answer.",
    "",
    "Available runtime functions:",
    "- context_overview(): returns metadata about available chunks.",
    "- context_read(id, from?, to?): returns chunk text or a slice.",
    "- context_search(query, topK?): returns scored chunk matches.",
    "- repo_search(query, topK?): returns scored workspace file matches.",
    "- repo_read(path, from?, to?): returns workspace file text or slice.",
    "- repo_overview(): returns workspace index metadata.",
    "- llm_query(query): recursively query a sub-LLM and return string. Sub-LLMs can handle large context — don't be afraid to put a lot of context into them.",
    "- llm_query_batched(queries): run multiple recursive sub-queries and return string[].",
    "- state_info(id): returns metadata for a stored handle.",
    "- state_read(id, from?, to?): returns stored text slice for a handle.",
    "- tools_list(): returns callable tool metadata.",
    "- tool_call(name, args): executes one tool call and returns metadata + handle.",
    "- tool_call_batched(calls): executes multiple tool calls and returns result[].",
    "- get_var(key), set_var(key, value): stateful scratchpad across iterations.",
    "- print(...args): emit debugging output to REPL stdout.",
    "- submit(answer): set final answer and end the loop.",
    "Available built-ins: Math, JSON, Date, and standard JavaScript (Array, Object, RegExp, etc.).",
    "",
    "Rules:",
    "1) EXPLORE FIRST - inspect shape/size before transforming.",
    "2) ITERATE - write small snippets, observe outputs, then decide next steps.",
    "3) VERIFY BEFORE SUBMITTING - if results look wrong, inspect and retry before submit().",
    "4) ALL recursion must happen through llm_query / llm_query_batched.",
    "5) Prefer symbolic retrieval/slicing (context_*, repo_*, state_*) over large pasted blobs.",
    "6) submit(answer) ends the loop immediately.",
    "",
    `Depth: ${params.depth}/${params.maxDepth}`,
    `Iteration: ${params.iteration}/${params.maxIterations}`,
    `LLM calls used: ${params.state.llmCalls}/${params.maxLlmCalls}`,
    "",
    "Bounded context metadata (JSON):",
    JSON.stringify(promptMeta, null, 2),
  ].join("\n");
}

export async function runRlmHarness(params: RlmHarnessParams): Promise<{
  result: EmbeddedPiRunResult;
  provider: string;
  model: string;
  stats: {
    llmCalls: number;
    repoSearchCalls: number;
    repoReadCalls: number;
    steps: number;
    warningsCount: number;
  };
}> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1, params.timeoutMs);
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rlm-"));
  let skipCleanup = false;
  const logger = getLogger();
  let lastProvider = params.provider;
  let lastModel = params.model;

  const chunks = await loadSessionContextChunks({
    sessionFile: params.sessionFile,
    prompt: params.userPrompt,
  });
  const repo = await buildRepoIndex(params.workspaceDir);
  const store = await createObjectStore(tmpRoot);
  const requireRepoCalls = promptRequiresRepoSearchAndRead(params.userPrompt);
  const maxIterations =
    typeof params.maxIterations === "number" && Number.isFinite(params.maxIterations)
      ? Math.max(1, Math.min(96, Math.floor(params.maxIterations)))
      : RLM_MAX_ITERATIONS_PER_DEPTH;
  const maxLlmCalls =
    typeof params.maxLlmCalls === "number" && Number.isFinite(params.maxLlmCalls)
      ? Math.max(1, Math.min(2_048, Math.floor(params.maxLlmCalls)))
      : RLM_MAX_TOTAL_LLM_CALLS;
  const extractOnMaxIterations = params.extractOnMaxIterations !== false;
  const rlmToolDefs = await loadRlmToolDefinitions({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    sessionKey: params.sessionKey,
    messageChannel: params.messageChannel,
    agentAccountId: params.agentAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    abortSignal: params.abortSignal,
    senderIsOwner: params.senderIsOwner,
  });
  const rlmToolsByName = new Map(rlmToolDefs.map((tool) => [tool.name, tool] as const));
  const rlmToolMeta = rlmToolDefs.map((tool) => ({
    name: tool.name,
    description: preview(tool.description, 160),
  }));

  const withRemainingTimeout = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("RLM harness timeout exceeded.");
    }
    return remaining;
  };

  const runSingle = async (args: {
    solveCtx: RlmSolveContext;
    prompt: string;
    runSuffix: string;
  }): Promise<string> => {
    const timeoutMs = withRemainingTimeout();
    const maybeAuthProfile = args.solveCtx.persistToMainSession ? params.authProfileId : undefined;
    const fallback = await runWithModelFallback({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      agentDir: params.agentDir,
      fallbacksOverride: params.fallbacksOverride,
      run: async (providerOverride, modelOverride) =>
        await runEmbeddedPiAgent({
          sessionId: args.solveCtx.sessionId,
          sessionKey: args.solveCtx.sessionKey,
          agentId: params.agentId,
          messageChannel: params.messageChannel,
          agentAccountId: params.agentAccountId,
          messageTo: params.messageTo,
          messageThreadId: params.messageThreadId,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          currentChannelId: params.currentChannelId,
          currentThreadTs: params.currentThreadTs,
          replyToMode: params.replyToMode,
          hasRepliedRef: params.hasRepliedRef,
          senderIsOwner: params.senderIsOwner,
          sessionFile: args.solveCtx.sessionFile,
          workspaceDir: params.workspaceDir,
          config: params.cfg,
          skillsSnapshot: params.skillsSnapshot,
          prompt: args.prompt,
          disableTools: true,
          provider: providerOverride,
          model: modelOverride,
          authProfileId: maybeAuthProfile,
          authProfileIdSource: maybeAuthProfile ? params.authProfileIdSource : undefined,
          thinkLevel: params.thinkLevel,
          verboseLevel: params.verboseLevel,
          timeoutMs,
          runId: `${params.runId}:rlm:${args.runSuffix}`,
          lane: params.lane,
          abortSignal: params.abortSignal,
          extraSystemPrompt: params.extraSystemPrompt,
          inputProvenance: args.solveCtx.persistToMainSession ? params.inputProvenance : undefined,
          streamParams: params.streamParams,
          agentDir: params.agentDir,
        }),
    });

    lastProvider = fallback.provider;
    lastModel = fallback.model;
    const text = extractPayloadText(fallback.result);
    const isError =
      (fallback.result.payloads ?? []).some((payload) => payload.isError === true) ||
      fallback.result.meta?.stopReason === "error";
    if (isError) {
      logger.warn(
        `rlm model error: runId=${params.runId} suffix=${args.runSuffix} provider=${lastProvider} model=${lastModel} ${summarizeEmbeddedError(fallback.result)}`,
      );
      throw new Error(`${RLM_EMPTY_STEP_ERROR_PREFIX} ${summarizeEmbeddedError(fallback.result)}`);
    }
    if (!text) {
      logger.warn(
        `rlm empty model output: runId=${params.runId} suffix=${args.runSuffix} provider=${lastProvider} model=${lastModel} ${summarizeEmbeddedError(fallback.result)}`,
      );
      throw new Error(
        `${RLM_EMPTY_STEP_ERROR_PREFIX} ${summarizeEmptyPayload(fallback.result)}; ${summarizeEmbeddedError(fallback.result)}`,
      );
    }
    return text;
  };

  const runExtract = async (args: { solveCtx: RlmSolveContext; state: RlmExecutionState }) => {
    const handles = store.visibleHandles(args.state.step).map((meta) => ({
      id: meta.id,
      kind: meta.kind,
      length: meta.length,
      preview: meta.preview,
    }));
    const extractPrompt = [
      "RLM extract fallback activated because max iterations were reached before submit(answer).",
      "Review your REPL trajectory to see what information you gathered and what values you computed, then provide the final answer.",
      "Produce the final user answer from the bounded metadata below.",
      "Answer the user's question directly and completely. Do not include conversational filler, follow-up offers, or hedging.",
      "Do not output code. Output final answer text only.",
      `Depth: ${args.solveCtx.depth}/${params.maxDepth}`,
      `LLM calls used: ${args.state.llmCalls}/${maxLlmCalls}`,
      "Recent state JSON:",
      JSON.stringify(
        {
          warnings: args.state.warnings,
          recentHistory: args.state.history.slice(-RLM_MAX_HISTORY_ENTRIES),
          handles,
        },
        null,
        2,
      ),
      `Original query:\n${args.solveCtx.query}`,
    ].join("\n\n");

    // Providers can occasionally return an empty payload (especially oauth-backed gateways).
    // Treat extract as a normal step: retry a few times rather than failing the whole harness.
    const suffix = `d${args.solveCtx.depth}-extract`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await runSingle({
          solveCtx: args.solveCtx,
          prompt: extractPrompt,
          runSuffix: suffix,
        });
      } catch (err) {
        if ((!isEmptyStepError(err) && !isTransientConnectionError(err)) || attempt === 3) {
          throw err;
        }
        const delayMs = Math.min(2_000, 250 * attempt);
        logger.warn(
          `rlm extract retry: runId=${params.runId} suffix=${suffix} attempt=${attempt + 1}/3 delayMs=${delayMs}`,
        );
        await sleep(delayMs);
      }
    }
    throw new Error("unreachable");
  };

  const solve = async (solveCtx: RlmSolveContext, state: RlmExecutionState): Promise<string> => {
    if (solveCtx.depth > params.maxDepth) {
      throw new Error(`RLM max depth exceeded (${params.maxDepth}).`);
    }

    const promptHandle = await store.putText("prompt", solveCtx.query, state.step);
    store.touch(promptHandle, state.step);

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (params.abortSignal?.aborted) {
        throw new Error("RLM harness aborted.");
      }

      const stepPrompt = buildRlmPrompt({
        depth: solveCtx.depth,
        maxDepth: params.maxDepth,
        iteration,
        maxIterations,
        maxLlmCalls,
        state,
        chunks,
        promptHandle,
        promptValue: solveCtx.query,
        workspaceDir: params.workspaceDir,
        repo,
        handles: store.visibleHandles(state.step),
        tools: rlmToolMeta,
      });

      let modelText = "";
      let lastEmptyStepError: Error | undefined;
      for (let attempt = 0; attempt <= RLM_EMPTY_STEP_RETRIES; attempt += 1) {
        const prompt =
          attempt === 0
            ? stepPrompt
            : `${stepPrompt}\n\nRetry ${attempt}/${RLM_EMPTY_STEP_RETRIES}: previous attempt returned empty text. Output executable JavaScript code only.`;
        try {
          modelText = await runSingle({
            solveCtx,
            prompt,
            runSuffix: `d${solveCtx.depth}-i${iteration}-a${attempt + 1}`,
          });
          lastEmptyStepError = undefined;
          break;
        } catch (err) {
          if (!isEmptyStepError(err) && !isTransientConnectionError(err)) {
            throw err;
          }
          lastEmptyStepError = err instanceof Error ? err : new Error(String(err));
          if (attempt >= RLM_EMPTY_STEP_RETRIES) {
            throw lastEmptyStepError;
          }
          const label = isTransientConnectionError(err) ? "connection error" : "empty model output";
          appendWarning(
            state,
            `${label} at depth=${solveCtx.depth} iteration=${iteration}; retrying`,
          );
          // Provider/network hiccups can manifest as empty outputs; a small backoff helps.
          const backoffMs = isTransientConnectionError(err)
            ? 500 * (attempt + 1)
            : 150 * (attempt + 1);
          await sleep(backoffMs);
        }
      }
      if (!modelText) {
        throw (
          lastEmptyStepError ??
          new Error(`${RLM_EMPTY_STEP_ERROR_PREFIX} exhausted retries without model text.`)
        );
      }

      const code = extractCodeFromModelText(modelText);
      const redactionCount = redactLargeStringLiterals(code).redactions;
      if (redactionCount > 0) {
        appendWarning(state, `code literal redactions: ${redactionCount}`);
      }

      state.step += 1;
      let submitted: string | undefined;
      const stdoutLines: string[] = [];
      let executionError: string | undefined;
      const pendingStepOps: Promise<unknown>[] = [];
      const pendingSubmitOps: Promise<unknown>[] = [];
      let toolCallsInStep = 0;

      const trackStepOp = <T>(op: Promise<T>): Promise<T> => {
        // REPL code can forget to await async runtime calls; track them so we can drain before
        // tmpRoot cleanup and avoid unhandled rejections.
        void op.catch(() => undefined);
        pendingStepOps.push(op);
        return op;
      };

      const drainOpsWithBudget = async (
        ops: Promise<unknown>[],
        label: string,
      ): Promise<{ timedOut: boolean }> => {
        if (ops.length === 0) {
          return { timedOut: false };
        }
        const remaining = Math.max(0, deadline - Date.now());
        const budgetMs = Math.max(
          250,
          Math.min(15_000, remaining > 500 ? remaining - 250 : remaining),
        );
        let timedOut = false;
        const allDone = Promise.allSettled(ops).then(() => "done" as const);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve("timeout");
          }, budgetMs);
        });
        const result = await Promise.race([allDone, timeout]);
        if (timer) {
          clearTimeout(timer);
        }
        if (result === "timeout") {
          appendWarning(state, `${label} drain timeout; preserving tmpRoot to avoid cleanup races`);
          skipCleanup = true;
        }
        return { timedOut };
      };

      const runtimeApi = {
        context_overview: () => ({
          count: chunks.length,
          ids: chunks.slice(0, 64).map((chunk) => chunk.id),
          sources: chunks.reduce<Record<string, number>>((acc, chunk) => {
            acc[chunk.source] = (acc[chunk.source] ?? 0) + 1;
            return acc;
          }, {}),
          totalChars: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
        }),
        context_read: (id: string, from?: number, to?: number) => {
          const chunk = chunks.find((entry) => entry.id === String(id));
          logger.debug(
            `rlm runtime context_read: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} id=${String(id)} from=${typeof from === "number" ? from : "na"} to=${typeof to === "number" ? to : "na"} found=${chunk ? "1" : "0"}`,
          );
          if (!chunk) {
            return null;
          }
          const start = typeof from === "number" && Number.isFinite(from) ? Math.max(0, from) : 0;
          const end =
            typeof to === "number" && Number.isFinite(to) ? Math.max(start, to) : chunk.text.length;
          return {
            id: chunk.id,
            source: chunk.source,
            text: chunk.text.slice(start, end),
          };
        },
        context_search: (query: string, topK?: number) => {
          const q = String(query ?? "").trim();
          logger.debug(
            `rlm runtime context_search: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} query=${preview(q, 120)} topK=${typeof topK === "number" ? topK : "na"}`,
          );
          if (!q) {
            return [] as Array<{ id: string; source: string; score: number; preview: string }>;
          }
          const qTokens = tokenize(q);
          const scored = chunks
            .map((chunk) => {
              const haystack = chunk.text.toLowerCase();
              let score = haystack.includes(q.toLowerCase()) ? 2 : 0;
              if (qTokens.size > 0) {
                const hayTokens = tokenize(haystack);
                for (const token of qTokens) {
                  if (hayTokens.has(token)) {
                    score += 1;
                  }
                }
              }
              return {
                id: chunk.id,
                source: chunk.source,
                score,
                preview: truncateHeadTail(chunk.text, RLM_MAX_CONTEXT_SEARCH_PREVIEW).preview,
              };
            })
            .filter((entry) => entry.score > 0)
            .toSorted((a, b) => b.score - a.score);
          const limit =
            typeof topK === "number" && Number.isFinite(topK)
              ? Math.max(1, Math.min(100, Math.floor(topK)))
              : 8;
          const matches = scored.slice(0, limit);
          logger.debug(
            `rlm runtime context_search result: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} matches=${matches.length}`,
          );
          return matches;
        },
        repo_overview: () => ({
          root: repo.root,
          indexedFiles: repo.files.length,
          scannedFiles: repo.scannedFiles,
          skippedFiles: repo.skippedFiles,
          truncated: repo.truncated,
        }),
        repo_search: (query: unknown, topK?: number) =>
          trackStepOp(
            (async () => {
              const q = readRuntimeShorthandTextArg(query, "repo_search(query)", "query");
              state.repoSearchCalls += 1;
              logger.debug(
                `rlm runtime repo_search: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} query=${preview(q, 120)} topK=${typeof topK === "number" ? topK : "na"}`,
              );
              if (!q) {
                return [] as Array<{ path: string; score: number; size: number; preview: string }>;
              }
              const qLower = q.toLowerCase();
              const qTokens = tokenize(q);
              const candidates = repo.files
                .map((file) => {
                  let score = 0;
                  const pLower = file.path.toLowerCase();
                  if (pLower.includes(qLower)) {
                    score += 4;
                  }
                  for (const token of qTokens) {
                    if (pLower.includes(token)) {
                      score += 1;
                    }
                  }
                  if (file.sampleLower.includes(qLower)) {
                    score += 3;
                  }
                  for (const token of qTokens) {
                    if (file.sampleLower.includes(token)) {
                      score += 1;
                    }
                  }
                  return {
                    path: file.path,
                    score,
                    size: file.size,
                    preview: truncateHeadTail(file.sample, RLM_MAX_CONTEXT_SEARCH_PREVIEW).preview,
                  };
                })
                .filter((entry) => entry.score > 0)
                .toSorted((a, b) => b.score - a.score)
                .slice(0, RLM_MAX_REPO_SEARCH_CANDIDATES);
              const limit =
                typeof topK === "number" && Number.isFinite(topK)
                  ? Math.max(1, Math.min(RLM_MAX_REPO_SEARCH_RESULTS, Math.floor(topK)))
                  : 8;
              const matches = candidates.slice(0, limit);
              logger.debug(
                `rlm runtime repo_search result: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} matches=${matches.length}`,
              );
              return matches;
            })(),
          ),
        repo_read: (repoPath: unknown, from?: number, to?: number) =>
          trackStepOp(
            (async () => {
              state.repoReadCalls += 1;
              const requestedPath = readRuntimeShorthandTextArg(
                repoPath,
                "repo_read(path)",
                "path",
              );
              try {
                const realPath = await resolveWorkspaceFilePath(params.workspaceDir, requestedPath);
                const stat = await fs.stat(realPath);
                if (!stat.isFile()) {
                  logger.debug(
                    `rlm runtime repo_read: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} path=${requestedPath} ok=0 reason=not_file`,
                  );
                  return null;
                }
                if (stat.size > RLM_MAX_REPO_FILE_SIZE_BYTES) {
                  logger.debug(
                    `rlm runtime repo_read: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} path=${requestedPath} ok=0 reason=file_too_large`,
                  );
                  return null;
                }
                const start =
                  typeof from === "number" && Number.isFinite(from) ? Math.max(0, from) : 0;
                const endRequested =
                  typeof to === "number" && Number.isFinite(to)
                    ? Math.max(start, to)
                    : start + RLM_MAX_REPO_READ_CHARS;
                const end = Math.max(
                  start,
                  Math.min(endRequested, start + RLM_MAX_REPO_READ_CHARS),
                );

                // Read only the requested slice (bounded) to preserve the "slicing" contract.
                // Approximation: treat from/to as byte offsets. Most repos/corpora are ASCII/UTF-8 friendly.
                const fd = await fs.open(realPath, "r");
                let text = "";
                try {
                  const toRead = Math.max(0, end - start);
                  const buf = Buffer.alloc(toRead);
                  const res = await fd.read(buf, 0, toRead, start);
                  const slice = buf.subarray(0, res.bytesRead);
                  if (!isLikelyTextSample(slice.subarray(0, Math.min(1024, slice.length)))) {
                    logger.debug(
                      `rlm runtime repo_read: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} path=${requestedPath} ok=0 reason=binary`,
                    );
                    return null;
                  }
                  text = slice.toString("utf8");
                } finally {
                  await fd.close().catch(() => undefined);
                }
                const rel = toPosixPath(path.relative(repo.root, realPath));
                logger.debug(
                  `rlm runtime repo_read: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} path=${rel} from=${start} to=${end} ok=1`,
                );
                return {
                  path: rel,
                  text,
                  start,
                  end,
                  truncated: end < stat.size,
                };
              } catch (err) {
                logger.debug(
                  `rlm runtime repo_read: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} path=${requestedPath} ok=0 error=${summarizeError(err)}`,
                );
                return null;
              }
            })(),
          ),
        state_info: (id: unknown) => {
          const key = readRuntimeShorthandTextArg(id, "state_info(id)", "id");
          const info = store.visibleHandles(state.step).find((meta) => meta.id === key);
          if (!info) {
            return null;
          }
          store.touch(key, state.step);
          return info;
        },
        state_read: async (id: unknown, from?: number, to?: number) => {
          const key = readRuntimeShorthandTextArg(id, "state_read(id)", "id");
          if (!store.has(key)) {
            return null;
          }
          store.touch(key, state.step);
          return await store.readTextSlice(key, from, to);
        },
        llm_query: (subQuery: unknown) =>
          trackStepOp(
            (async () => {
              if (state.llmCalls >= maxLlmCalls) {
                throw new Error(`RLM max llm calls exceeded (${maxLlmCalls}).`);
              }
              const subText = readRuntimeTextArg(subQuery, "llm_query(query)");
              if (!subText) {
                throw new Error("llm_query requires a non-empty query.");
              }
              logger.debug(
                `rlm runtime llm_query start: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} query=${preview(subText, 120)}`,
              );
              if (solveCtx.depth + 1 > params.maxDepth) {
                throw new Error(`RLM recursion depth limit reached (${params.maxDepth}).`);
              }
              state.llmCalls += 1;
              const childCtx: RlmSolveContext = {
                depth: solveCtx.depth + 1,
                query: subText,
                persistToMainSession: false,
                sessionId: `rlm-${randomUUID()}`,
                sessionFile: path.join(tmpRoot, `rlm-${randomUUID()}.json`),
              };
              const childResult = await solve(childCtx, state);
              const subcallHandle = await store.putText("subcall", childResult, state.step);
              store.touch(subcallHandle, state.step);
              logger.debug(
                `rlm runtime llm_query end: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} childDepth=${childCtx.depth} handle=${subcallHandle} chars=${childResult.length}`,
              );
              return childResult;
            })(),
          ),
        llm_query_batched: async (subQueries: unknown) => {
          if (!Array.isArray(subQueries)) {
            throw new Error("llm_query_batched requires an array of strings.");
          }
          if (subQueries.length > RLM_MAX_CHILDREN) {
            throw new Error(`llm_query_batched max items is ${RLM_MAX_CHILDREN}.`);
          }
          const out: string[] = [];
          for (const item of subQueries) {
            out.push(await runtimeApi.llm_query(item));
          }
          return out;
        },
        tools_list: () => rlmToolMeta,
        tool_call: (name: unknown, args: unknown): Promise<RlmToolInvocationResult> =>
          trackStepOp(
            (async () => {
              if (toolCallsInStep >= RLM_MAX_TOOL_CALLS_PER_STEP) {
                throw new Error(
                  `RLM max tool calls per step exceeded (${RLM_MAX_TOOL_CALLS_PER_STEP}).`,
                );
              }
              toolCallsInStep += 1;

              const toolName = readRuntimeShorthandTextArg(name, "tool_call(name)", "name");
              if (!toolName) {
                throw new Error("tool_call requires a non-empty tool name.");
              }
              logger.debug(
                `rlm runtime tool_call start: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} tool=${toolName} args=${summarizeUnknown(args, 180)}`,
              );
              const tool = rlmToolsByName.get(toolName);
              if (!tool) {
                logger.debug(
                  `rlm runtime tool_call end: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} tool=${toolName} ok=0 reason=unknown_tool`,
                );
                return {
                  ok: false,
                  tool: toolName,
                  error: `Unknown tool "${toolName}".`,
                };
              }
              const callId = `rlm-tool-${state.step}-${Math.random().toString(36).slice(2, 8)}`;
              const toolArgs =
                args && typeof args === "object" && !Array.isArray(args)
                  ? (args as Record<string, unknown>)
                  : {};
              let result: Awaited<ReturnType<RlmToolDefinition["execute"]>>;
              try {
                result = await tool.execute(
                  callId,
                  toolArgs,
                  undefined,
                  undefined,
                  params.abortSignal,
                );
              } catch (err) {
                logger.warn(
                  `rlm runtime tool_call throw: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} tool=${toolName} error=${summarizeError(err)}`,
                );
                throw err;
              }
              const combined = extractToolResultText(result);
              const stored = combined
                ? truncateHeadTail(combined, RLM_MAX_TOOL_RESULT_CHARS).preview
                : "(empty tool result)";
              const handle = await store.putText("tool", stored, state.step);
              store.touch(handle, state.step);
              const response = {
                ok: !toolResultIsError(result),
                tool: toolName,
                handle,
                preview: truncateHeadTail(stored, RLM_MAX_TOOL_PREVIEW_CHARS).preview,
                ...(toolResultIsError(result) ? { error: preview(stored, 200) } : {}),
              };
              logger.debug(
                `rlm runtime tool_call end: runId=${params.runId} depth=${solveCtx.depth} step=${state.step} tool=${toolName} ok=${response.ok ? "1" : "0"} handle=${handle} preview=${preview(response.preview ?? "", 120)}`,
              );
              return response;
            })(),
          ),
        tool_call_batched: async (calls: unknown): Promise<RlmToolInvocationResult[]> => {
          if (!Array.isArray(calls)) {
            throw new Error("tool_call_batched requires an array.");
          }
          if (calls.length > RLM_MAX_CHILDREN) {
            throw new Error(`tool_call_batched max items is ${RLM_MAX_CHILDREN}.`);
          }
          const out: RlmToolInvocationResult[] = [];
          for (const call of calls) {
            const rec = call && typeof call === "object" ? (call as Record<string, unknown>) : {};
            out.push(await runtimeApi.tool_call(rec.name, rec.args));
          }
          return out;
        },
        get_var: (key: unknown) =>
          state.vars[readRuntimeShorthandTextArg(key, "get_var(key)", "key")],
        set_var: (key: unknown, value: unknown) => {
          state.vars[readRuntimeShorthandTextArg(key, "set_var(key)", "key")] = value;
          return true;
        },
        print: (...args: unknown[]) => {
          stdoutLines.push(args.map((arg) => safeStringify(arg)).join(" "));
        },
        submit: (answer: unknown) => {
          const op = (async () => {
            // Strict: reject non-strings (especially objects) to avoid silent "[object Object]" output.
            // Allow Promises so `submit(llm_query(...))` works even if the REPL forgets to await.
            const resolved = await Promise.resolve(answer);
            if (resolved !== null && typeof resolved === "object") {
              throw new Error(
                "submit(answer) received [object Object]. Serialize structures explicitly (for example: JSON.stringify(value)).",
              );
            }
            if (typeof resolved !== "string") {
              throw new Error(
                `submit(answer) requires a string. Serialize values explicitly (for example: JSON.stringify(value)). Got ${typeof resolved}.`,
              );
            }

            const text = resolved.trim();
            if (!text) {
              throw new Error("submit(answer) requires non-empty text.");
            }
            if (isPromiseSentinelText(text)) {
              throw new Error(
                "submit(answer) received [object Promise]. Await async calls (for example: await llm_query(...)) before submit().",
              );
            }
            if (isObjectSentinelText(text)) {
              throw new Error(
                "submit(answer) received [object Object]. Serialize structures explicitly (for example: JSON.stringify(value)).",
              );
            }
            if (promptRequiresJsonOnly(params.userPrompt)) {
              assertJsonOnlyOutput(text);
            }
            if (requireRepoCalls) {
              if (state.repoSearchCalls <= 0 || state.repoReadCalls <= 0) {
                throw new Error(
                  `submit(answer) requires calling repo_search and repo_read at least once (repo_search=${state.repoSearchCalls}, repo_read=${state.repoReadCalls}).`,
                );
              }
            }
            submitted = text;
            state.final = text;
            return true;
          })();
          // If REPL code throws after calling submit() (without awaiting it), Node may otherwise
          // treat the rejection as unhandled before we drain pendingSubmitOps.
          void op.catch(() => undefined);
          pendingSubmitOps.push(op);
          return op;
        },
      };

      const wrappedCode = `'use strict';\n(async () => {\n${code}\n})()`;
      let scriptError: unknown;
      let returnValue: unknown;
      try {
        const script = new vm.Script(wrappedCode, {
          filename: `rlm-d${solveCtx.depth}-i${iteration}.js`,
        });
        // NOTE: Node.js vm is NOT a security sandbox. The model already has tool
        // access (exec, file I/O) in normal operation so this does not expand the
        // trust boundary. We still use a null-prototype sandbox to reduce accidental
        // constructor-chain access to Node globals, and rely on runtime tool-policy
        // allowlists as the actual control boundary. RLM is gated behind tools.rlm.enabled.
        const sandbox = Object.assign(Object.create(null), runtimeApi, {
          Math,
          JSON,
          Date,
        });
        // vm's built-in timeout throws inside runInContext. Avoid Promise.race timeouts here,
        // because a rejected timer promise would outlive the race winner and trigger unhandled
        // rejections later.
        returnValue = await script.runInContext(vm.createContext(sandbox), { timeout: 1_500 });
      } catch (err) {
        scriptError = err;
      }

      try {
        if (returnValue !== undefined) {
          stdoutLines.push(`[return] ${safeStringify(returnValue)}`);
        }
        // Drain submit promises even if the REPL code threw; otherwise we can leak unhandled rejections.
        await drainOpsWithBudget(pendingSubmitOps, "submit");
        // Drain any in-flight runtime calls (for example an un-awaited llm_query() or tool_call())
        // before we serialize state or tmpRoot cleanup runs.
        await drainOpsWithBudget(pendingStepOps, "runtime");
      } catch (err) {
        const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
        executionError = executionError ? `${executionError}\n\n${detail}` : detail;
      }
      if (scriptError) {
        const detail =
          scriptError instanceof Error
            ? `${scriptError.message}\n${scriptError.stack ?? ""}`
            : summarizeUnknown(scriptError);
        executionError = executionError ? `${executionError}\n\n${detail}` : detail;
      }

      const codeField = serializeCodeForHistory(code);
      const stdoutField = serializeStdoutForHistory(stdoutLines.join("\n"));
      const errorField = executionError ? serializeErrorForHistory(executionError) : undefined;

      if (codeField.truncated) {
        appendWarning(state, "code serialization truncated");
      }
      if (stdoutField.truncated) {
        appendWarning(state, "stdout serialization truncated");
      }
      if (errorField?.truncated) {
        appendWarning(state, "error serialization truncated");
      }

      state.history.push({
        depth: solveCtx.depth,
        iteration,
        code: codeField,
        stdout: stdoutField,
        error: errorField,
        submitted: Boolean(submitted),
      });

      if (state.history.length > RLM_MAX_HISTORY_ENTRIES) {
        state.history.splice(0, state.history.length - RLM_MAX_HISTORY_ENTRIES);
      }

      if (submitted) {
        return submitted;
      }
    }
    if (!extractOnMaxIterations) {
      throw new Error(`RLM max iterations exceeded (${maxIterations}).`);
    }
    const extracted = (await runExtract({ solveCtx, state })).trim();
    if (!extracted) {
      throw new Error("RLM extract fallback returned an empty answer.");
    }
    if (isInvalidFinalText(extracted)) {
      throw new Error("RLM extract fallback produced invalid sentinel output.");
    }
    return extracted;
  };

  try {
    const state: RlmExecutionState = {
      vars: {},
      llmCalls: 0,
      repoSearchCalls: 0,
      repoReadCalls: 0,
      history: [],
      step: 0,
      warnings: [],
    };

    const rootCtx: RlmSolveContext = {
      depth: 0,
      query: params.userPrompt,
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      persistToMainSession: true,
    };

    const finalText = await solve(rootCtx, state);
    if (!finalText.trim()) {
      throw new Error("RLM harness produced an empty final answer.");
    }
    if (isInvalidFinalText(finalText)) {
      throw new Error("RLM harness produced invalid sentinel output.");
    }
    const finalMode =
      typeof state.final === "string" && state.final.trim() === finalText.trim()
        ? "submitted"
        : "extract";

    const finalResult: EmbeddedPiRunResult = {
      payloads: [{ text: finalText }],
      meta: {
        durationMs: Date.now() - startedAt,
        agentMeta: {
          sessionId: params.sessionId,
          provider: lastProvider,
          model: lastModel,
        },
        stopReason: `rlm:${finalMode} depth=${Math.max(...state.history.map((entry) => entry.depth), 0)} steps=${state.history.length} llmCalls=${state.llmCalls} warnings=${state.warnings.length}`,
      },
    };

    return {
      result: finalResult,
      provider: lastProvider,
      model: lastModel,
      stats: {
        llmCalls: state.llmCalls,
        repoSearchCalls: state.repoSearchCalls,
        repoReadCalls: state.repoReadCalls,
        steps: state.history.length,
        warningsCount: state.warnings.length,
      },
    };
  } finally {
    if (!skipCleanup) {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    } else {
      logger.warn(
        `rlm cleanup skipped to avoid op races: runId=${params.runId} tmpRoot=${tmpRoot}`,
      );
    }
  }
}
