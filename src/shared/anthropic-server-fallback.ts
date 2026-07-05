import type { AssistantMessageDiagnostic } from "../llm/types.js";

/**
 * Anthropic server-side refusal fallback (`server-side-fallback-2026-06-01`).
 * When Claude Fable 5 safety classifiers decline a request, the API re-serves
 * the same call on a permitted fallback model inside the same stream instead
 * of returning `stop_reason: "refusal"`.
 * https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
 */
export const ANTHROPIC_SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-06-01";

// Anthropic contract: claude-opus-4-8 is the only entry in claude-fable-5's
// published `allowed_fallback_models`; other targets are rejected up front.
export const CLAUDE_FABLE_5_FALLBACK_MODEL = "claude-opus-4-8";

// Fallback-served turns bill at the serving model's rates (top-level usage
// covers only that attempt), so cost math must switch off the Fable table.
// Claude Opus 4.8 per-MTok pricing, same shape as the bundled Fable table.
export const CLAUDE_FABLE_5_FALLBACK_MODEL_COST = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
} as const;

export function buildAnthropicServerSideFallbacks(): Array<{ model: string }> {
  return [{ model: CLAUDE_FABLE_5_FALLBACK_MODEL }];
}

export type AnthropicFallbackBoundary = {
  fromModel: string | null;
  toModel: string | null;
};

function readBoundaryModel(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const model = (value as { model?: unknown }).model;
  return typeof model === "string" && model.trim() ? model : null;
}

/** Reads a `fallback` content block marking where one model's output gives way to the next. */
export function readAnthropicFallbackBoundary(block: unknown): AnthropicFallbackBoundary | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const record = block as { type?: unknown; from?: unknown; to?: unknown };
  if (record.type !== "fallback") {
    return null;
  }
  return {
    fromModel: readBoundaryModel(record.from),
    toModel: readBoundaryModel(record.to),
  };
}

/**
 * Applies a mid-stream fallback boundary to the accumulated assistant output.
 * Anthropic's replay contract: pre-boundary thinking/tool_use blocks must not
 * be echoed on later turns (and dropped tool calls must never execute); the
 * pre-boundary text is the continuation prefix the fallback model built on.
 */
export function applyAnthropicFallbackBoundary(params: {
  output: {
    content: Array<{ type: string }>;
    responseModel?: string;
    diagnostics?: AssistantMessageDiagnostic[];
  };
  boundary: AnthropicFallbackBoundary;
  provider: string;
}): void {
  const { output, boundary } = params;
  const survivors = output.content.filter((block) => block.type === "text");
  for (const survivor of survivors) {
    // Commentary phase tags refer to dropped pre-boundary tool calls; the
    // prefix is now the start of the final answer, and phase-aware display
    // extraction would otherwise hide it from the visible response.
    delete (survivor as { textSignature?: string }).textSignature;
  }
  output.content.splice(0, output.content.length, ...survivors);
  if (boundary.toModel) {
    output.responseModel = boundary.toModel;
  }
  output.diagnostics = [
    ...(output.diagnostics ?? []),
    {
      type: "provider_fallback",
      timestamp: Date.now(),
      details: {
        provider: params.provider,
        fromModel: boundary.fromModel,
        toModel: boundary.toModel,
      },
    },
  ];
}
