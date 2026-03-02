import { AzureFoundryModelConfig } from "./types.js";

const MAX_ERROR_CHARS = 300;

export async function azureFoundryChatCompletion(
  model: AzureFoundryModelConfig,
  messages: unknown[],
  opts: Record<string, unknown> = {},
) {
  const url =
    model.apiStyle === "native"
      ? `${model.endpoint}/models/chat/completions?api-version=2024-05-01-preview`
      : `${model.endpoint}/openai/v1/chat/completions`;

  const maxTokens =
    typeof opts?.maxTokens === "number" ? opts.maxTokens : (model.maxTokens ?? 2048);

  const temperature = typeof opts?.temperature === "number" ? opts.temperature : 0.7;

  const body: Record<string, unknown> = {
    messages,
    model: model.id,
    max_tokens: maxTokens,
    temperature,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const text = (await res.text()).replace(/\s+/g, " ").trim();
      detail = text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
    } catch {
      // ignore read failures
    }
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Azure Foundry chat completion failed (HTTP ${res.status})${suffix}`);
  }

  return res.json();
}
