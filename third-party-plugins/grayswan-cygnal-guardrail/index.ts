import type { Message } from "@mariozechner/pi-ai";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type GuardrailMode = "block" | "monitor";

type BeforeToolCallStageConfig = {
  enabled: boolean;
  mode: GuardrailMode;
  violationThreshold?: number;
  blockOnMutation: boolean;
  blockOnIpi: boolean;
};

type GrayswanCygnalConfig = {
  apiKey?: string;
  apiBase?: string;
  policyId?: string;
  categories?: Record<string, string>;
  reasoningMode?: "off" | "hybrid" | "thinking";
  violationThreshold: number;
  timeoutMs: number;
  failOpen: boolean;
  cygnalBypass: boolean;
  beforeToolCall: BeforeToolCallStageConfig;
};

type BeforeToolCallEventLike = {
  toolName: string;
  toolCallId?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  messages?: unknown[];
  tools?: unknown[];
};

type CygnalToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type CygnalMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: CygnalToolCall[];
};

type CygnalToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
};

type CygnalMonitorResponse = {
  violation?: number;
  violated_rules?: unknown[];
  violated_rule_descriptions?: unknown[];
  mutation?: boolean;
  ipi?: boolean;
};

type CygnalEvaluation = {
  shouldBlock: boolean;
  reason: string;
  violation: number;
  mutation: boolean;
  ipi: boolean;
};

const DEFAULT_API_BASE = "https://api.grayswan.ai";
const MONITOR_PATH = "/cygnal/monitor";
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_CHARS = 2_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toThreshold(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function toTimeoutMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  return rounded >= 1_000 ? rounded : fallback;
}

