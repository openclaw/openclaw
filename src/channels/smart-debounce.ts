/**
 * Smart Debounce - Dynamic debounce based on message completeness detection
 *
 * This module provides intelligent message batching by analyzing message content
 * to determine if the user is still typing or has finished their input.
 */

/**
 * Types of user intent detected
 */
export enum UserIntentType {
  /** Casual chat or conversation */
  CHAT = "chat",
  /** Execution or request for action */
  EXECUTION = "execution",
  /** Followup or ongoing tracking */
  FOLLOWUP = "followup",
  /** Neutral or unclear intent */
  UNCLEAR = "unclear",
}

/**
 * Configuration for smart debounce behavior
 */
export interface SmartDebounceConfig {
  /** Enable smart debounce (default: true) */
  enabled: boolean;
  /** Signals that indicate incomplete input */
  incompleteSignals: string[];
  /** Signals that indicate complete input */
  completeSignals: string[];
  /** Signals that indicate execution intent */
  executionIntentSignals: string[];
  /** Signals that indicate chat intent */
  chatIntentSignals: string[];
  /** Signals that indicate followup intent */
  followupIntentSignals: string[];
  /** Multiplier applied when message appears incomplete (default: 1.5) */
  incompleteMultiplier: number;
  /** Multiplier applied when message appears complete (default: 0.7) */
  completeMultiplier: number;
  /** Multiplier applied when message is chat intent (default: 0.8) */
  chatMultiplier: number;
  /** Multiplier applied when message is execution intent (default: 1.2) */
  executionMultiplier: number;
  /** Multiplier applied when message is followup intent (default: 1.1) */
  followupMultiplier: number;
  /** Minimum message length to analyze (default: 3) */
  minMessageLength: number;
  /** Maximum multiplier cap (default: 3.0) */
  maxMultiplier: number;
}

/**
 * Result of user intent analysis
 */
export interface IntentAnalysisResult {
  /** Whether input is finalized */
  input_finalized: boolean;
  /** Detected intent type */
  intent_type: UserIntentType;
  /** Confidence score (0-1) */
  intent_confidence: number;
  /** Whether execution is required */
  execution_required: boolean;
  /** Whether task creation is suggested */
  suggest_create_task: boolean;
  /** Queue mode */
  queue_mode: "chat" | "execution_pending" | "followup";
  /** Reason for the decision */
  reason: string;
}

/**
 * Context for intent analysis
 */
export interface IntentAnalysisContext {
  /** Whether input is finalized */
  input_finalized: boolean;
  /** Whether session is currently busy */
  session_busy?: boolean;
}

/**
 * Default configuration for smart debounce
 */
export const DEFAULT_SMART_DEBOUNCE_CONFIG: SmartDebounceConfig = {
  enabled: true,
  incompleteSignals: ["...", "，", ",", "、", "待续", "continue", "还有", "and"],
  completeSignals: ["。", "？", "?", "！", "!", "done", "完了", "就这些", "好了", "."],
  executionIntentSignals: [
    // Chinese execution signals (search/investigation)
    "查",
    "查一下",
    "查查",
    "搜",
    "搜一下",
    "搜索",
    "找",
    "找一下",
    "查找",
    "了解",
    "去了解",
    "调研",
    "研究",
    "看一下",
    "看看",
    "过一遍",
    "盘一下",
    "排查",
    "核对",
    "对比",
    "验证",
    "确认一下",
    "看怎么回事",
    "摸一下情况",
    // Chinese execution signals (action)
    "跑",
    "跑一下",
    "运行",
    "执行",
    "安装",
    "部署",
    "配置",
    "修改",
    "改一下",
    "修",
    "修一下",
    "修复",
    "重启",
    "恢复",
    "删除",
    "清理",
    "测试",
    "调试",
    "重建",
    "重试",
    "同步",
    "更新一下",
    "拉一下",
    // Chinese execution signals (reporting)
    "详细汇报",
    "分步骤",
    "一步一步",
    "把过程给我",
    "告诉我做到哪了",
    "完成后告诉我",
    "失败也告诉我",
    "阶段性汇报",
    "同步进度",
    "随时汇报",
    "出个报告",
    "给我结果",

    // English execution signals (search/investigation)
    "search",
    "find",
    "look",
    "check",
    "investigate",
    "analyze",
    "explore",
    "verify",
    // English execution signals (action)
    "run",
    "execute",
    "install",
    "deploy",
    "configure",
    "modify",
    "fix",
    "test",
    "debug",
    "update",
    "sync",
    "pull",
    "push",
    "delete",
    // English execution signals (reporting)
    "report",
    "update me",
    "let me know",
    "progress",
    "status",
  ],
  chatIntentSignals: [
    // Chinese chat signals
    "你好",
    "嗨",
    "哈喽",
    "再见",
    "拜拜",
    "谢谢",
    "麻烦了",
    "辛苦了",
    "好的",
    "是的",
    "对的",
    "不是",
    "不对",
    "可能",
    "也许",
    "大概",
    "应该",
    "好像",
    "觉得",
    "认为",
    "想法",
    "意见",
    "建议",
    "讨论",
    "聊天",
    "说一下",
    "告诉我",
    "什么意思",
    "怎么看",
    "你在吗",
    "翻译一下",

    // English chat signals
    "hi",
    "hey",
    "goodbye",
    "bye",
    "thank",
    "please",
    "thanks",
    "okay",
    "yes",
    "no",
    "maybe",
    "perhaps",
    "think",
    "believe",
    "idea",
    "opinion",
    "suggestion",
    "discuss",
    "chat",
    "talk",
    "tell",
    "explain",
    "how are you",
    "what do you think",
  ],
  followupIntentSignals: [
    "跟进",
    "继续",
    "持续",
    "跟踪",
    "监控",
    "继续处理",
    "继续做",
    "推进",
    "盯一下",
  ],
  incompleteMultiplier: 1.5,
  completeMultiplier: 0.7,
  chatMultiplier: 0.8,
  executionMultiplier: 1.2,
  followupMultiplier: 1.1,
  minMessageLength: 3,
  maxMultiplier: 3.0,
};

