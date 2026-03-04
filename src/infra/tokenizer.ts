import { createHash } from "node:crypto";

// ================================
// 配置
// ================================

/**
 * Tokenizer 配置
 *
 * 默认行为：使用字符数估算 (chars * BASE_CHUNK_RATIO = chars * 0.4)
 * 开启方式：设置环境变量 OPENCLAW_TOKENIZER_ENABLED=1
 *
 * 可用 tokenizer:
 *   - cl100k_base: OpenAI GPT-4/3.5 (默认)
 *   - p50k_base: OpenAI Codex
 *   - r50k_base: OpenAI GPT-2
 *   - MiniMaxAI/MiniMax-M2.5: MiniMax M2.5
 *   - 其他 HuggingFace 模型
 */
export interface TokenizerConfig {
  /** 是否启用 tokenizer */
  enabled: boolean;
  /** tokenizer 类型: "tiktoken" | "huggingface" */
  provider: "tiktoken" | "huggingface";
  /** tokenizer 名称或路径 */
  model: string;
}

// OpenClaw 原有常量（保持一致）
const BASE_CHUNK_RATIO = 0.4;

// 解析配置
function getTokenizerConfig(): TokenizerConfig {
  const enabled =
    process.env.OPENCLAW_TOKENIZER_ENABLED === "1" ||
    process.env.OPENCLAW_TOKENIZER_ENABLED === "true";

  // 如果未启用，返回禁用配置
  if (!enabled) {
    return {
      enabled: false,
      provider: "tiktoken",
      model: "cl100k_base",
    };
  }

  // 解析 provider
  const providerEnv = process.env.OPENCLAW_TOKENIZER_PROVIDER;
  let provider: "tiktoken" | "huggingface" = "tiktoken";
  if (providerEnv === "huggingface") {
    provider = "huggingface";
  }

  // 解析 model
  let model = process.env.OPENCLAW_TOKENIZER_MODEL || "cl100k_base";

  // 如果指定了本地路径，强制使用 huggingface
  if (process.env.OPENCLAW_TOKENIZER_PATH) {
    provider = "huggingface";
    model = process.env.OPENCLAW_TOKENIZER_PATH;
  }

  return { enabled, provider, model };
}

// 全局配置
const config = getTokenizerConfig();

// ================================
// 默认估算方式 (chars * 0.4)
// ================================

/**
 * 使用字符数估算 token 数
 * 这与 OpenClaw 原有行为一致: chars * BASE_CHUNK_RATIO (0.4)
 * 误差约 30%
 */
function estimateTokensByChars(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }
  // OpenClaw 原有方式: chars * 0.4
  return Math.floor(text.length * BASE_CHUNK_RATIO);
}

// ================================
// LRU 缓存
// ================================

interface CacheEntry {
  tokens: number;
  timestamp: number;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_MAX_SIZE = 1000;
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 小时

function cleanupCache() {
  const now = Date.now();
  if (CACHE.size > CACHE_MAX_SIZE) {
    const entries = Array.from(CACHE.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const deleteCount = CACHE.size - CACHE_MAX_SIZE;
    for (let i = 0; i < deleteCount; i++) {
      CACHE.delete(entries[i][0]);
    }
  }
  for (const [key, entry] of CACHE.entries()) {
    if (now - entry.timestamp > CACHE_MAX_AGE) {
      CACHE.delete(key);
    }
  }
}

// ================================
// Tiktoken Tokenizer
// ================================

// Tiktoken encoding type (using unknown for type safety)
let tiktokenEncoding: TiktokenEncoding | null = null;
type TiktokenEncoding = { encode: (text: string) => number[]; free: () => void };

async function loadTiktokenTokenizer(): Promise<TiktokenEncoding> {
  if (tiktokenEncoding) {
    return tiktokenEncoding;
  }

  try {
    // 动态导入 tiktoken
    const tiktoken = await import("tiktoken");
    const model = config.model;

    // 验证是否为有效的 tiktoken 模型
    const validModels = ["cl100k_base", "p50k_base", "r50k_base", "cl50k_base"];
    if (!validModels.includes(model)) {
      console.warn(
        `[tokenizer] Model "${model}" is not a standard tiktoken model, trying anyway...`,
      );
    }

    // tiktoken.get_encoding expects a specific encoding name
    // @ts-expect-error - tiktoken types are not fully compatible
    tiktokenEncoding = tiktoken.get_encoding(model);
    console.log(`[tokenizer] Loaded tiktoken model: ${model}`);
    return tiktokenEncoding;
  } catch (error) {
    console.error("[tokenizer] Failed to load tiktoken:", error);
    throw error;
  }
}

// Tiktoken 同步版本（性能更好）
function estimateTokensByTiktokenSync(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  // 尝试使用缓存的 encoding
  if (tiktokenEncoding) {
    const tokens = tiktokenEncoding.encode(text);
    return tokens.length;
  }

  // 同步加载并使用（tiktoken 在 Node.js 中支持同步）
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tiktoken = require("tiktoken");
    const encoding = tiktoken.get_encoding(config.model);
    const tokens = encoding.encode(text);
    encoding.free();
    return tokens.length;
  } catch (error) {
    console.warn("[tokenizer] Tiktoken sync failed:", error);
    // 回退到字符估算
    return estimateTokensByChars(text);
  }
}

// ================================
// HuggingFace Tokenizer
// ================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hfTokenizer: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadHuggingfaceTokenizer(): Promise<any> {
  if (hfTokenizer) {
    return hfTokenizer;
  }