function toCategories(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = toTrimmedString(raw);
    if (normalized) {
      out[key] = normalized;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toReasoningMode(value: unknown): GrayswanCygnalConfig["reasoningMode"] {
  if (value === "off" || value === "hybrid" || value === "thinking") {
    return value;
  }
  return undefined;
}

function toMode(value: unknown, fallback: GuardrailMode): GuardrailMode {
  return value === "monitor" || value === "block" ? value : fallback;
}

function resolveConfig(rawConfig: unknown): GrayswanCygnalConfig {
  const raw = isObject(rawConfig) ? rawConfig : {};
  const rawStages = isObject(raw.stages) ? raw.stages : {};
  const rawLegacyBeforeToolCall = isObject(rawStages.beforeToolCall)
    ? rawStages.beforeToolCall
    : {};
  const rawStage = isObject(raw.beforeToolCall) ? raw.beforeToolCall : rawLegacyBeforeToolCall;
  return {
    apiKey: toTrimmedString(raw.apiKey),
    apiBase: toTrimmedString(raw.apiBase),
    policyId: toTrimmedString(raw.policyId),
    categories: toCategories(raw.categories),
    reasoningMode: toReasoningMode(raw.reasoningMode),
    violationThreshold: toThreshold(raw.violationThreshold, DEFAULT_THRESHOLD),
    timeoutMs: toTimeoutMs(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    failOpen: toBoolean(raw.failOpen, true),
    cygnalBypass: toBoolean(raw.cygnalBypass, false),
    beforeToolCall: {
      enabled: toBoolean(rawStage.enabled, true),
      mode: toMode(rawStage.mode, "block"),
      violationThreshold:
        typeof rawStage.violationThreshold === "number" &&
        Number.isFinite(rawStage.violationThreshold)
          ? toThreshold(rawStage.violationThreshold, DEFAULT_THRESHOLD)
          : undefined,
      blockOnMutation: toBoolean(rawStage.blockOnMutation, false),
      blockOnIpi: toBoolean(rawStage.blockOnIpi, false),
    },
  };
}

function resolveApiKey(config: GrayswanCygnalConfig): string | undefined {
  if (config.apiKey) {
    return config.apiKey;
  }
  return toTrimmedString(process.env.GRAYSWAN_API_KEY);
}

function resolveApiBase(config: GrayswanCygnalConfig): string {
  const source =
    config.apiBase ?? toTrimmedString(process.env.GRAYSWAN_API_BASE) ?? DEFAULT_API_BASE;
  return source.replace(/\/+$/, "");
}

function isDebugEnabled(): boolean {
  const raw = process.env.OPENCLAW_GUARDRAIL_DEBUG?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function debug(logger: OpenClawPluginApi["logger"], enabled: boolean, message: string): void {
  if (!enabled) {
    return;
  }
  logger.error(`[grayswan-debug] ${message}`);
}

function truncateForLog(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}... (${value.length} chars)`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isObject(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image";
      parts.push(`[${mimeType}]`);
      continue;
    }
    if (block.type === "image_url") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function toCygnalToolCalls(content: unknown): CygnalToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const toolCalls: CygnalToolCall[] = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== "toolCall") {
      continue;
    }
    const id = toTrimmedString(block.id);
    const name = toTrimmedString(block.name);
    if (!id || !name) {
      continue;
    }
    let serializedArguments = "{}";
    const args = isObject(block.arguments) ? block.arguments : {};
    try {
      serializedArguments = JSON.stringify(args);
    } catch {
      serializedArguments = "{}";
    }
    toolCalls.push({
      id,
      type: "function",
      function: {
        name,
        arguments: serializedArguments,
      },
    });
  }
  return toolCalls;
}

function toCygnalMessage(message: unknown): CygnalMessage | null {
  if (!isObject(message) || typeof message.role !== "string") {
    return null;
  }

  if (message.role === "user") {
    return { role: "user", content: textFromContent((message as Message).content) };
  }

  if (message.role === "assistant") {
    const toolCalls = toCygnalToolCalls((message as Message).content);
    const content = textFromContent((message as Message).content);
    return {
      role: "assistant",
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  if (message.role === "toolResult") {
    const name = toTrimmedString((message as { toolName?: unknown }).toolName);
    const toolCallId = toTrimmedString((message as { toolCallId?: unknown }).toolCallId);
    const content = textFromContent((message as Message).content);
    return {
      role: "tool",
      content,
      ...(name ? { name } : {}),
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
    };
  }

  return null;
}

function buildCygnalMessages(event: BeforeToolCallEventLike): CygnalMessage[] {
  const output: CygnalMessage[] = [];
  const systemPrompt = toTrimmedString(event.systemPrompt);
  if (systemPrompt) {
    output.push({ role: "system", content: systemPrompt });
  }

  const history = Array.isArray(event.messages) ? event.messages : [];
  for (const raw of history) {
    const converted = toCygnalMessage(raw);
    if (converted) {
      output.push(converted);
    }
  }

  return output;
}

function buildCygnalTools(rawTools: unknown): CygnalToolDefinition[] {
  if (!Array.isArray(rawTools)) {
    return [];
  }
  const output: CygnalToolDefinition[] = [];
  for (const raw of rawTools) {
    if (!isObject(raw)) {
      continue;
    }
    const name = toTrimmedString(raw.name);
    if (!name) {
      continue;
    }
    const description = toTrimmedString(raw.description);
    const parameters = isObject(raw.parameters) ? raw.parameters : {};
    output.push({
      type: "function",
      function: {
        name,
        ...(description ? { description } : {}),
        parameters,
      },
    });
  }
  return output;
}

function buildPayload(args: {
  event: BeforeToolCallEventLike;
  config: GrayswanCygnalConfig;
  messages: CygnalMessage[];
  tools: CygnalToolDefinition[];
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    messages: args.messages,
  };

  if (args.tools.length > 0) {
    payload.tools = args.tools;
  }
  if (args.config.policyId) {
    payload.policy_id = args.config.policyId;
  }
  if (args.config.categories && Object.keys(args.config.categories).length > 0) {
    payload.categories = args.config.categories;
  }
  if (args.config.reasoningMode) {
    payload.reasoning_mode = args.config.reasoningMode;
  }

  const metadata: Record<string, unknown> = {
    openclaw_hook: "before_tool_call",
    openclaw_tool_name: args.event.toolName,
  };
  if (args.config.cygnalBypass) {
    metadata.cygnal_bypass = "true";
  }
  if (args.event.toolCallId) {
    metadata.openclaw_tool_call_id = args.event.toolCallId;
  }
  if (args.event.provider) {
    metadata.openclaw_model_provider = args.event.provider;
  }
  if (args.event.model) {
    metadata.openclaw_model_id = args.event.model;
  }
  payload.metadata = metadata;

  return payload;
}

async function callMonitor(args: {
  api: OpenClawPluginApi;
  event: BeforeToolCallEventLike;
  config: GrayswanCygnalConfig;
  apiKey: string;
  messages: CygnalMessage[];
  tools: CygnalToolDefinition[];
  debugEnabled: boolean;
}): Promise<CygnalMonitorResponse> {
  const startedAt = Date.now();
  const url = `${resolveApiBase(args.config)}${MONITOR_PATH}`;
  const payload = buildPayload({
    event: args.event,
    config: args.config,
    messages: args.messages,
    tools: args.tools,
  });
  const body = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(body, "utf8");
  const controller = new AbortController();
  let timeoutFired = false;
  let requestDispatched = false;
  let responseStatus: number | undefined;

  debug(
    args.api.logger,
    args.debugEnabled,
    `stage=before_tool_call monitor:start url=${url} timeoutMs=${args.config.timeoutMs} payloadBytes=${payloadBytes}`,
  );

  const timeoutHandle = setTimeout(() => {
    timeoutFired = true;
    debug(
      args.api.logger,
      args.debugEnabled,
      `stage=before_tool_call monitor:timeout-fired timeoutMs=${args.config.timeoutMs} elapsedMs=${Date.now() - startedAt}`,
    );
    controller.abort();
  }, args.config.timeoutMs);

  try {
    requestDispatched = true;
    debug(
      args.api.logger,
      args.debugEnabled,
      'stage=before_tool_call monitor:request-dispatched note="request was handed to fetch; upstream receipt not guaranteed yet"',
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
        "grayswan-api-key": args.apiKey,
      },
      body,
      signal: controller.signal,
    });

    responseStatus = response.status;
    debug(
      args.api.logger,
      args.debugEnabled,
      `stage=before_tool_call monitor:response-headers status=${response.status} elapsedMs=${Date.now() - startedAt}`,
    );

    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      throw new Error(
        rawBody
          ? `Gray Swan monitor returned ${response.status}: ${truncateForLog(rawBody, MAX_ERROR_BODY_CHARS)}`
          : `Gray Swan monitor returned ${response.status}`,
      );
    }

    const parsed = (await response.json()) as CygnalMonitorResponse;
    debug(
      args.api.logger,
      args.debugEnabled,
      `stage=before_tool_call monitor:success status=${response.status} elapsedMs=${Date.now() - startedAt}`,
    );
    return parsed;
  } finally {
    clearTimeout(timeoutHandle);
    debug(
      args.api.logger,
      args.debugEnabled,
      `stage=before_tool_call monitor:done timeoutFired=${String(timeoutFired)} requestDispatched=${String(requestDispatched)} status=${responseStatus ?? "none"} elapsedMs=${Date.now() - startedAt}`,
    );
  }
}

function normalizeRuleList(response: CygnalMonitorResponse): string[] {
  const source = Array.isArray(response.violated_rule_descriptions)
    ? response.violated_rule_descriptions
    : Array.isArray(response.violated_rules)
      ? response.violated_rules
      : [];
  const rules: string[] = [];
  for (const entry of source) {
    if (!entry) {
      continue;
    }
    if (typeof entry === "string") {
      rules.push(entry);
      continue;
    }
    if (!isObject(entry)) {
      rules.push(JSON.stringify(entry));
      continue;
    }
    const id =
      toTrimmedString(entry.rule) ?? toTrimmedString(entry.id) ?? toTrimmedString(entry.index);
    const name = toTrimmedString(entry.name);
    const description = toTrimmedString(entry.description);
    if (id && name) {
      rules.push(description ? `#${id} ${name}: ${description}` : `#${id} ${name}`);
      continue;
    }
    if (name) {
      rules.push(description ? `${name}: ${description}` : name);
      continue;
    }
    if (description) {
      rules.push(description);
    }
  }
  return rules;
}

function evaluateResponse(
  response: CygnalMonitorResponse,
  config: GrayswanCygnalConfig,
): CygnalEvaluation {
  const stage = config.beforeToolCall;
  const threshold = stage.violationThreshold ?? config.violationThreshold;
  const violation = Number(response.violation ?? 0);
  const normalizedViolation = Number.isFinite(violation) ? violation : 0;
  const mutation = Boolean(response.mutation);
  const ipi = Boolean(response.ipi);
  const scoreFlag = normalizedViolation >= threshold;
  const mutationFlag = stage.blockOnMutation && mutation;
  const ipiFlag = stage.blockOnIpi && ipi;
  const rules = normalizeRuleList(response);
  const reasons: string[] = [];

  if (scoreFlag) {
    reasons.push(`violation score ${normalizedViolation.toFixed(2)} >= ${threshold.toFixed(2)}`);
  }
  if (mutationFlag) {
    reasons.push("mutation detected");
  }
  if (ipiFlag) {
    reasons.push("indirect prompt injection detected");
  }
  if (rules.length > 0) {
    reasons.push(`rules: ${rules.join(", ")}`);
  }

  return {
    shouldBlock: scoreFlag || mutationFlag || ipiFlag,
    reason: reasons.join("; "),
    violation: normalizedViolation,
    mutation,
    ipi,
  };
}

const plugin = definePluginEntry({
  id: "grayswan-cygnal-guardrail",
  name: "Gray Swan Cygnal Guardrail",
  description: "Evaluates before_tool_call context against Gray Swan Cygnal /monitor.",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const debugEnabled = isDebugEnabled();

    api.on("before_tool_call", async (event) => {
      const hookEvent = event as BeforeToolCallEventLike;
      if (!config.beforeToolCall.enabled) {
        return;
      }

      const apiKey = resolveApiKey(config);
      if (!apiKey) {
        const message = "grayswan-cygnal-guardrail: missing api key";
        if (config.failOpen) {
          api.logger.warn(message);
          return;
        }
        return { block: true, blockReason: "Gray Swan Cygnal API key is not configured." };
      }

      const messages = buildCygnalMessages(hookEvent);
      const tools = buildCygnalTools(hookEvent.tools);
      if (messages.length === 0) {
        debug(api.logger, debugEnabled, "stage=before_tool_call monitor:skip reason=no_messages");
        return;
      }

      try {
        const response = await callMonitor({
          api,
          event: hookEvent,
          config,
          apiKey,
          messages,
          tools,
          debugEnabled,
        });
        const evaluation = evaluateResponse(response, config);

        debug(
          api.logger,
          debugEnabled,
          `stage=before_tool_call monitor:evaluation mode=${config.beforeToolCall.mode} shouldBlock=${String(evaluation.shouldBlock)} violation=${evaluation.violation.toFixed(2)} mutation=${String(evaluation.mutation)} ipi=${String(evaluation.ipi)}`,
        );

        if (config.beforeToolCall.mode === "block" && evaluation.shouldBlock) {
          return {
            block: true,
            blockReason:
              evaluation.reason || "The tool call was blocked by the Gray Swan Cygnal guardrail.",
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.error(`grayswan-cygnal-guardrail before_tool_call failed: ${message}`);
        if (!config.failOpen) {
          return {
            block: true,
            blockReason: "Gray Swan Cygnal evaluation failed.",
          };
        }
      }
    });
  },
});

export default plugin;

export const __testing = {
  resolveConfig,
  textFromContent,
  toCygnalMessage,
  buildCygnalMessages,
  buildCygnalTools,
  evaluateResponse,
};