/**
 * Detect user intent from message content
 */
export function detectUserIntent(
  message: string,
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
): UserIntentType {
  const trimmed = message.trim().toLowerCase();

  // Check for execution intent signals
  for (const signal of config.executionIntentSignals) {
    if (trimmed.includes(signal.toLowerCase())) {
      return UserIntentType.EXECUTION;
    }
  }

  // Check for followup intent signals
  for (const signal of config.followupIntentSignals) {
    if (trimmed.includes(signal.toLowerCase())) {
      return UserIntentType.FOLLOWUP;
    }
  }

  // Check for chat intent signals
  for (const signal of config.chatIntentSignals) {
    if (trimmed.includes(signal.toLowerCase())) {
      return UserIntentType.CHAT;
    }
  }

  return UserIntentType.UNCLEAR;
}

/**
 * Analyze message and return structured intent analysis result
 */
export function analyzeIntent(
  message: string,
  context: IntentAnalysisContext = { input_finalized: true },
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
): IntentAnalysisResult {
  if (!context.input_finalized) {
    return {
      input_finalized: false,
      intent_type: UserIntentType.UNCLEAR,
      intent_confidence: 0.0,
      execution_required: false,
      suggest_create_task: false,
      queue_mode: "chat",
      reason: "input not finalized",
    };
  }

  const trimmed = message.trim().toLowerCase();
  const intent = detectUserIntent(trimmed, config);

  // Determine execution and task creation flags
  const execution_required = intent === UserIntentType.EXECUTION;
  let suggest_create_task = execution_required;

  // Special case: session busy with execution intent
  const queue_mode: "chat" | "execution_pending" | "followup" =
    context.session_busy && execution_required
      ? "execution_pending"
      : intent === UserIntentType.FOLLOWUP
        ? "followup"
        : "chat";

  // Calculate confidence
  let intent_confidence = 0.75;
  if (intent === UserIntentType.UNCLEAR) {
    intent_confidence = 0.3;
  } else if (intent === UserIntentType.EXECUTION) {
    intent_confidence = 0.9;
  } else if (intent === UserIntentType.FOLLOWUP) {
    intent_confidence = 0.85;
  }

  // Reasoning
  let reason = `matched ${intent} intent`;
  if (context.session_busy && execution_required) {
    reason = "session busy with execution intent";
  }

  return {
    input_finalized: true,
    intent_type: intent,
    intent_confidence: intent_confidence,
    execution_required: execution_required,
    suggest_create_task: suggest_create_task,
    queue_mode: queue_mode,
    reason: reason,
  };
}

/**
 * Check if a message appears to be incomplete
 */
