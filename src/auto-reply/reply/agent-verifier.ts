import fs from "node:fs/promises";
import path from "node:path";
import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { DEFAULT_AGENTS_FILENAME, DEFAULT_SOUL_FILENAME } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/config.js";

// ─── Types ─────────────────────────────────────────────────────────────

export type VerificationResult = {
  passed: boolean;
  feedback?: string;
  /** Structured failure category for smarter retries. */
  failCategory?: FailCategory;
};

export type FailCategory =
  | "goal_missed"
  | "incomplete"
  | "rule_violation"
  | "tone_mismatch"
  | "refusal";

/**
 * Reason the verifier was skipped (deterministic pre-check).
 * Returned by `shouldSkipVerification` to enable log-level reporting.
 */
export type SkipReason =
  | "tool_calls"
  | "error_response"
  | "messaging_tool_sent"
  | "block_streaming_sent"
  | "empty_response";

/** Execution metadata surfaced to the verifier for richer evaluation. */
export type VerifierRunMeta = {
  stopReason?: string;
  pendingToolCalls?: boolean;
  didSendViaMessagingTool?: boolean;
  messagingToolSentTexts?: string[];
  durationMs?: number;
};

/** Conversation history entry (from InboundHistory). */
export type VerifierHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
};

export type VerifyAgentResponseParams = {
  userMessage: string;
  agentResponse: string;
  model: string;
  cfg: OpenClawConfig;
  timeoutMs?: number;
  /** Execution metadata for richer evaluation. */
  runMeta?: VerifierRunMeta;
  /** Conversation history (last N turns). */
  conversationHistory?: VerifierHistoryEntry[];
  /** Workspace directory for reading AGENTS.md / SOUL.md. */
  workspaceDir?: string;
  /** Extra system prompt assembled by the agent runtime. */
  extraSystemPrompt?: string;
  /** Previous verification feedback (for retry context). */
  previousFeedback?: string;
};

// ─── Constants ─────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;

/** Soft char budget for the full verifier prompt (~8K tokens at ~4 chars/token). */
const CONTEXT_CHAR_BUDGET = 32_000;
/** Max chars for user rules (AGENTS.md + SOUL.md combined). */
const USER_RULES_CHAR_CAP = 8_000;
/** Max conversation history entries. */
const MAX_HISTORY_ENTRIES = 5;
/** Max chars for agent response before truncation. */
const AGENT_RESPONSE_CHAR_CAP = 12_000;

// ─── Enhanced Verifier System Prompt ───────────────────────────────────

const VERIFICATION_SYSTEM_PROMPT = `You are a response quality verifier. Evaluate whether an AI assistant's response achieves the user's goal.

## Evaluation Method
Think step-by-step through each dimension before reaching a verdict.

## Evaluation Dimensions
1. **Goal Achievement**: Does the response directly address what the user asked?
2. **Completeness**: Is the response thorough and not truncated or superficially brief?
3. **Rule Compliance**: Does the response follow user rules and instructions (if provided)?

## Output Format
First, briefly reason through each dimension (2-3 sentences total).

Then on a new line, output your verdict:
- If the response meets all dimensions: **PASS**
- If the response fails any dimension, output:
  **FAIL [category]: <specific actionable feedback>**

Valid categories: goal_missed, incomplete, rule_violation, tone_mismatch, refusal

Example outputs:
\`\`\`
The response directly answers the question about API design, covers all endpoints mentioned, and follows the concise style requested.
PASS
\`\`\`
\`\`\`
The response addresses the question but omits error handling which was explicitly requested.
FAIL [incomplete]: Missing error handling for the API endpoints. The user specifically asked for robust error handling with try/catch blocks and proper HTTP status codes.
\`\`\``;

// ─── Deterministic Pre-checks ──────────────────────────────────────────

/**
 * Deterministic pre-checks that skip verification without an LLM call.
 * Returns a skip reason if verification should be skipped, or `undefined` to proceed.
 */
