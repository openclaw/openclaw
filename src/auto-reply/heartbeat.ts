import { parseDurationMs } from "../cli/parse-duration.js";
import { escapeRegExp } from "../shared/regexp.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

/**
 * 心跳任务配置类型
 * name: 任务名称
 * interval: 执行间隔
 * prompt: 执行的提示词
 */
export type HeartbeatTask = {
  name: string;
  interval: string;
  prompt: string;
};

/**
 * 默认心跳提示词
 * 用于当配置中未设置 heartbeat.prompt 时
 * 保持简洁，避免模型重复或推测旧的聊天任务
 */
export const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";
export const HEARTBEAT_TRANSCRIPT_PROMPT = "[OpenClaw heartbeat poll]";
export const DEFAULT_HEARTBEAT_EVERY = "30m";
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

/**
 * 检查HEARTBEAT.md内容是否"实际上为空"
 * 当文件中没有可操作的任务时允许跳过心跳API调用
 *
 * 以下情况视为空：
 * - 空白/空行
 * - Markdown ATX标题（#、##、...）
 * - Markdown代码标记 ``` 或 ```markdown
 * - 空列表项（- 、- [ ]、* 、+ ）
 *
 * 注意：文件不存在返回false（不为空），以便LLM仍可决定做什么
 * 此函数仅用于文件存在但无内容的情况
 */
export function isHeartbeatContentEffectivelyEmpty(content: string | undefined | null): boolean {
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content !== "string") {
    return false;
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }
    if (/^```[A-Za-z0-9_-]*$/.test(trimmed)) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * 解析心跳提示词
 * @param raw - 原始提示词字符串
 * @returns 规范化后的提示词，为空时返回默认值
 */
export function resolveHeartbeatPrompt(raw?: string): string {
  const trimmed = normalizeOptionalString(raw) ?? "";
  return trimmed || HEARTBEAT_PROMPT;
}

/**
 * 心跳令牌剥离模式
 * heartbeat: 仅移除心跳标记
 * message: 在消息上下文中剥离
 */
export type StripHeartbeatMode = "heartbeat" | "message";

/**
 * 剥离文本边缘的心跳标记
 * @param raw - 原始文本
 * @returns 剥离结果和是否发生剥离的标志
 */
function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { text: "", didStrip: false };
  }

  const token = HEARTBEAT_TOKEN;
  const tokenAtEndWithOptionalTrailingPunctuation = new RegExp(
    `${escapeRegExp(token)}[^\\w]{0,4}$`,
  );
  if (!text.includes(token)) {
    return { text, didStrip: false };
  }

  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(token)) {
      const after = next.slice(token.length).trimStart();
      text = after;
      didStrip = true;
      changed = true;
      continue;
    }
    if (tokenAtEndWithOptionalTrailingPunctuation.test(next)) {
      const idx = next.lastIndexOf(token);
      const before = next.slice(0, idx).trimEnd();
      if (!before) {
        text = "";
      } else {
        const after = next.slice(idx + token.length).trimStart();
        text = `${before}${after}`.trimEnd();
      }
      didStrip = true;
      changed = true;
    }
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return { text: collapsed, didStrip };
}

/**
 * 剥离心跳令牌
 * @param raw - 原始文本
 * @param opts - 选项，包含模式和最大确认字符数
 * @returns 剥离后的文本和是否应跳过的标志
 */
export function stripHeartbeatToken(
  raw?: string,
  opts: { mode?: StripHeartbeatMode; maxAckChars?: number } = {},
) {
  if (!raw) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }

  const mode: StripHeartbeatMode = opts.mode ?? "message";
  const maxAckCharsRaw = opts.maxAckChars;
  const parsedAckChars =
    typeof maxAckCharsRaw === "string" ? Number(maxAckCharsRaw) : maxAckCharsRaw;
  const maxAckChars = Math.max(
    0,
    typeof parsedAckChars === "number" && Number.isFinite(parsedAckChars)
      ? parsedAckChars
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  const stripMarkup = (text: string) =>
    text
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/^[*`~_]+/, "")
      .replace(/[*`~_]+$/, "");

  const trimmedNormalized = stripMarkup(trimmed);
  const hasToken = trimmed.includes(HEARTBEAT_TOKEN) || trimmedNormalized.includes(HEARTBEAT_TOKEN);
  if (!hasToken) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const strippedOriginal = stripTokenAtEdges(trimmed);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized);
  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;
  if (!picked.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  if (!picked.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  const rest = picked.text.trim();
  if (mode === "heartbeat") {
    if (rest.length <= maxAckChars) {
      return { shouldSkip: true, text: "", didStrip: true };
    }
  }

  return { shouldSkip: false, text: rest, didStrip: true };
}

/**
 * 从HEARTBEAT.md内容解析心跳任务
 * 支持YAML格式的任务定义
 */
export function parseHeartbeatTasks(content: string): HeartbeatTask[] {
  const tasks: HeartbeatTask[] = [];
  const lines = content.split("\n");
  let inTasksBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "tasks:") {
      inTasksBlock = true;
      continue;
    }

    if (!inTasksBlock) {
      continue;
    }

    const isTaskField =
      trimmed.startsWith("interval:") ||
      trimmed.startsWith("prompt:") ||
      trimmed.startsWith("- name:");
    if (
      !isTaskField &&
      !trimmed.startsWith(" ") &&
      !trimmed.startsWith("\t") &&
      trimmed &&
      !trimmed.startsWith("-")
    ) {
      inTasksBlock = false;
      continue;
    }

    if (trimmed.startsWith("- name:")) {
      const name = trimmed
        .replace("- name:", "")
        .trim()
        .replace(/^["']|["']$/g, "");
      let interval = "";
      let prompt = "";

      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        const nextTrimmed = nextLine.trim();

        if (nextTrimmed.startsWith("- name:")) {
          break;
        }

        if (
          nextTrimmed.startsWith("interval:") &&
          (nextLine.startsWith(" ") || nextLine.startsWith("\t"))
        ) {
          interval = nextTrimmed
            .replace("interval:", "")
            .trim()
            .replace(/^["']|["']$/g, "");
        } else if (
          nextTrimmed.startsWith("prompt:") &&
          (nextLine.startsWith(" ") || nextLine.startsWith("\t"))
        ) {
          prompt = nextTrimmed
            .replace("prompt:", "")
            .trim()
            .replace(/^["']|["']$/g, "");
        } else if (!nextTrimmed.startsWith(" ") && !nextTrimmed.startsWith("\t") && nextTrimmed) {
          inTasksBlock = false;
          break;
        }
      }

      if (name && interval && prompt) {
        tasks.push({ name, interval, prompt });
      }
    }
  }

  return tasks;
}

/**
 * 检查任务是否到期
 * @param lastRunMs - 上次运行时间戳
 * @param interval - 执行间隔字符串
 * @param nowMs - 当前时间戳
 * @returns 任务是否应该执行
 */
export function isTaskDue(lastRunMs: number | undefined, interval: string, nowMs: number): boolean {
  if (lastRunMs === undefined) {
    return true;
  }

  try {
    const intervalMs = parseDurationMs(interval, { defaultUnit: "m" });
    return nowMs - lastRunMs >= intervalMs;
  } catch {
    return false;
  }
}
