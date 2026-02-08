/**
 * Ollama Native API Provider
 *
 * Uses Ollama's native `/api/chat` and `/api/tags` endpoints to support tool calls
 * and availability checks against local Ollama instances.
 */

export interface OllamaNativeConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

interface OllamaNativeTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface OllamaNativeResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }>;
  };
}

const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/v1$/, "").replace(/\/$/, "");

const convertToolsToOllama = (tools: OllamaNativeTool[]) =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
    },
  }));

const convertToolCallsFromOllama = (
  toolCalls:
    | Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }>
    | undefined,
) =>
  toolCalls
    ?.filter((call): call is { function: { name: string; arguments?: Record<string, unknown> } } =>
      Boolean(call.function?.name),
    )
    .map((call, index) => ({
      id: `ollama_${index}`,
      name: call.function.name,
      arguments: call.function.arguments || {},
    }));

export async function ollamaChat(
  config: OllamaNativeConfig,
  messages: Array<{ role: string; content: string }>,
  tools?: OllamaNativeTool[],
  options?: { temperature?: number; maxTokens?: number },
): Promise<{
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage?: { input: number; output: number };
}> {
  const url = `${normalizeBaseUrl(config.baseUrl)}/api/chat`;

  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
    options: {
      temperature: options?.temperature ?? 0.7,
      num_predict: options?.maxTokens ?? 2048,
    },
  };

  if (tools && tools.length > 0) {
    requestBody.tools = convertToolsToOllama(tools);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.apiKey && config.apiKey !== "ollama-local") {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as OllamaNativeResponse;
  const message = data.message || {};

  return {
    content: message.content ?? "",
    toolCalls: convertToolCallsFromOllama(message.tool_calls),
    usage: undefined,
  };
}

export async function checkOllamaAvailability(
  baseUrl: string,
  model: string,
): Promise<{ available: boolean; error?: string }> {
  try {
    const url = `${normalizeBaseUrl(baseUrl)}/api/tags`;
    const response = await fetch(url, { method: "GET" });

    if (!response.ok) {
      return { available: false, error: `Ollama server returned ${response.status}` };
    }

    const data = (await response.json()) as { models?: Array<{ name: string }> };
    const models = data.models || [];
    const found = models.some((m) => m.name === model || m.name.startsWith(`${model}:`));

    if (!found) {
      return { available: false, error: `Model ${model} not found in Ollama` };
    }

    return { available: true };
  } catch (error) {
    return {
      available: false,
      error: `Cannot connect to Ollama: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