export function shouldSkipVerification(params: {
  responseText: string;
  runMeta?: VerifierRunMeta;
  directlySentBlockKeys?: Set<string>;
}): SkipReason | undefined {
  // Skip when agent stopped to make tool calls (intermediate turn, not final response)
  if (params.runMeta?.stopReason === "tool_calls" || params.runMeta?.pendingToolCalls) {
    return "tool_calls";
  }

  // Skip when agent already sent content via messaging tool (e.g. WhatsApp send)
  if (params.runMeta?.didSendViaMessagingTool) {
    return "messaging_tool_sent";
  }

  // Skip when block streaming already delivered content to the user
  if (params.directlySentBlockKeys && params.directlySentBlockKeys.size > 0) {
    return "block_streaming_sent";
  }

  // Skip on empty response
  if (!params.responseText.trim()) {
    return "empty_response";
  }

  return undefined;
}

// ─── Workspace File Reading ────────────────────────────────────────────

/**
 * Read a workspace file (AGENTS.md or SOUL.md) with a character cap.
 * Returns empty string on any error (file missing, permission, etc.).
 */
async function readWorkspaceFile(
  workspaceDir: string,
  filename: string,
  charCap: number,
): Promise<string> {
  try {
    const filePath = path.join(workspaceDir, filename);
    const content = await fs.readFile(filePath, "utf-8");
    if (content.length > charCap) {
      return content.slice(0, charCap) + "\n[... truncated]";
    }
    return content;
  } catch {
    return "";
  }
}

// ─── Context Assembly ──────────────────────────────────────────────────

/**
 * Assemble the full verifier context string with token-budgeted sections.
 *
 * Context ordering follows the "Lost in the Middle" mitigation:
 * - Critical context at START and END
 * - Less critical context in the MIDDLE
 *
 * Priority order (trim from bottom up when over budget):
 * 1. Verifier system prompt (fixed, ~1K chars)
 * 2. User message (never trimmed)
 * 3. Agent response (truncate tail if massive)
 * 4. Execution metadata (tiny, always include)
 * 5. User rules (AGENTS.md, SOUL.md — cap at USER_RULES_CHAR_CAP)
 * 6. Conversation history (last N turns — trim oldest first)
 * 7. Extra system prompt (lowest priority)
 */
export async function assembleVerifierContext(params: VerifyAgentResponseParams): Promise<string> {
  const sections: string[] = [];

  // ── Section 1: User message (near start — high priority) ──
  sections.push(`<user_message>\n${params.userMessage}\n</user_message>`);

  // ── Section 2: User rules (middle — medium priority) ──
  if (params.workspaceDir) {
    const [agentsMd, soulMd] = await Promise.all([
      readWorkspaceFile(params.workspaceDir, DEFAULT_AGENTS_FILENAME, USER_RULES_CHAR_CAP),
      readWorkspaceFile(
        params.workspaceDir,
        DEFAULT_SOUL_FILENAME,
        Math.max(0, USER_RULES_CHAR_CAP - 4_000),
      ),
    ]);

    const rulesContent: string[] = [];
    if (agentsMd) {
      rulesContent.push(`### AGENTS.md\n${agentsMd}`);
    }
    if (soulMd) {
      rulesContent.push(`### SOUL.md\n${soulMd}`);
    }

    if (rulesContent.length > 0) {
      sections.push(`<user_rules>\n${rulesContent.join("\n\n")}\n</user_rules>`);
    }
  }

  // ── Section 3: Conversation history (middle — lower priority) ──
  if (params.conversationHistory && params.conversationHistory.length > 0) {
    const recentHistory = params.conversationHistory.slice(-MAX_HISTORY_ENTRIES);
    const historyLines = recentHistory.map((entry) => `[${entry.sender}]: ${entry.body}`);
    sections.push(`<conversation_history>\n${historyLines.join("\n")}\n</conversation_history>`);
  }

  // ── Section 4: Execution metadata (middle — tiny, always include) ──
  if (params.runMeta) {
    const metaParts: string[] = [];
    if (params.runMeta.stopReason) {
      metaParts.push(`stop_reason: ${params.runMeta.stopReason}`);
    }
    if (params.runMeta.durationMs !== undefined) {
      metaParts.push(`duration: ${params.runMeta.durationMs}ms`);
    }
    if (metaParts.length > 0) {
      sections.push(`<execution_context>\n${metaParts.join(", ")}\n</execution_context>`);
    }
  }

  // ── Section 5: Previous feedback (for retries) ──
  if (params.previousFeedback) {
    sections.push(
      `<previous_verification_feedback>\n${params.previousFeedback}\n</previous_verification_feedback>`,
    );
  }

  // ── Section 6: Agent response (at END — high priority for recency) ──
  let agentResponse = params.agentResponse;
  if (agentResponse.length > AGENT_RESPONSE_CHAR_CAP) {
    agentResponse = agentResponse.slice(0, AGENT_RESPONSE_CHAR_CAP) + "\n[... response truncated]";
  }
  sections.push(`<agent_response>\n${agentResponse}\n</agent_response>`);

  // ── Apply budget ──
  let assembled = sections.join("\n\n");

  // If over budget, trim conversation history first, then user rules
  if (assembled.length > CONTEXT_CHAR_BUDGET) {
    const trimmedSections = sections.filter(
      (s) => !s.startsWith("<conversation_history>") && !s.startsWith("<extra_system_prompt>"),
    );
    assembled = trimmedSections.join("\n\n");
  }

  return assembled;
}

