import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineInfo,
} from "openclaw/plugin-sdk/structured-context";
import type { StructuredContextPluginConfig } from "./config.js";

type ArtifactReference = {
  id: string;
  path: string;
  summary: string;
  bytes: number;
  createdAt: number;
  toolName?: string;
  toolCallId?: string;
};

type ContextRecord = {
  decisions: string[];
  openTodos: string[];
  constraints: string[];
  pendingUserAsks: string[];
  exactIdentifiers: string[];
  artifactRefs: ArtifactReference[];
  generatedAt: number;
};

type ToolPayload = {
  text: string;
  toolName?: string;
  toolCallId?: string;
};

type Layer0Store = {
  recordsBySessionId: Map<string, ContextRecord>;
};

type CreateEngineParams = {
  config: StructuredContextPluginConfig;
  compactFn?: (params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }) => Promise<CompactResult>;
  artifactThresholdChars?: number;
};

const STORE_SYMBOL = Symbol.for("openclaw.structuredContext.layer0.store");
const DEFAULT_ARTIFACT_THRESHOLD_CHARS = 4_000;

const INSTRUCTION_PATTERN =
  /\b(please|must|need to|should|implement|fix|add|remove|update|ensure|帮我|请|实现|修复|新增|移除|更新|确保)\b/i;
const DECISION_PATTERN =
  /\b(decision|decided|we will|i will|plan|chose|结论|决定|我将|计划|采取)\b/i;
const TODO_PATTERN = /\b(todo|next step|follow-up|action item|待办|下一步|后续)\b/i;
const CONSTRAINT_PATTERN =
  /\b(must|never|always|do not|without|only|constraint|禁止|不要|必须|只能|不得|约束|限制)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getGlobalStore(): Layer0Store {
  const globalState = globalThis as typeof globalThis & {
    [STORE_SYMBOL]?: Layer0Store;
  };

  if (!globalState[STORE_SYMBOL]) {
    globalState[STORE_SYMBOL] = {
      recordsBySessionId: new Map<string, ContextRecord>(),
    };
  }

  return globalState[STORE_SYMBOL];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (typeof block.content === "string") {
      parts.push(block.content);
    }
  }

  return parts.join("\n").trim();
}

function extractTextFromMessage(message: AgentMessage): string {
  return normalizeText(extractTextFromContent((message as { content?: unknown }).content));
}

function estimateTokens(messages: AgentMessage[]): number {
  let totalChars = 0;
  for (const message of messages) {
    totalChars += extractTextFromMessage(message).length;
  }
  return Math.max(1, Math.ceil(totalChars / 4));
}

