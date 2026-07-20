// Generates short labels for sessions from conversation context.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import type { TextContent } from "../../llm/types.js";

const DEFAULT_MAX_LABEL_LENGTH = 128;
// Reasoning models spend output tokens before emitting the short visible label.
// A tiny cap can leave no text, so keep the bounded title budget large enough
// for reasoning while respecting models with a lower output limit.
const CONVERSATION_LABEL_MAX_TOKENS = 4_096;
const TIMEOUT_MS = 15_000;

type PreparedLabelModel = Awaited<ReturnType<typeof prepareSimpleCompletionModelForAgent>>;
type ReadyLabelModel = Extract<PreparedLabelModel, { model: unknown }>;
type LabelModelPhase = "utility" | "primary fallback";

/** Inputs for generating a short conversation label from the configured utility model. */
export type ConversationLabelParams = {
  userMessage: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  maxLength?: number;
};

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function isCodexSimpleCompletionModel(model: { api?: string; provider?: string }): boolean {
  return model.api === "openai-chatgpt-responses";
}

function extractSimpleCompletionError(result: {
  stopReason?: string;
  errorMessage?: string;
}): string | null {
  if (result.stopReason !== "error") {
    return null;
  }
  return result.errorMessage?.trim() || "unknown error";
}

function logLabelFailure(phase: LabelModelPhase, message: string): void {
  const prefix = phase === "utility" ? "" : `${phase} `;
  logVerbose(`conversation-label-generator: ${prefix}${message}`);
}

async function prepareLabelModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  useUtilityModel: boolean;
  phase: LabelModelPhase;
}): Promise<PreparedLabelModel | null> {
  try {
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      useUtilityModel: params.useUtilityModel,
      useAsyncModelResolution: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
    if ("error" in prepared) {
      logLabelFailure(params.phase, prepared.error);
    }
    return prepared;
  } catch (err) {
    logLabelFailure(params.phase, `model preparation failed: ${String(err)}`);
    return null;
  }
}

function selectedLabelModelsMatch(
  first: PreparedLabelModel | null,
  second: PreparedLabelModel | null,
): boolean {
  const firstSelection = first && "selection" in first ? first.selection : undefined;
  const secondSelection = second && "selection" in second ? second.selection : undefined;
  return Boolean(
    firstSelection &&
    secondSelection &&
    firstSelection.provider === secondSelection.provider &&
    firstSelection.runtimeProvider === secondSelection.runtimeProvider &&
    firstSelection.modelId === secondSelection.modelId &&
    firstSelection.profileId === secondSelection.profileId,
  );
}

async function completeLabel(params: {
  prepared: ReadyLabelModel;
  cfg: OpenClawConfig;
  userMessage: string;
  prompt: string;
  maxLength: number;
  phase: LabelModelPhase;
}): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const maxTokens = Math.min(
      CONVERSATION_LABEL_MAX_TOKENS,
      Math.floor(params.prepared.model.maxTokens),
    );
    // Label generation should never block normal reply handling for long.
    const result = await completeWithPreparedSimpleCompletionModel({
      model: params.prepared.model,
      auth: params.prepared.auth,
      cfg: params.cfg,
      context: {
        systemPrompt: params.prompt,
        messages: [
          {
            role: "user",
            content: params.userMessage,
            timestamp: Date.now(),
          },
        ],
      },
      options: {
        maxTokens,
        ...(isCodexSimpleCompletionModel(params.prepared.model) ? {} : { temperature: 0.3 }),
        signal: controller.signal,
      },
    });
    const errorMessage = extractSimpleCompletionError(result);
    if (errorMessage) {
      logLabelFailure(params.phase, `completion failed: ${errorMessage}`);
      return null;
    }

    const text = result.content
      .filter(isTextContentBlock)
      .map((block) => block.text)
      .join("")
      .trim();

    if (!text) {
      return null;
    }

    return truncateUtf16Safe(text, params.maxLength) || null;
  } catch (err) {
    logLabelFailure(params.phase, `completion failed: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Generates a bounded human-readable label for a session, or null on failure. */
export async function generateConversationLabel(
  params: ConversationLabelParams,
): Promise<string | null> {
  const { userMessage, prompt, cfg, agentId, agentDir } = params;
  const maxLength =
    typeof params.maxLength === "number" &&
    Number.isFinite(params.maxLength) &&
    params.maxLength > 0
      ? Math.floor(params.maxLength)
      : DEFAULT_MAX_LABEL_LENGTH;
  const resolvedAgentId = agentId ?? resolveDefaultAgentId(cfg);
  const utilityPrepared = await prepareLabelModel({
    cfg,
    agentId: resolvedAgentId,
    agentDir,
    useUtilityModel: true,
    phase: "utility",
  });
  const utilityCompletionAttempted = Boolean(utilityPrepared && !("error" in utilityPrepared));
  if (utilityPrepared && !("error" in utilityPrepared)) {
    const label = await completeLabel({
      prepared: utilityPrepared,
      cfg,
      userMessage,
      prompt,
      maxLength,
      phase: "utility",
    });
    if (label) {
      return label;
    }
  }

  const primaryPrepared = await prepareLabelModel({
    cfg,
    agentId: resolvedAgentId,
    agentDir,
    useUtilityModel: false,
    phase: "primary fallback",
  });
  if (
    !primaryPrepared ||
    "error" in primaryPrepared ||
    (utilityCompletionAttempted && selectedLabelModelsMatch(utilityPrepared, primaryPrepared))
  ) {
    return null;
  }
  return await completeLabel({
    prepared: primaryPrepared,
    cfg,
    userMessage,
    prompt,
    maxLength,
    phase: "primary fallback",
  });
}
