/**
 * Channel-agnostic waiting-tip controller.
 *
 * Sends a "received + random tip" message while the AI is thinking,
 * inspired by Claude Code CLI's spinner tips. The tip message is
 * deleted (or updated) once the AI reply arrives.
 *
 * Integration: called from channel dispatch functions (Telegram, Feishu,
 * WeChat, Discord, etc.) alongside the existing status-reaction controller.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type WaitingTipAdapter<TMessageId = unknown> = {
  /** Send the tip message and return a message identifier for later cleanup. */
  sendTip: (text: string) => Promise<TMessageId | undefined>;
  /** Delete the tip message after AI reply (optional — some channels can't delete). */
  deleteTip?: (messageId: TMessageId) => Promise<void>;
  /** Edit the tip message in-place (e.g. Feishu card update). */
  editTip?: (messageId: TMessageId, newText: string) => Promise<void>;
};

export type WaitingTipConfig = {
  /** Master switch (default: false). */
  enabled?: boolean;
  /** Minimum wait time before showing a tip (ms). Avoids flicker on fast responses. Default: 2000. */
  minWaitMs?: number;
  /** Delete the tip message after the AI reply is sent (default: true). */
  deleteAfterReply?: boolean;
  /** Display style: "inline" | "card". Default: "inline". */
  style?: "inline" | "card";
  /** Path to user-defined tips files (glob for *.txt). */
  customTipsPath?: string;
};

export type WaitingTipHandle<TMessageId = unknown> = {
  messageId: TMessageId;
  tip: string;
  sentAt: number;
};