function extractIdentifiers(text: string): string[] {
  const values = new Set<string>();

  const pushMatch = (candidate: string) => {
    const normalized = candidate.trim();
    if (!normalized || normalized.length > 180) {
      return;
    }
    values.add(normalized);
  };

  for (const match of text.matchAll(/`([^`\n]{2,180})`/g)) {
    if (match[1]) {
      pushMatch(match[1]);
    }
  }

  for (const match of text.matchAll(/#[0-9]{2,8}/g)) {
    pushMatch(match[0]);
  }

  for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    pushMatch(match[0]);
  }

  for (const match of text.matchAll(/(?:[A-Za-z]:\\|\/)[\w./-]{2,}/g)) {
    pushMatch(match[0]);
  }

  for (const match of text.matchAll(/\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yaml|yml|toml)\b/g)) {
    pushMatch(match[0]);
  }

  return [...values];
}

function classifyMessages(
  messages: AgentMessage[],
  artifactRefs: ArtifactReference[] = [],
): ContextRecord {
  const decisions: string[] = [];
  const openTodos: string[] = [];
  const constraints: string[] = [];
  const pendingUserAsks: string[] = [];
  const exactIdentifiers: string[] = [];
  const userMessages: string[] = [];

  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : "";
    const text = extractTextFromMessage(message);
    if (!text) {
      continue;
    }

    exactIdentifiers.push(...extractIdentifiers(text));

    const lines = text
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter(Boolean);

    if (role === "user") {
      userMessages.push(text);
      for (const line of lines) {
        if (CONSTRAINT_PATTERN.test(line)) {
          constraints.push(line);
        }
        if (INSTRUCTION_PATTERN.test(line) && !CONSTRAINT_PATTERN.test(line)) {
          pendingUserAsks.push(line);
        }
        if (TODO_PATTERN.test(line)) {
          openTodos.push(line);
        }
      }
      continue;
    }

    if (role === "assistant") {
      for (const line of lines) {
        if (DECISION_PATTERN.test(line)) {
          decisions.push(line);
        }
        if (TODO_PATTERN.test(line)) {
          openTodos.push(line);
        }
        if (CONSTRAINT_PATTERN.test(line)) {
          constraints.push(line);
        }
      }
    }
  }

  const latestAsks = userMessages
    .slice(-3)
    .map((entry) => entry.split(/\n+/)[0] ?? entry)
    .map((entry) => normalizeText(entry))
    .filter(Boolean);

  pendingUserAsks.push(...latestAsks);

  return {
    decisions: dedupeInOrder(decisions).slice(0, 20),
    openTodos: dedupeInOrder(openTodos).slice(0, 20),
    constraints: dedupeInOrder(constraints).slice(0, 20),
    pendingUserAsks: dedupeInOrder(pendingUserAsks).slice(0, 20),
    exactIdentifiers: dedupeInOrder(exactIdentifiers).slice(0, 40),
    artifactRefs,
    generatedAt: Date.now(),
  };
}

function dedupeInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function composeSystemPromptAddition(record: ContextRecord): string | undefined {
  const sections: string[] = [];

  if (record.constraints.length > 0) {
    sections.push(`Constraints: ${record.constraints.slice(0, 5).join(" | ")}`);
  }
  if (record.decisions.length > 0) {
    sections.push(`Decisions: ${record.decisions.slice(0, 5).join(" | ")}`);
  }
  if (record.openTodos.length > 0) {
    sections.push(`Open TODOs: ${record.openTodos.slice(0, 5).join(" | ")}`);
  }
  if (record.pendingUserAsks.length > 0) {
    sections.push(`Pending asks: ${record.pendingUserAsks.slice(0, 5).join(" | ")}`);
  }
  if (record.exactIdentifiers.length > 0) {
    sections.push(`Identifiers: ${record.exactIdentifiers.slice(0, 8).join(" | ")}`);
  }

  if (sections.length === 0) {
    return undefined;
  }

  return ["[Layer0 Continuity Hints]", ...sections].join("\n");
}

function takeRecentTurns(messages: AgentMessage[], recentTurns: number): AgentMessage[] {
  if (recentTurns <= 0) {
    return messages;
  }

  let userTurnCount = 0;
  let startIndex = 0;

  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const role = typeof messages[idx]?.role === "string" ? messages[idx].role : "";
    if (role === "user") {
      userTurnCount += 1;
      if (userTurnCount >= recentTurns) {
        startIndex = idx;
        break;
      }
    }
  }

  return messages.slice(startIndex);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
}

function collectOversizedToolPayloads(
  messages: AgentMessage[],
  thresholdChars: number,
): ToolPayload[] {
  const collected: ToolPayload[] = [];
  for (const message of messages) {
    if (message.role !== "toolResult") {
      continue;
    }
    const text = extractTextFromMessage(message);
    if (!text || text.length < thresholdChars) {
      continue;
    }
    collected.push({
      text,
      toolCallId:
        typeof (message as { toolCallId?: unknown }).toolCallId === "string"
          ? (message as { toolCallId: string }).toolCallId
          : undefined,
      toolName:
        typeof (message as { toolName?: unknown }).toolName === "string"
          ? (message as { toolName: string }).toolName
          : undefined,
    });
  }
  return collected;
}

async function writeArtifactReferences(params: {
  sessionFile: string;
  sessionId: string;
  payloads: ToolPayload[];
}): Promise<ArtifactReference[]> {
  if (params.payloads.length === 0) {
    return [];
  }

  const artifactsDir = path.join(
    path.dirname(params.sessionFile),
    ".context-engine-artifacts",
    "structured-context",
    sanitizePathSegment(params.sessionId),
  );

  await fs.mkdir(artifactsDir, { recursive: true });

  const refs: ArtifactReference[] = [];
  const ts = Date.now();
  for (let idx = 0; idx < params.payloads.length; idx += 1) {
    const payload = params.payloads[idx];
    const id = `${sanitizePathSegment(params.sessionId)}-${ts}-${idx}`;
    const filePath = path.join(artifactsDir, `${id}.txt`);

    const content = [
      `# Layer0 Artifact ${id}`,
      payload.toolName ? `toolName=${payload.toolName}` : "",
      payload.toolCallId ? `toolCallId=${payload.toolCallId}` : "",
      "",
      payload.text,
    ]
      .filter(Boolean)
      .join("\n");

    await fs.writeFile(filePath, content, "utf8");

    refs.push({
      id,
      path: filePath,
      summary: normalizeText(payload.text).slice(0, 300),
      bytes: Buffer.byteLength(payload.text, "utf8"),
      createdAt: ts,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
    });
  }

  return refs;
}

