import { scanSensitive, type Finding } from "./patterns.js";
import { TokenVault } from "./vault.js";

/**
 * 安全模式配置项。用户在 UI 的"安全模式"开关中填写。
 */
export interface GuardrailOptions {
  /** 是否启用安全模式 */
  enable?: boolean;
  /** 本地模型 OpenAI-compatible API 地址，如 http://10.14.101.124:1234/v1 */
  localBaseUrl?: string;
  /** 本地模型 API Key（LM Studio 等可填任意值） */
  localApiKey?: string;
  /** 本地模型 ID，如 qwen3-30b-a3b */
  localModel?: string;
  /**
   * 自定义脱敏提示词。用户可通过此字段告诉本地模型需要额外过滤哪些内容。
   * 例如："除了默认规则外，还需要过滤所有项目代号和内部域名"
   */
  customPrompt?: string;
  /** 当本地模型不可用时，是否回退到仅正则模式（默认 true） */
  fallbackToRegexOnly?: boolean;
}

export interface ScanResult {
  vault: TokenVault;
  findingsCount: number;
  /** 标记本次脱敏是通过哪种方式完成的 */
  method: "local-llm" | "regex-only" | "skipped";
}

/**
 * 本地模型脱敏的系统提示词。
 * 让模型只返回一个 JSON 数组，列出需要脱敏的原始值。
 * 映射表（VAULT_N → 原始值）由代码侧构建，避免模型生成的 JSON 因特殊字符而解析失败。
 */
const SANITIZER_SYSTEM_PROMPT = `你是一个安全脱敏助手。你的唯一任务是从用户消息中提取所有敏感信息。

## 需要提取的信息类型（默认）：
- IP 地址（内网/公网）
- 数据库连接串（含密码）
- API Key / Secret Key / Token
- 用户名和密码组合
- SSH 私钥 / 证书内容
- 内部域名和主机名
- 手机号、身份证号、邮箱地址

## 输出格式要求（严格遵守）：
你必须只输出一个 JSON 数组，包含所有发现的敏感值原文。不要输出任何解释、思考过程或额外内容。
示例：
["mysql://admin:pass@192.168.1.1:3306/db", "AKIAIOSFODNN7EXAMPLE", "192.168.1.1"]

如果没有发现任何敏感信息，输出空数组：[]`;

/**
 * 从 OpenClaw 的完整 prompt 中提取用户实际消息部分。
 * OpenClaw 会在用户消息前注入 "Sender (untrusted metadata):" 等系统信息。
 */
function extractUserMessage(fullPrompt: string): string {
  // 尝试找到用户消息的起始位置（跳过 OpenClaw 注入的元数据头）
  // 格式通常是: "Sender (untrusted metadata):\n```json\n{...}\n```\n\n[timestamp]\n\n实际消息"
  const metadataEndPatterns = [
    // 匹配时间戳行后的内容 [Wed 2026-04-22 ...]
    /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}[^\]]*\]\n\n/,
    // 匹配 JSON metadata 块后的内容
    /```\n\n/,
  ];

  let startIdx = 0;
  for (const pattern of metadataEndPatterns) {
    const match = fullPrompt.match(pattern);
    if (match && match.index !== undefined) {
      const candidateIdx = match.index + match[0].length;
      if (candidateIdx > startIdx) {
        startIdx = candidateIdx;
      }
    }
  }

  return startIdx > 0 ? fullPrompt.substring(startIdx) : fullPrompt;
}

/**
 * 调用本地模型识别敏感信息。
 * 只让模型返回一个敏感值数组，避免复杂 JSON 导致解析失败。
 */
async function callLocalModelForSensitiveValues(
  userMessage: string,
  options: GuardrailOptions,
): Promise<string[] | null> {
  const baseUrl = options.localBaseUrl?.replace(/\/+$/, "");
  const model = options.localModel;
  if (!baseUrl || !model) {
    return null;
  }

  const systemPrompt = options.customPrompt
    ? `${SANITIZER_SYSTEM_PROMPT}\n\n## 用户自定义过滤规则：\n${options.customPrompt}`
    : SANITIZER_SYSTEM_PROMPT;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.localApiKey ? { Authorization: `Bearer ${options.localApiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      console.error(`[Guardrail] 本地模型返回 HTTP ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    let content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return null;
    }

    // 剥离 Qwen3 等模型的 <think>...</think> 思考标签
    content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    console.log(`[Guardrail] 本地模型返回 ${content.length} 字符`);

    // 提取 JSON 数组
    const arrayMatch =
      content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/(\[[\s\S]*\])/);
    if (!arrayMatch) {
      console.error("[Guardrail] 无法从本地模型返回中提取 JSON 数组");
      return null;
    }

    const parsed = JSON.parse(arrayMatch[1]);
    if (!Array.isArray(parsed)) {
      console.error("[Guardrail] 本地模型返回的不是数组");
      return null;
    }

    // 过滤无效项，只保留非空字符串
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch (err) {
    console.error(`[Guardrail] 调用本地模型失败:`, err);
    return null;
  }
}

