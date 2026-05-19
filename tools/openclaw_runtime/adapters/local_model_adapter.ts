export interface LocalModelOptions {
  baseUrl?: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LocalModelResult {
  result: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface OpenAICompatResponse {
  choices: Array<{
    message: { content: string };
  }>;
  model: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export async function callLocalModel(
  task: string,
  opts: LocalModelOptions = {},
): Promise<LocalModelResult> {
  const baseUrl = opts.baseUrl ?? "http://localhost:11434/v1";
  const model = opts.model ?? "llama3.2";
  const maxTokens = opts.maxTokens ?? 2048;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const startedAt = Date.now();

  const messages: ChatMessage[] = [];
  if (opts.systemPrompt) {
    messages.push({ role: "system", content: opts.systemPrompt });
  }
  messages.push({ role: "user", content: task });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`[local_model_adapter] HTTP ${resp.status} from ${baseUrl}: ${body}`);
  }

  const data = (await resp.json()) as OpenAICompatResponse;
  const result = data.choices?.[0]?.message?.content ?? "";
  const durationMs = Date.now() - startedAt;

  return {
    result,
    model: data.model ?? model,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    durationMs,
  };
}
