import type { ReviewGateConfig, TaskType } from "./types.js";
import { TaskType as TaskTypeEnum } from "./types.js";

export interface ReviewResult {
  status: "PASS" | "FAIL";
  reason: string;
  suggestions: string[];
}

export class ReviewGateError extends Error {
  constructor(public result: ReviewResult) {
    super(`Review gate: ${result.status} - ${result.reason}`);
    this.name = "ReviewGateError";
  }
}

export class ReviewGate {
  private config: ReviewGateConfig;

  constructor(config: ReviewGateConfig) {
    this.config = config;
  }

  /** 判断该 TaskType 是否需要审核 */
  shouldReview(taskType: TaskType): boolean {
    if (!this.config.enabled) {
      return false;
    }
    return this.config.high_risk_types.includes(taskType);
  }

  /** 是否自动模式 */
  isAutoMode(): boolean {
    return this.config.mode === "auto";
  }

  /** 构建审核 prompt */
  buildReviewPrompt(taskType: TaskType, originalTask: string, output: string): string {
    return [
      `## Review Request`,
      `**Task Type:** ${taskType}`,
      `**Original Task:**`,
      originalTask,
      `**Output to Review:**`,
      output,
      ``,
      `## Instructions`,
      `Analyze the output for:`,
      `1. Security vulnerabilities`,
      `2. Breaking changes`,
      `3. Code quality issues`,
      `4. Correctness vs original task requirements`,
      ``,
      `Respond with EXACTLY this JSON format:`,
      `{"status": "PASS" | "FAIL", "reason": "one sentence summary", "suggestions": ["suggestion 1", ...]}`,
    ].join("\n");
  }

  /** 解析审核响应为 ReviewResult */
  parseReviewResponse(response: string): ReviewResult {
    // 尝试从响应中提取 JSON
    const jsonMatch = response.match(/\{[\s\S]*?"status"[\s\S]*?\}/);
    if (!jsonMatch) {
      return { status: "FAIL", reason: "Could not parse reviewer response", suggestions: [] };
    }
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        status: parsed.status === "PASS" ? "PASS" : "FAIL",
        reason: typeof parsed.reason === "string" ? parsed.reason : "No reason provided",
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    } catch {
      return { status: "FAIL", reason: "Invalid JSON in reviewer response", suggestions: [] };
    }
  }

  /** 获取 reviewer 模型 */
  getReviewerModel(): string {
    return this.config.reviewer_model;
  }

  /** 获取 reviewer system prompt */
  getReviewerSystemPrompt(): string {
    return this.config.reviewer_system_prompt;
  }

  /** 获取超时时间 */
  getTimeoutMs(): number {
    return this.config.timeout_ms;
  }
}

/** 默认高风险类型列表 */
export const DEFAULT_HIGH_RISK_TYPES: TaskType[] = [
  TaskTypeEnum.CODE_REFACTOR,
  TaskTypeEnum.SECURITY_AUDIT,
  TaskTypeEnum.GIT_OPS,
];

/** 默认 reviewer system prompt */
export const DEFAULT_REVIEWER_PROMPT = `You are a code reviewer. Analyze changes for security vulnerabilities, breaking changes, and code quality issues. Return JSON: {"status": "PASS"|"FAIL", "reason": "...", "suggestions": [...]}`;