export function classifyRedactedValue(value: string): string {
  if (/^(mysql|postgres|postgresql|mongodb|redis|mssql):\/\//i.test(value)) {
    return "database connection string (complete URI)";
  }
  if (/^(ssh-rsa|-----BEGIN)/i.test(value)) {
    return "private key";
  }
  if (/^AKIA[0-9A-Z]{16}$/i.test(value)) {
    return "AWS access key";
  }
  if (/^(sk[_-]live|pk[_-]live)/i.test(value)) {
    return "payment API key";
  }
  if (/^(sk[_-]|api[_-]?key|token)/i.test(value)) {
    return "API key or token";
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(value)) {
    return "IP address";
  }
  if (/^1[3-9]\d{9}$/.test(value)) {
    return "phone number";
  }
  if (/^\d{15,18}[xX]?$/.test(value)) {
    return "ID card number";
  }
  if (/@/.test(value)) {
    return "email address";
  }
  return "sensitive credential";
}

/**
 * 安全护栏主入口。
 *
 * 优先使用本地模型进行智能脱敏。如果本地模型不可用，回退到正则匹配模式。
 */
export async function applyGuardrail(
  prompt: string,
  options?: GuardrailOptions,
): Promise<ScanResult> {
  // 未配置或显式禁用 → 跳过
  if (options?.enable === false) {
    return {
      vault: new TokenVault(),
      findingsCount: 0,
      method: "skipped",
    };
  }

  // 优先尝试本地模型脱敏
  const hasLocalModel = options?.localBaseUrl && options?.localModel;
  if (hasLocalModel) {
    // 只提取用户消息发给本地模型，避免系统元数据干扰
    const userMessage = extractUserMessage(prompt);
    const sensitiveValues = await callLocalModelForSensitiveValues(userMessage, options);

    if (sensitiveValues && sensitiveValues.length > 0) {
      // 将本地模型识别的敏感值转换为 Finding 格式，由 TokenVault 统一处理
      const findings: Finding[] = sensitiveValues.map((value) => ({
        type: "LLM-detected",
        value: value.length > 20 ? value.slice(0, 20) + "..." : value,
        fullValue: value,
        risk: "high" as const,
      }));
      const vault = new TokenVault();
      // 对完整 prompt 执行替换（不只是用户消息部分）
      vault.redact(prompt, findings);

      return {
        vault,
        findingsCount: Object.keys(vault.toDict()).length,
        method: "local-llm",
      };
    }

    // 本地模型返回空数组 → 没有敏感信息
    if (sensitiveValues && sensitiveValues.length === 0) {
      return {
        vault: new TokenVault(),
        findingsCount: 0,
        method: "local-llm",
      };
    }

    // 本地模型调用失败，根据配置决定是否回退
    if (options?.fallbackToRegexOnly === false) {
      console.error("[Guardrail] 本地模型不可用且禁止回退，跳过脱敏");
      return {
        vault: new TokenVault(),
        findingsCount: 0,
        method: "skipped",
      };
    }
    console.warn("[Guardrail] 本地模型不可用，回退到正则模式");
  }

  // 回退：使用正则匹配模式
  const regexFindings = scanSensitive(prompt);
  const vault = new TokenVault();
  vault.redact(prompt, regexFindings);

  return {
    vault,
    findingsCount: Object.keys(vault.toDict()).length,
    method: "regex-only",
  };
}