async function readMessagesFromSessionFile(sessionFile: string): Promise<AgentMessage[]> {
  const raw = await fs.readFile(sessionFile, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { type?: unknown; message?: unknown };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { type?: unknown; message?: AgentMessage } => Boolean(entry))
    .filter((entry) => entry.type === "message" && Boolean(entry.message))
    .map((entry) => entry.message as AgentMessage);
}

function buildFallbackSummary(record: ContextRecord): string {
  const lines = ["## Decisions"];
  lines.push(
    ...(record.decisions.length > 0 ? record.decisions.map((item) => `- ${item}`) : ["- none"]),
  );
  lines.push("", "## Open TODOs");
  lines.push(
    ...(record.openTodos.length > 0 ? record.openTodos.map((item) => `- ${item}`) : ["- none"]),
  );
  lines.push("", "## Constraints/Rules");
  lines.push(
    ...(record.constraints.length > 0 ? record.constraints.map((item) => `- ${item}`) : ["- none"]),
  );
  lines.push("", "## Pending user asks");
  lines.push(
    ...(record.pendingUserAsks.length > 0
      ? record.pendingUserAsks.map((item) => `- ${item}`)
      : ["- none"]),
  );
  lines.push("", "## Exact identifiers");
  lines.push(
    ...(record.exactIdentifiers.length > 0
      ? record.exactIdentifiers.map((item) => `- ${item}`)
      : ["- none"]),
  );
  return lines.join("\n");
}

function mergeCompactionDetails(existingDetails: unknown, record: ContextRecord) {
  const details = isRecord(existingDetails) ? { ...existingDetails } : {};
  return {
    ...details,
    contextRecord: record,
    artifactRefs: record.artifactRefs,
    contextEngine: {
      id: "structured-context",
      layer: "layer0",
      version: "1.0.0",
    },
  };
}

function patchRuntimeConfigForCompaction(params: {
  runtimeContext?: ContextEngineRuntimeContext;
  pluginConfig: StructuredContextPluginConfig;
  customInstructions?: string;
}): ContextEngineRuntimeContext | undefined {
  const runtimeContext = params.runtimeContext;
  if (!isRecord(runtimeContext)) {
    return runtimeContext;
  }

  const originalConfig = runtimeContext.config;
  if (!isRecord(originalConfig)) {
    return {
      ...runtimeContext,
      customInstructions: params.customInstructions,
    };
  }

  const agents = isRecord(originalConfig.agents) ? originalConfig.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const existingCompaction = isRecord(defaults.compaction) ? defaults.compaction : {};
  const existingQualityGuard = isRecord(existingCompaction.qualityGuard)
    ? existingCompaction.qualityGuard
    : {};

  const patchedConfig = {
    ...originalConfig,
    agents: {
      ...agents,
      defaults: {
        ...defaults,
        compaction: {
          ...existingCompaction,
          mode: "safeguard",
          recentTurnsPreserve: params.pluginConfig.context.recentTurns,
          qualityGuard: {
            ...existingQualityGuard,
            enabled: params.pluginConfig.context.qualityGuardEnabled,
            maxRetries: params.pluginConfig.context.qualityGuardMaxRetries,
          },
        },
      },
    },
  };

  return {
    ...runtimeContext,
    config: patchedConfig,
  };
}

async function callDefaultCompaction(params: {
  sessionId: string;
  sessionFile: string;
  tokenBudget?: number;
  force?: boolean;
  currentTokenCount?: number;
  customInstructions?: string;
  runtimeContext?: ContextEngineRuntimeContext;
}): Promise<CompactResult> {
  const { compactEmbeddedPiSessionDirect } =
    await import("../../../agents/pi-embedded-runner/compact.runtime.js");

  const runtimeContext = params.runtimeContext ?? {};
  const result = await compactEmbeddedPiSessionDirect({
    ...runtimeContext,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    tokenBudget: params.tokenBudget,
    currentTokenCount: params.currentTokenCount,
    force: params.force,
    customInstructions: params.customInstructions,
    workspaceDir: (runtimeContext as { workspaceDir?: string }).workspaceDir ?? process.cwd(),
  });

  return {
    ok: result.ok,
    compacted: result.compacted,
    reason: result.reason,
    result: result.result
      ? {
          summary: result.result.summary,
          firstKeptEntryId: result.result.firstKeptEntryId,
          tokensBefore: result.result.tokensBefore,
          tokensAfter: result.result.tokensAfter,
          details: result.result.details,
        }
      : undefined,
  };
}

