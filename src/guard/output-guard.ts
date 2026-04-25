/**
 * OpenClaw 安全防护模块 — 输出过滤
 * 
 * 位置: src/guard/output-guard.ts
 * 作用: 所有 Agent 输出经过此模块，脱敏敏感内容，防止信息泄露
 */

// ===== 敏感内容替换规则 =====

interface SanitizeRule {
  pattern: RegExp;
  replacement: string;
  reason: string;
}

const SANITIZE_RULES: SanitizeRule[] = [
  // --- 人设文件名 ---
  { pattern: /SOUL\.md/gi, replacement: '[REDACTED]', reason: '人设文件名' },
  { pattern: /IDENTITY\.md/gi, replacement: '[REDACTED]', reason: '身份文件名' },
  { pattern: /USER\.md/gi, replacement: '[REDACTED]', reason: '用户文件名' },
  { pattern: /MEMORY\.md/gi, replacement: '[REDACTED]', reason: '记忆文件名' },
  { pattern: /SKILL\.md/gi, replacement: '[REDACTED]', reason: '技能文件名' },

  // --- 内部人名/产品名 ---
  { pattern: /小\s*F/g, replacement: 'Nora', reason: '内部代号' },
  { pattern: /Flynn/gi, replacement: '[REDACTED]', reason: '内部人名' },

  // --- 内部系统名 ---
  { pattern: /WorkBuddy/gi, replacement: '[REDACTED]', reason: '内部系统名' },
  { pattern: /CodeBuddy/gi, replacement: '[REDACTED]', reason: '内部系统名' },
  { pattern: /OpenClaw/gi, replacement: '[REDACTED]', reason: '内部系统名' },
  { pattern: /workbuddy/gi, replacement: '[REDACTED]', reason: '内部系统名' },
  { pattern: /codebuddy/gi, replacement: '[REDACTED]', reason: '内部系统名' },
  { pattern: /openclaw/gi, replacement: '[REDACTED]', reason: '内部系统名' },

  // --- 内部路径 ---
  { pattern: /\.workbuddy\/(memory|skills|automations)/gi, replacement: '[REDACTED]', reason: '内部路径' },
  { pattern: /\/Users\/\w+\//g, replacement: '[HOME]/', reason: '用户路径' },
  { pattern: /\/home\/\w+\//g, replacement: '[HOME]/', reason: '用户路径' },
  { pattern: /C:\\Users\\\w+\\/gi, replacement: '[HOME]\\', reason: '用户路径' },

  // --- 脚本文件名 ---
  { pattern: /sku-query\.js/gi, replacement: '[REDACTED]', reason: '内部脚本' },
  { pattern: /price-lookup\.js/gi, replacement: '[REDACTED]', reason: '内部脚本' },
  { pattern: /wine_searcher\.js/gi, replacement: '[REDACTED]', reason: '内部脚本' },

  // --- 工作流内部术语 ---
  { pattern: /blueprint_data/gi, replacement: '[REDACTED]', reason: '内部术语' },
  { pattern: /nl2sql/gi, replacement: '[REDACTED]', reason: '内部术语' },
  { pattern: /reranker/gi, replacement: '[REDACTED]', reason: '内部术语' },
  { pattern: /intent_recognition/gi, replacement: '[REDACTED]', reason: '内部术语' },
  { pattern: /path_separation/gi, replacement: '[REDACTED]', reason: '内部术语' },
  { pattern: /fake_streaming/gi, replacement: '[REDACTED]', reason: '内部术语' },
  { pattern: /chat_consulting/gi, replacement: '[REDACTED]', reason: '内部术语' },

  // --- 数据结构字段 ---
  { pattern: /wine_id/gi, replacement: 'wine_id', reason: '允许(公开字段)' }, // wine_id 是公开的，不替换
  { pattern: /is_listed/gi, replacement: '[REDACTED]', reason: '内部字段' },
  { pattern: /must_know/gi, replacement: '[REDACTED]', reason: '内部字段' },
];

// ===== 泄露检测 =====

/**
 * 检测输出中是否包含 system prompt 片段
 * 用 5-gram Jaccard 相似度
 */
export function detectLeakage(output: string, protectedTexts: string[]): {
  leaked: boolean;
  score: number;
  matchedSource?: string;
} {
  const outputNgrams = getNgrams(output, 5);
  if (outputNgrams.size === 0) return { leaked: false, score: 0 };

  let maxOverlap = 0;
  let matchedSource = '';

  for (const text of protectedTexts) {
    const textNgrams = getNgrams(text, 5);
    if (textNgrams.size === 0) continue;
    const overlap = jaccardSimilarity(outputNgrams, textNgrams);
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      matchedSource = text.slice(0, 30) + '...';
    }
  }

  return {
    leaked: maxOverlap > 0.3,
    score: maxOverlap,
    matchedSource: matchedSource || undefined,
  };
}

// ===== 主过滤函数 =====

export class OutputGuard {
  private rules: SanitizeRule[];
  private protectedTexts: string[];

  constructor(protectedTexts: string[] = []) {
    this.rules = SANITIZE_RULES;
    this.protectedTexts = protectedTexts;
  }

  /**
   * 过滤输出内容
   * @returns { sanitized, leaked, leakScore }
   */
  sanitize(output: string): {
    sanitized: string;
    leaked: boolean;
    leakScore: number;
  } {
    let sanitized = output;

    // 1. 正则替换
    for (const rule of this.rules) {
      sanitized = sanitized.replace(rule.pattern, rule.replacement);
    }

    // 2. 泄露检测
    const leakResult = detectLeakage(sanitized, this.protectedTexts);

    return {
      sanitized,
      leaked: leakResult.leaked,
      leakScore: leakResult.score,
    };
  }
}

// ===== 工具函数 =====

function getNgrams(text: string, n: number): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const ngrams = new Set<string>();
  for (let i = 0; i <= normalized.length - n; i++) {
    ngrams.add(normalized.slice(i, i + n));
  }
  return ngrams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
