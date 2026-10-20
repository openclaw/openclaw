import type { Context, Model, UserMessage } from "../../llm/types.js";

export const LIVE_MODEL_FILE_PROBE_TOKEN = "opal";

export const LIVE_MODEL_FILE_PROBE_ENV = "OPENCLAW_LIVE_MODEL_FILE_PROBE";
export const LIVE_MODEL_IMAGE_PROBE_ENV = "OPENCLAW_LIVE_MODEL_IMAGE_PROBE";

const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALUlEQVR4nO3OIQEAAAwCMPrnod8fAzMxv7S9pQgICAgICAgICAgICAgICKwDD+yWbLXSniMNAAAAAElFTkSuQmCC";

const KNOWN_EMPTY_EXTRA_PROBE_MODELS = new Set(["openrouter/amazon/nova-2-lite-v1"]);
const KNOWN_EMPTY_FILE_PROBE_MODELS = new Set([
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-pro-preview-customtools",
  "opencode-go/glm-5.1",
  "opencode-go/minimax-m2.5",
  "openrouter/deepseek/deepseek-chat-v3.1",
  "openrouter/minimax/minimax-m2.5",
  "openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "openrouter/nvidia/nemotron-nano-12b-v2-vl:free",
  "openrouter/qwen/qwen3.5-9b",
  "openrouter/tngtech/deepseek-r1t2-chimera",
  "openrouter/z-ai/glm-4.5",
  "openrouter/z-ai/glm-4.6",
  "openrouter/z-ai/glm-4.7",
  "openrouter/z-ai/glm-4.7-flash",
  "openrouter/z-ai/glm-5",
  "openrouter/z-ai/glm-5.1",
]);
const KNOWN_EMPTY_IMAGE_PROBE_MODELS = new Set([
  "fireworks/accounts/fireworks/models/kimi-k2p5",
  "google/gemini-3.1-pro-preview-customtools",
  "opencode/kimi-k2.6",
  "opencode-go/kimi-k2.5",
  "opencode-go/kimi-k2.6",
  "openrouter/amazon/nova-pro-v1",
  "openrouter/bytedance-seed/seed-1.6",
]);

function modelKey(model: Pick<Model, "id" | "provider">): string {
  return `${model.provider}/${model.id}`;
}

/** Resolves live probe env toggles, defaulting to enabled when unset. */
export function isLiveModelProbeEnabled(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !["0", "false", "no", "off"].includes(raw);
}

export function modelSupportsImageInput(model: Pick<Model, "input">): boolean {
  return model.input.includes("image");
}

export function shouldSkipLiveModelExtraProbes(model: Pick<Model, "id" | "provider">): boolean {
  return KNOWN_EMPTY_EXTRA_PROBE_MODELS.has(modelKey(model));
}

export function shouldSkipLiveModelFileProbe(model: Pick<Model, "id" | "provider">): boolean {
  if (model.provider === "opencode-go") {
    return true;
  }
  return KNOWN_EMPTY_FILE_PROBE_MODELS.has(modelKey(model));
}

export function shouldSkipLiveModelImageProbe(model: Pick<Model, "id" | "provider">): boolean {
  return KNOWN_EMPTY_IMAGE_PROBE_MODELS.has(modelKey(model));
}

function probeContext(systemPrompt: string | undefined, content: UserMessage["content"]): Context {
  return { systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] };
}

export function buildLiveModelFileProbeContext(params: { systemPrompt?: string }): Context {
  return probeContext(
    params.systemPrompt,
    "Read this visible label and reply with only the value after LIVE_LABEL.\n\n" +
      `LIVE_LABEL=${LIVE_MODEL_FILE_PROBE_TOKEN}`,
  );
}

/** Builds the fallback file-label prompt when the primary file probe is ambiguous. */
export function buildLiveModelFileProbeRetryContext(params: { systemPrompt?: string }): Context {
  return probeContext(
    params.systemPrompt,
    "The visible label value is:\n\n" +
      `${LIVE_MODEL_FILE_PROBE_TOKEN}\n\n` +
      `Reply with exactly ${LIVE_MODEL_FILE_PROBE_TOKEN}.`,
  );
}

/** Builds the image probe context with a tiny stable PNG fixture. */
export function buildLiveModelImageProbeContext(params: { systemPrompt?: string }): Context {
  return probeContext(params.systemPrompt, [
    { type: "text", text: "Reply with exactly OK." },
    { type: "image", data: PROBE_PNG_BASE64, mimeType: "image/png" },
  ]);
}

export function fileProbeTextMatches(text: string): boolean {
  return text.toLowerCase().includes(LIVE_MODEL_FILE_PROBE_TOKEN.toLowerCase());
}

function imageProbeTextMatches(text: string): boolean {
  return /\bok\b/i.test(text);
}

function formatImageProbeText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "<empty>";
  }
  return `<non-matching response: ${normalized.length} chars>`;
}

/** Retries one ambiguous image reply without weakening the strict OK matcher. */
export async function runLiveModelImageProbeWithRetry(params: {
  run: (attempt: 1 | 2) => Promise<string>;
  onRetry: (firstText: string) => void;
}): Promise<string> {
  const firstText = await params.run(1);
  if (imageProbeTextMatches(firstText)) {
    return firstText;
  }

  params.onRetry(firstText);
  const retryText = await params.run(2);
  if (imageProbeTextMatches(retryText)) {
    return retryText;
  }

  throw new Error(
    "image probe did not return ok after retry " +
      `(attempt 1: ${formatImageProbeText(firstText)}; ` +
      `attempt 2: ${formatImageProbeText(retryText)})`,
  );
}
