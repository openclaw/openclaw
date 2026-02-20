import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import type { OpenClawConfig } from "../../config/config.js";

export type VerificationResult = { passed: boolean; feedback?: string };

const DEFAULT_TIMEOUT_MS = 15_000;

const VERIFICATION_SYSTEM_PROMPT = [
  "You are a response quality verifier. Your sole task is to evaluate whether an AI assistant's response adequately addresses the user's request.",
  "",
  "Evaluate the response against these criteria:",
  "1. Does the response address the user's actual question or request?",
  "2. Is the response reasonably complete (not truncated or clearly unfinished)?",
  "3. Does the response avoid being an unnecessary refusal when the request is reasonable?",
  "",
  "If the response meets the goal, reply with exactly:",
  "PASS",
  "",
  "If the response does NOT meet the goal, reply with:",
  "FAIL: <detailed reason why the response is inadequate>",
  "",
  "Do not add any other text.",
].join("\n");

/**
 * Parse the raw verifier LLM response. Returns `{ passed: true }` for
 * PASS, empty, or malformed responses (fail-open). Returns `{ passed: false,
 * feedback }` only when a `FAIL: <reason>` prefix is found.
 */
export function parseVerificationResponse(raw: string): VerificationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { passed: true };
  }

  if (/^PASS$/m.test(trimmed)) {
    return { passed: true };
  }

  const failMatch = /^FAIL:\s*(.+)/ms.exec(trimmed);
  if (failMatch) {
    return { passed: false, feedback: failMatch[1].trim() };
  }

  // Fail-open: malformed verifier output never blocks delivery.
  return { passed: true };
}

/**
 * Standalone LLM call to verify an agent response. Fail-open on timeout,
 * LLM error, or malformed response — delivery is never blocked.
 */
export async function verifyAgentResponse(params: {
  userMessage: string;
  agentResponse: string;
  model: string;
  cfg: OpenClawConfig;
  timeoutMs?: number;
}): Promise<VerificationResult> {
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
              content:
                `${VERIFICATION_SYSTEM_PROMPT}\n\n` +
                `<user_message>\n${params.userMessage}\n</user_message>\n\n` +
                `<agent_response>\n${params.agentResponse}\n</agent_response>`,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: 256,
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