  try {
    const { Tokenizer } = await import("@huggingface/tokenizers");
    const model = config.model;

    hfTokenizer = await Tokenizer.fromPretrained(model);
    console.log(`[tokenizer] Loaded HuggingFace model: ${model}`);
    return hfTokenizer;
  } catch (error) {
    console.error("[tokenizer] Failed to load HuggingFace tokenizer:", error);
    throw error;
  }
}

export async function estimateTokensWithHuggingface(text: string): Promise<number> {
  const tokenizer = await loadHuggingfaceTokenizer();
  const encoded = tokenizer.encode(text);
  return encoded.length;
}

// ================================
// 工具函数
// ================================

// Message type for token estimation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MessageContent = any;
interface Message {
  role?: string;
  content?: MessageContent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

function hashMessage(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function messageToText(message: Message): string {
  const role = message.role || "";
  let content: string;
  if (message.content === undefined || message.content === null) {
    content = "";
  } else if (typeof message.content === "string") {
    content = message.content;
  } else {
    content = JSON.stringify(message.content);
  }
  // If both role and content are empty, return empty string
  if (!role && !content) {
    return "";
  }
  // If content is empty, don't count role as tokens either (empty message = 0 tokens)
  if (!content) {
    return "";
  }
  return `${role}: ${content}`;
}

function messagesToText(messages: Message[]): string {
  return messages.map(messageToText).join("\n");
}

// ================================
// 主函数
// ================================

/**
 * 估算单条消息的 token 数
 *
 * 默认行为：使用字符数估算 (chars * 0.4)
 * 开启 tokenizer 后：使用 tiktoken 或 huggingface tokenizer
 */
export function estimateTokensWithTokenizer(message: Message): number {
  const content = messagesToText([message]);
  const cacheKey = hashMessage(content);
  const cached = CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached.tokens;
  }

  let tokenCount: number;

  if (!config.enabled) {
    // 默认使用字符数估算 (chars * 0.4)
    // 这与 OpenClaw 原有行为一致
    tokenCount = estimateTokensByChars(content);
  } else {
    try {
      if (config.provider === "tiktoken") {
        tokenCount = estimateTokensByTiktokenSync(content);
      } else {
        // HuggingFace 需要异步处理，这里同步返回字符估算
        console.warn(
          "[tokenizer] HuggingFace provider requires async, falling back to char estimation",
        );
        tokenCount = estimateTokensByChars(content);
      }
    } catch (error) {
      console.warn("[tokenizer] Estimation failed, falling back to char estimation:", error);
      tokenCount = estimateTokensByChars(content);
    }
  }

  CACHE.set(cacheKey, { tokens: tokenCount, timestamp: Date.now() });
  cleanupCache();
  return tokenCount;
}

/**
 * 估算多条消息的 token 数
 */
export function estimateMessagesTokensWithTokenizer(messages: Message[]): number {
  if (messages.length === 0) {
    return 0;
  }

  // 对于多条消息，我们逐个估算并求和
  let total = 0;
  for (const message of messages) {
    total += estimateTokensWithTokenizer(message);
  }

  return total;
}

// ================================
// 缓存管理
// ================================

export function clearTokenizerCache() {
  CACHE.clear();
}

export function getTokenizerCacheStats() {
  return {
    size: CACHE.size,
    maxSize: CACHE_MAX_SIZE,
    maxAge: CACHE_MAX_AGE,
  };
}

// ================================
// 预热（可选）
// ================================

export async function warmupTokenizer(): Promise<void> {
  if (!config.enabled) {
    console.log("[tokenizer] Not enabled, skipping warmup");
    return;
  }

  console.log(`[tokenizer] Warming up ${config.provider}/${config.model}...`);

  try {
    if (config.provider === "tiktoken") {
      await loadTiktokenTokenizer();
    } else {
      await loadHuggingfaceTokenizer();
    }
    console.log("[tokenizer] Warmup complete");
  } catch (error) {
    console.warn("[tokenizer] Warmup failed:", error);
  }
}

// ================================
// 配置查询
// ================================

export function getConfig(): TokenizerConfig {
  return { ...config };
}
