import type { SemanticRouter } from "./semantic-router.js";
import { TaskType } from "./types.js";

// L1: Keyword rules (synchronous, zero-latency)
//
// Pattern notes:
//   • Use (?<![a-zA-Z0-9_]) / (?![a-zA-Z0-9_]) instead of \b so that CJK
//     characters (non-\w) are also matched at proper boundaries.
//   • Rules are ordered by specificity: more-specific or higher-priority tasks
//     listed first so the first-match wins rule gives expected results.
//     Notably: VISUAL_CRITIQUE > CODE_REVIEW > GIT_OPS (e.g. "screenshot and
//     review" → VISUAL_CRITIQUE, "review this PR" → CODE_REVIEW).

const W = "(?<![a-zA-Z0-9_])";
const W_ = "(?![a-zA-Z0-9_])";

const rules: Array<[RegExp, TaskType]> = [
  [
    new RegExp(`${W}(fix|debug|error|bug|crash|exception|报错|调试|排错)${W_}`, "i"),
    TaskType.CODE_DEBUG,
  ],
  [
    new RegExp(`${W}(refactor|重构|reorganize|restructure|优化代码|整理代码)${W_}`, "i"),
    TaskType.CODE_REFACTOR,
  ],
  [
    new RegExp(`${W}(write test|测试|vitest|jest|unittest|spec|写测试|加测试)${W_}`, "i"),
    TaskType.TEST_WRITE,
  ],
  [new RegExp(`${W}(翻译|translate|i18n|localization)${W_}`, "i"), TaskType.TRANSLATION],
  [
    new RegExp(`${W}(README|文档|document|changelog|CHANGELOG|写文档|更新文档|改文档)${W_}`, "i"),
    TaskType.DOC_WRITE,
  ],
  // VISUAL_CRITIQUE before CODE_REVIEW so "screenshot and review" → VISUAL_CRITIQUE
  [
    new RegExp(`${W}(截图|screenshot|UI|界面|visual|图片|image)${W_}`, "i"),
    TaskType.VISUAL_CRITIQUE,
  ],
  // CODE_REVIEW before GIT_OPS so "review this PR" → CODE_REVIEW
  [new RegExp(`${W}(review|code review|审查|审阅)${W_}`, "i"), TaskType.CODE_REVIEW],
  [
    new RegExp(
      `${W}(git|commit|push|PR|pull request|rebase|merge|branch|提交|合并|推送)${W_}`,
      "i",
    ),
    TaskType.GIT_OPS,
  ],
  [new RegExp(`${W}(scaffold|脚手架|boilerplate|template|generate)${W_}`, "i"), TaskType.SCAFFOLD],
  [new RegExp(`${W}(CI|CD|pipeline|github action|workflow fail)${W_}`, "i"), TaskType.CI_DEBUG],
  [new RegExp(`${W}(security|audit|vulnerability|安全|漏洞)${W_}`, "i"), TaskType.SECURITY_AUDIT],
  [new RegExp(`${W}(shell|bash|script|zsh)${W_}`, "i"), TaskType.SHELL_SCRIPT],
  [new RegExp(`${W}(memory|记忆|MEMORY\\.md)${W_}`, "i"), TaskType.MEMORY_UPDATE],
  // PLANNING before CODE_EDIT so "计划来实现" → PLANNING
  [new RegExp(`${W}(计划|plan|设计|design|architecture|架构)${W_}`, "i"), TaskType.PLANNING],
  [new RegExp(`${W}(heartbeat|心跳)${W_}`, "i"), TaskType.HEARTBEAT_CHECK],
  [
    // 修改|改 etc. — bare 改 included; higher-priority rules (DOC_WRITE, GIT_OPS, etc.)
    // fire first for "改文档", "提交这次修改" etc., so CODE_EDIT only captures
    // genuine edit requests like "帮我改这个函数的逻辑".
    new RegExp(
      `${W}(implement|实现|写代码|write code|新增功能|feature|编码|修改|改|改代码|改函数|改逻辑|添加|加个|增加|改一下|改下)${W_}`,
      "i",
    ),
    TaskType.CODE_EDIT,
  ],
];

/**
 * Resolve the TaskType for a given text input.
 *
 * Resolution order:
 *   L1: keyword rules (synchronous, zero-latency) — returns immediately on match
 *   L1.5: semantic router (local embedding + cosine similarity) — used when semanticRouter is provided
 *   L2: TODO — Flash LLM classification (future)
 *   Fallback: returns TaskType.FALLBACK
 *
 * @param text - user input text
 * @param semanticRouter - optional SemanticRouter instance for L1.5 resolution
 * @param recentContext - optional short-window context (e.g. last 2 messages) prepended to the
 *   semantic router query. Only used at L1.5; L1 keyword matching always uses bare `text` to
 *   avoid unintended keyword leakage from history.
 */
export async function resolveTaskType(
  text: string,
  semanticRouter?: SemanticRouter,
  recentContext?: string,
): Promise<TaskType> {
  // L1: iterate rules in order, return on first match (synchronous, zero-latency)
  // recentContext is intentionally NOT used here — keyword rules must fire on the current message
  // only, not on stale history that may contain unrelated keywords.
  for (const [pattern, taskType] of rules) {
    if (pattern.test(text)) {
      console.debug("[routing] L1 hit: %s → %s", text.slice(0, 40), taskType);
      return taskType;
    }
  }

  // L1.5: semantic router — local embedding + cosine similarity
  // When recentContext is provided, prepend it so the embedding captures the conversational intent
  // (e.g. "好" after "帮我写代码" → CODE_EDIT rather than FALLBACK).
  if (semanticRouter) {
    const queryText = recentContext ? `${recentContext}\n${text}` : text;
    const semanticResult = await semanticRouter.resolve(queryText);
    if (semanticResult !== null) {
      console.debug("[routing] L1.5 hit: %s → %s", text.slice(0, 40), semanticResult);
      return semanticResult;
    }
  }

  // L2: TODO - Flash LLM classification (async)
  // For now, fall back to FALLBACK when no L1/L1.5 rule matches
  console.debug("[routing] fallback: %s", text.slice(0, 40));
  return TaskType.FALLBACK;
}

/**
 * Run only the L1 keyword rules against the given text.
 *
 * Returns the matching TaskType or `null` when no rule matches.
 * Useful for debug commands that want to show L1 and L1.5 results separately.
 */
export function resolveL1TaskType(text: string): TaskType | null {
  for (const [pattern, taskType] of rules) {
    if (pattern.test(text)) {
      return taskType;
    }
  }
  return null;
}