export function createLayer0ContextEngine(params: CreateEngineParams): ContextEngine {
  const artifactThresholdChars = params.artifactThresholdChars ?? DEFAULT_ARTIFACT_THRESHOLD_CHARS;
  const compactFn = params.compactFn ?? callDefaultCompaction;
  const sharedStore = getGlobalStore();

  const info: ContextEngineInfo = {
    id: "structured-context",
    name: "Structured Context Layer0 Context Engine",
    version: "1.0.0",
    ownsCompaction: true,
  };

  return {
    info,

    async ingest() {
      return { ingested: false };
    },

    async bootstrap() {
      return { bootstrapped: true, reason: "layer0-no-import" };
    },

    async assemble(assembleParams): Promise<AssembleResult> {
      if (!params.config.context.enabled) {
        return {
          messages: assembleParams.messages,
          estimatedTokens: estimateTokens(assembleParams.messages),
        };
      }

      const fullRecord = classifyMessages(assembleParams.messages);
      sharedStore.recordsBySessionId.set(assembleParams.sessionId, fullRecord);

      const estimatedTokens = estimateTokens(assembleParams.messages);
      const shouldTrim =
        typeof assembleParams.tokenBudget === "number" &&
        assembleParams.tokenBudget > 0 &&
        estimatedTokens > Math.floor(assembleParams.tokenBudget * 1.1);

      const messages = shouldTrim
        ? takeRecentTurns(assembleParams.messages, params.config.context.recentTurns)
        : assembleParams.messages;

      return {
        messages,
        estimatedTokens: estimateTokens(messages),
        systemPromptAddition: composeSystemPromptAddition(fullRecord),
      };
    },

    async afterTurn(afterTurnParams) {
      if (!params.config.context.enabled) {
        return;
      }
      const record = classifyMessages(afterTurnParams.messages);
      sharedStore.recordsBySessionId.set(afterTurnParams.sessionId, record);
    },

    async compact(compactParams): Promise<CompactResult> {
      const messagesFromSession = await readMessagesFromSessionFile(
        compactParams.sessionFile,
      ).catch(() => []);
      const storeRecord = sharedStore.recordsBySessionId.get(compactParams.sessionId);
      const baseMessages = messagesFromSession.length > 0 ? messagesFromSession : [];

      const customInstructions = [
        compactParams.customInstructions?.trim(),
        "Use structured sections: Decisions, Open TODOs, Constraints/Rules, Pending user asks, Exact identifiers.",
      ]
        .filter(Boolean)
        .join("\n\n");

      const runtimeContext = patchRuntimeConfigForCompaction({
        runtimeContext: compactParams.runtimeContext,
        pluginConfig: params.config,
        customInstructions,
      });

      const artifactRefs =
        params.config.context.enabled &&
        params.config.context.oversizedToolOutputPolicy === "artifact_ref" &&
        baseMessages.length > 0
          ? await writeArtifactReferences({
              sessionFile: compactParams.sessionFile,
              sessionId: compactParams.sessionId,
              payloads: collectOversizedToolPayloads(baseMessages, artifactThresholdChars),
            }).catch(() => [])
          : [];

      const record =
        baseMessages.length > 0
          ? classifyMessages(baseMessages, artifactRefs)
          : storeRecord
            ? { ...storeRecord, artifactRefs }
            : classifyMessages([], artifactRefs);

      sharedStore.recordsBySessionId.set(compactParams.sessionId, record);

      const fallbackSummary = buildFallbackSummary(record);
      const compactResult = await compactFn({
        sessionId: compactParams.sessionId,
        sessionFile: compactParams.sessionFile,
        tokenBudget: compactParams.tokenBudget,
        force: compactParams.force,
        currentTokenCount: compactParams.currentTokenCount,
        customInstructions,
        runtimeContext,
      });

      const tokensBefore =
        compactResult.result?.tokensBefore ??
        compactParams.currentTokenCount ??
        (baseMessages.length > 0 ? estimateTokens(baseMessages) : 0);

      const details = mergeCompactionDetails(compactResult.result?.details, record);
      const summary = compactResult.result?.summary?.trim() || fallbackSummary;

      if (!compactResult.result) {
        return {
          ...compactResult,
          result: {
            summary,
            tokensBefore,
            tokensAfter: undefined,
            details,
          },
        };
      }

      return {
        ...compactResult,
        result: {
          ...compactResult.result,
          summary,
          tokensBefore,
          details,
        },
      };
    },
  };
}

export const __testing = {
  buildFallbackSummary,
  classifyMessages,
  collectOversizedToolPayloads,
  composeSystemPromptAddition,
  dedupeInOrder,
  extractIdentifiers,
  extractTextFromMessage,
  mergeCompactionDetails,
  patchRuntimeConfigForCompaction,
  readMessagesFromSessionFile,
  takeRecentTurns,
};