// ─── Response Parsing ──────────────────────────────────────────────────

/**
 * Parse the raw verifier LLM response. Returns `{ passed: true }` for
 * PASS, empty, or malformed responses (fail-open). Returns `{ passed: false,
 * feedback, failCategory }` when a `FAIL [category]: <reason>` is found.
 */
export function parseVerificationResponse(raw: string): VerificationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { passed: true };
  }

  if (/^PASS$/m.test(trimmed) || /\*\*PASS\*\*/m.test(trimmed)) {
    return { passed: true };
  }

  // Match structured FAIL with category: FAIL [category]: reason
  // Also handles **FAIL [category]**: reason (markdown bold)
  const structuredFail = /\*?\*?FAIL\s*\[(\w+)\]\*?\*?:\s*(.+)/ms.exec(trimmed);
  if (structuredFail) {
    const category = structuredFail[1] as FailCategory;
    const validCategories: FailCategory[] = [
      "goal_missed",
      "incomplete",
      "rule_violation",
      "tone_mismatch",
      "refusal",
    ];
    return {
      passed: false,
      feedback: structuredFail[2].trim(),
      failCategory: validCategories.includes(category) ? category : undefined,
    };
  }

  // Legacy format: FAIL: reason (no category)
  const legacyFail = /\*?\*?FAIL\*?\*?:\s*(.+)/ms.exec(trimmed);
  if (legacyFail) {
    return { passed: false, feedback: legacyFail[1].trim() };
  }

  // Fail-open: malformed verifier output never blocks delivery.
  return { passed: true };
}

// ─── Main Verification Function ────────────────────────────────────────

/**
 * Standalone LLM call to verify an agent response. Fail-open on timeout,
 * LLM error, or malformed response — delivery is never blocked.
 *
 * Enhanced version: accepts full context (workspace files, conversation
 * history, execution metadata) for richer evaluation.
 */
export async function verifyAgentResponse(
  params: VerifyAgentResponseParams,
): Promise<VerificationResult> {
  try {
    const ref = parseModelRef(params.model, DEFAULT_PROVIDER);
    if (!ref) {
      return { passed: true };
    }

    const resolved = resolveModel(ref.provider, ref.model, undefined, params.cfg);
    if (!resolved.model) {
      return { passed: true };
    }

    const apiKeyInfo = await getApiKeyForModel({
      model: resolved.model,
      cfg: params.cfg,
    });
    const apiKey = requireApiKey(apiKeyInfo, ref.provider);

    // Assemble full context with token budgeting
    const contextBody = await assembleVerifierContext(params);

    const controller = new AbortController();
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await completeSimple(
        resolved.model,
        {
          messages: [
            {
              role: "user",
              content: `${VERIFICATION_SYSTEM_PROMPT}\n\n${contextBody}`,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: 512,
          temperature: 0,
          signal: controller.signal,
        },
      );

      const text = res.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(" ")
        .trim();

      return parseVerificationResponse(text);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Fail-open: never block delivery due to verifier issues.
    return { passed: true };
  }
}