export type WaitingTipController<_TMessageId = unknown> = {
  /** Schedule a tip. Sends after minWaitMs unless cancelled first. */
  scheduleShow: () => void;
  /** Cancel a scheduled tip (called if AI responds before minWaitMs). */
  cancel: () => void;
  /** Clean up: delete or edit the tip message. Call after AI reply is sent. */
  cleanup: () => Promise<void>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Built-in tips (75 bilingual tips)
// ─────────────────────────────────────────────────────────────────────────────

const BUILTIN_TIPS: readonly string[] = [
  // AI Interaction
  "Give AI enough context — quality doubles\n给 AI 足够的上下文，回答质量翻倍",
  "Ask one question at a time for better answers\n一次只问一个问题，AI 回答更精准",
  "Not satisfied? Rephrase and ask again\n不满意回答？换个角度重新问",
  "Ask AI to role-play as an expert for professional answers\n让 AI 扮演专家角色，回答更专业",
  'Use "step by step" to get AI\'s reasoning chain\n用 step by step 让 AI 展示推理过程',
  "Let AI understand the problem before solving it\n先让 AI 理解问题，再让它解决问题",
  "Few-shot examples beat zero-shot prompts\n给 AI 示例，few-shot 比 zero-shot 好",
  "Specify output format for structured answers\n告诉 AI 输出格式，结构化回答更有用",
  "Summarize context in long chats to prevent forgetting\n长对话记得总结上文，避免 AI 遗忘",
  'AI may hallucinate — ask it to say "I don\'t know"\nAI 不确定时会编造，要求它说"不知道"',
  "Break complex tasks into multi-turn conversations\n复杂任务拆成多轮对话，效果更好",
  "Ask AI for an outline first, then expand details\n让 AI 先列大纲，再逐步展开细节",
  'Compare and contrast: "What\'s the difference between A and B?"\n用对比提问: A 和 B 的区别是什么?',
  "Ask AI to verify its own answer for accuracy\n让 AI 检查自己的回答是否有错",
  "Add constraints: word limit, language, style\n提供约束条件: 字数限制、语言、风格",
  // OpenClaw
  "OpenClaw supports multi-turn context — keep the conversation going\nOpenClaw 支持多轮对话，保持上下文连贯",
  "Send images for OpenClaw to analyze and understand\n发送图片让 OpenClaw 识别和分析",
  "Use /help to see all available commands\n用 /help 查看所有可用命令",
  "Use /clear to reset conversation history\n用 /clear 清除对话历史重新开始",
  "OpenClaw can translate, write code, and analyze data\nOpenClaw 可以翻译、写作、编程、分析数据",
  "Send files for OpenClaw to interpret the content\n发送文件让 OpenClaw 解读内容",
  "@OpenClaw works in both DM and group chats\n私聊和群聊中都可以 @OpenClaw",
  "Set language preference for better responses\n设置语言偏好获取更好的回复体验",
  "OpenClaw remembers current session — use multi-turn interaction\nOpenClaw 记住本轮对话，充分利用多轮交互",
  "Use /model to switch between different AI models\n用 /model 切换不同的 AI 模型",
  "Ask complex questions step by step for better results\n复杂问题分步提问，效果优于一次性提问",
  "Send voice messages — OpenClaw understands them too\n发送语音消息，OpenClaw 也能理解",
  "Use /settings to customize your interaction preferences\n用 /settings 自定义你的交互偏好",
  "After 20+ turns, consider /clear for a fresh start\n连续对话超过 20 轮建议 /clear 重新开始",
  // Productivity
  "Use AI to generate templates, then fine-tune manually\n用 AI 生成模板，再手动调整细节",
  "Let AI review your code before you ship\n让 AI 帮你做代码审查",
  'Quick learning: "Explain like I\'m 5"\n用 AI 快速学习新概念: 像我5岁一样解释',
  "Ask AI to generate test data and mocks\n让 AI 生成测试数据和 mock 数据",
  "AI writes regex 10x faster than you\n用 AI 写正则表达式比自己写快10倍",
  "Ask AI to extract action items from meeting notes\n让 AI 把会议记录整理成行动项",
  "AI-translate tech docs, then human-review\n用 AI 翻译技术文档，再人工校对",
  "Let AI write your commit messages\n让 AI 帮你写 commit message",
  "Use AI to create text-based mind maps of complex concepts\n用 AI 将复杂概念做成思维导图文本版",
  "Ask AI to proofread emails for tone and grammar\n发邮件前让 AI 帮你检查语法和语气",
  "Ask AI to build a competitive analysis framework\n让 AI 帮你做竞品分析框架",
  "Use AI for batch format conversion tasks\n用 AI 批量处理格式转换任务",
  "Let AI write SQL queries for you\n让 AI 帮你写 SQL 查询语句",
  "Use AI to draft daily/weekly reports\n用 AI 做日报/周报的初稿",
  "Ask AI to analyze error logs for debugging\n让 AI 帮你排查错误日志",
  // Prompt Engineering
  "System prompt defines AI personality and rules\nSystem Prompt 定义 AI 人格和规则",
  "Lower temperature = deterministic, higher = creative\n温度越低越确定，越高越有创意",
  "Beginning of prompt carries more weight than the end\nPrompt 开头比结尾权重更大",
  "Format prompts with Markdown for better AI parsing\n用 Markdown 格式化 prompt，AI 解析更好",
  "Chain of Thought: make AI think step by step\nChain of Thought: 让 AI 一步步思考",
  '"Answer in JSON format" is the most practical constraint\n请以 JSON 格式回答 是最实用的约束',
  "Positive instructions > negative: say what TO do\n负面指令不如正面指令: 说做什么而非不做什么",
  "Use delimiters to mark input sections: --- or ```\n用分隔符标记输入区域: --- 或 ```",
  "ReAct pattern: Think-Act-Observe loop\nReAct 模式: 思考-行动-观察循环",
  "More specific prompts = less AI guessing\nPrompt 越具体，AI 越少猜测",
  "Give AI an exit condition to prevent infinite loops\n给 AI 一个退出条件防止无限循环",
  "English prompts often perform better across models\n用英文写 prompt 通常效果更好",
  "Start with a bad prompt, then iterate and improve\n先写一个糟糕的 prompt，再迭代优化",
  "Meta-prompting: ask AI to improve your prompt\nMeta-prompting: 让 AI 帮你写更好的 prompt",
  'Set output length: "Summarize in 3 sentences"\n设定输出长度: 用3句话总结',
  // Wisdom
  "AI is a tool, not the answer — you make the final call\nAI 是工具不是答案，最终决策在你",
  "Asking good questions is a superpower\n好的提问是一种超能力",
  "AI gives everyone a tireless assistant\nAI 让每个人都有了一个不知疲倦的助手",
  "Don't fear trial and error — just retry if unsatisfied\n不要害怕试错，AI 回答不满意就重来",
  "AI collaboration is THE skill of this era\n学会和 AI 协作是这个时代的核心技能",
  "The stronger AI gets, the more human judgment matters\nAI 越强大，人类判断力越重要",
  "Understand principles first, then use AI to accelerate\n先理解原理，再用 AI 加速执行",
  "AI output quality = your input quality\nAI 的输出质量 = 你的输入质量",
  "Automate repetitive work, save creativity for yourself\n自动化重复劳动，把创造力留给自己",
  "The future belongs to those who master their tools\n未来属于会使用工具的人",
  "Spend 10 minutes daily learning a new AI trick\n每天花 10 分钟学一个新的 AI 技巧",
  "Knowledge half-life is shrinking — keep learning\n知识的半衰期在缩短，持续学习是唯一出路",
  "Using AI isn't lazy — it's efficient time management\n用 AI 不是偷懒，是高效利用时间",
  "Share your AI tips to help others grow\n分享你的 AI 使用心得，帮助更多人",
  "Stay curious — the AI world evolves daily\n保持好奇心，AI 世界每天都在进化",
];

// ─────────────────────────────────────────────────────────────────────────────
// Default config
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MIN_WAIT_MS = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick a random tip from the built-in pool (+ optional custom tips).
 */
export function getRandomTip(customTips?: readonly string[]): string {
  const pool = customTips ? [...BUILTIN_TIPS, ...customTips] : BUILTIN_TIPS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Format a tip into the message shown to the user.
 * Inspired by Claude Code CLI spinner tips — concise, bilingual.
 */
export function formatWaitingMessage(tip: string, style: "inline" | "card" = "inline"): string {
  if (style === "card") {
    return [
      "━━━━━━━━━━━━━━━━━━━━",
      "⏳ Received! Thinking...",
      "",
      `💡 ${tip}`,
      "",
      "━━━━━━━━━━━━━━━━━━━━",
    ].join("\n");
  }
  return `⏳ Received, thinking...\n\n💡 ${tip}`;
}

/**
 * Create a waiting-tip controller for a single message lifecycle.
 *
 * The controller schedules a tip after `minWaitMs`. If the AI responds
 * before the timer fires, `cancel()` prevents the tip from being sent.
 * After the AI reply, `cleanup()` deletes/edits the tip message.
 */
export function createWaitingTipController<TMessageId>(params: {
  enabled: boolean;
  adapter: WaitingTipAdapter<TMessageId>;
  config?: WaitingTipConfig;
  customTips?: readonly string[];
  onError?: (err: unknown) => void;
}): WaitingTipController<TMessageId> {
  const { enabled, adapter, config, customTips, onError } = params;
  const minWaitMs = config?.minWaitMs ?? DEFAULT_MIN_WAIT_MS;
  const deleteAfterReply = config?.deleteAfterReply !== false;
  const style = config?.style ?? "inline";

  let timer: ReturnType<typeof setTimeout> | null = null;
  let handle: WaitingTipHandle<TMessageId> | null = null;
  let cancelled = false;
  let sendPromise: Promise<void> | null = null;

  function scheduleShow(): void {
    if (!enabled || cancelled) {
      return;
    }

    timer = setTimeout(() => {
      if (cancelled) {
        return;
      }

      const tip = getRandomTip(customTips);
      const text = formatWaitingMessage(tip, style);

      sendPromise = (async () => {
        try {
          const messageId = await adapter.sendTip(text);
          if (messageId != null && !cancelled) {
            handle = { messageId, tip, sentAt: Date.now() };
          }
        } catch (err) {
          onError?.(err);
        }
      })();
    }, minWaitMs);
  }

  function cancel(): void {
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function cleanup(): Promise<void> {
    cancel();

    // Wait for any in-flight send to complete before cleanup
    if (sendPromise) {
      await sendPromise;
    }

    if (!handle) {
      return;
    }

    if (deleteAfterReply && adapter.deleteTip) {
      try {
        await adapter.deleteTip(handle.messageId);
      } catch (err) {
        onError?.(err);
      }
    }
    handle = null;
  }

  return { scheduleShow, cancel, cleanup };
}

/**
 * Expose the built-in tips for testing/external consumers.
 */
export function getBuiltinTips(): readonly string[] {
  return BUILTIN_TIPS;
}