export function isIncompleteMessage(
  message: string,
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
): boolean {
  const trimmed = message.trim();

  // First check for incomplete signals regardless of length
  for (const signal of config.incompleteSignals) {
    if (trimmed.endsWith(signal)) {
      return true;
    }
  }

  // Check for exact incomplete signal matches
  for (const signal of config.incompleteSignals) {
    if (trimmed === signal) {
      return true;
    }
  }

  // Too short to determine (test expects this to return false)
  if (trimmed.length < config.minMessageLength) {
    return false;
  }

  return false;
}

/**
 * Check if a message appears to be complete
 */
export function isCompleteMessage(
  message: string,
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
): boolean {
  const trimmed = message.trim();

  // Check for complete signals (including exact matches)
  for (const signal of config.completeSignals) {
    const trimmedSignal = signal.trim();
    if (trimmed.endsWith(signal) || trimmed === trimmedSignal) {
      // But if it also ends with incomplete signal, it's not complete
      for (const incomplete of config.incompleteSignals) {
        if (trimmed.endsWith(incomplete)) {
          return false;
        }
      }
      return true;
    }
  }

  return false;
}

/**
 * Calculate dynamic debounce multiplier based on message analysis
 *
 * @param message - The message text to analyze
 * @param config - Smart debounce configuration
 * @returns Multiplier to apply to base debounce time
 */
export function calculateDebounceMultiplier(
  message: string,
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
): number {
  if (!config.enabled) {
    return 1.0;
  }

  const trimmed = message.trim();

  if (trimmed.length < config.minMessageLength) {
    return config.incompleteMultiplier;
  }

  if (isIncompleteMessage(trimmed, config)) {
    return Math.min(config.incompleteMultiplier, config.maxMultiplier);
  }

  // Intent-based multiplier (higher priority)
  const intent = detectUserIntent(trimmed, config);
  if (intent === UserIntentType.EXECUTION) {
    return Math.min(config.executionMultiplier, config.maxMultiplier);
  }
  if (intent === UserIntentType.FOLLOWUP) {
    return Math.min(config.followupMultiplier, config.maxMultiplier);
  }
  if (intent === UserIntentType.CHAT) {
    return Math.min(config.chatMultiplier, config.maxMultiplier);
  }

  // Fallback to complete message detection
  if (isCompleteMessage(trimmed, config)) {
    return config.completeMultiplier;
  }

  return 1.0;
}

/**
 * Resolve smart debounce time based on message content
 *
 * @param baseDebounceMs - The base debounce time from config
 * @param message - The message text to analyze
 * @param config - Smart debounce configuration
 * @returns Adjusted debounce time in milliseconds
 */
export function resolveSmartDebounceMs(
  baseDebounceMs: number,
  message: string,
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
): number {
  const multiplier = calculateDebounceMultiplier(message, config);
  const adjusted = Math.round(baseDebounceMs * multiplier);

  // Ensure minimum of 100ms and reasonable maximum
  return Math.max(100, Math.min(adjusted, 30000));
}

/**
 * Extract text from various message formats
 */
export function extractMessageText(item: unknown): string {
  if (!item) {
    return "";
  }

  // Handle object with text property
  if (typeof item === "object" && item !== null) {
    const obj = item as Record<string, unknown>;

    // Common text fields in order of precedence
    const textFields = ["text", "content", "body", "message", "caption"];

    for (const field of textFields) {
      const value = obj[field];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }

    // Handle nested msg object (Telegram style)
    if (obj.msg && typeof obj.msg === "object") {
      const msg = obj.msg as Record<string, unknown>;
      const text = msg.text ?? msg.caption;
      if (typeof text === "string") {
        return text;
      }
    }
  }

  // Handle string directly
  if (typeof item === "string") {
    return item;
  }

  return "";
}

/**
 * Create a smart debounce resolver function
 *
 * This returns a function that can be used as resolveDebounceMs callback
 * in createInboundDebouncer.
 *
 * @param baseDebounceMs - Base debounce time from config
 * @param config - Smart debounce configuration
 * @param extractText - Optional function to extract text from item
 * @returns Function that resolves debounce time for each item
 */
export function createSmartDebounceResolver<T>(
  baseDebounceMs: number,
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
  extractText?: (item: T) => string,
): (item: T) => number {
  return (item: T): number => {
    const message = extractText ? extractText(item) : extractMessageText(item);
    return resolveSmartDebounceMs(baseDebounceMs, message, config);
  };
}
