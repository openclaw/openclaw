import fs from "node:fs/promises";
import path from "node:path";

import { type AgentKind, getAgentSpec } from "../agents/index.js";
import type { AgentMeta, AgentToolResult } from "../agents/types.js";
import type { WarelayConfig } from "../config/config.js";
import { isVerbose, logVerbose } from "../globals.js";
import { logError } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { enqueueCommand } from "../process/command-queue.js";
import type { runCommandWithTimeout } from "../process/exec.js";
import { runPiRpc } from "../process/tau-rpc.js";
import { applyTemplate, type TemplateContext } from "./templating.js";
import {
  formatToolAggregate,
  shortenMeta,
  shortenPath,
  TOOL_RESULT_DEBOUNCE_MS,
  TOOL_RESULT_FLUSH_COUNT,
} from "./tool-meta.js";
import type { ReplyPayload } from "./types.js";

type CommandReplyConfig = NonNullable<WarelayConfig["inbound"]>["reply"] & {
  mode: "command";
};

type EnqueueRunner = typeof enqueueCommand;

type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high";

type CommandReplyParams = {
  reply: CommandReplyConfig;
  templatingCtx: TemplateContext;
  sendSystemOnce: boolean;
  isNewSession: boolean;
  isFirstTurnInSession: boolean;
  systemSent: boolean;
  timeoutMs: number;
  timeoutSeconds: number;
  commandRunner: typeof runCommandWithTimeout;
  enqueue?: EnqueueRunner;
  thinkLevel?: ThinkLevel;
  verboseLevel?: "off" | "on";
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
};

export type CommandReplyMeta = {
  durationMs: number;
  queuedMs?: number;
  queuedAhead?: number;
  exitCode?: number | null;
  signal?: string | null;
  killed?: boolean;
  agentMeta?: AgentMeta;
};

export type CommandReplyResult = {
  payloads?: ReplyPayload[];
  meta: CommandReplyMeta;
};

type ToolMessageLike = {
  name?: string;
  toolName?: string;
  tool_call_id?: string;
  toolCallId?: string;
  role?: string;
  details?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  content?: unknown;
};

function inferToolName(message?: ToolMessageLike): string | undefined {
  if (!message) return undefined;
  const candidates = [
    message.toolName,
    message.name,
    message.toolCallId,
    message.tool_call_id,
  ]
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter(Boolean);
  if (candidates.length) return candidates[0];

  if (message.role?.includes(":")) {
    const suffix = message.role.split(":").slice(1).join(":").trim();
    if (suffix) return suffix;
  }
  return undefined;
}

function inferToolMeta(message?: ToolMessageLike): string | undefined {
  if (!message) return undefined;
  // Special handling for edit tool: surface change kind + path + summary.
  if (
    (message.toolName ?? message.name)?.toLowerCase?.() === "edit" ||
    message.role === "tool_result:edit"
  ) {
    const details = message.details ?? message.arguments;
    const diff =
      details && typeof details.diff === "string" ? details.diff : undefined;

    // Count added/removed lines to infer change kind.
    let added = 0;
    let removed = 0;
    if (diff) {
      for (const line of diff.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("+++")) continue;
        if (trimmed.startsWith("---")) continue;
        if (trimmed.startsWith("+")) added += 1;
        else if (trimmed.startsWith("-")) removed += 1;
      }
    }
    let changeKind = "edit";
    if (added > 0 && removed > 0) changeKind = "insert+replace";
    else if (added > 0) changeKind = "insert";
    else if (removed > 0) changeKind = "delete";

    // Try to extract a file path from content text or details.path.
    const contentText = (() => {
      const raw = (message as { content?: unknown })?.content;
      if (!Array.isArray(raw)) return undefined;
      const texts = raw
        .map((c) =>
          typeof c === "string"
            ? c
            : typeof (c as { text?: unknown }).text === "string"
              ? ((c as { text?: string }).text ?? "")
              : "",
        )
        .filter(Boolean);
      return texts.join(" ");
    })();

    const pathFromDetails =
      details && typeof details.path === "string" ? details.path : undefined;
    const pathFromContent =
      contentText?.match(/\s(?:in|at)\s+(\S+)/)?.[1] ?? undefined;
    const pathVal = pathFromDetails ?? pathFromContent;
    const shortPath = pathVal ? shortenMeta(pathVal) : undefined;

    // Pick a short summary from the first added line in the diff.
    const summary = (() => {
      if (!diff) return undefined;
      const addedLine = diff
        .split("\n")
        .map((l) => l.trimStart())
        .find((l) => l.startsWith("+") && !l.startsWith("+++"));
      if (!addedLine) return undefined;
      const cleaned = addedLine.replace(/^\+\s*\d*\s*/, "").trim();
      if (!cleaned) return undefined;
      const markdownStripped = cleaned.replace(/^[#>*-]\s*/, "");
      if (cleaned.startsWith("#")) {
        return `Add ${markdownStripped}`;
      }
      return markdownStripped;
    })();

    const parts: string[] = [`→ ${changeKind}`];
    if (shortPath) parts.push(`@ ${shortPath}`);
    if (summary) parts.push(`| ${summary}`);
    return parts.join(" ");
  }

  const details = message.details ?? message.arguments;
  const pathVal =
    details && typeof details.path === "string" ? details.path : undefined;
  const offset =
    details && typeof details.offset === "number" ? details.offset : undefined;
  const limit =
    details && typeof details.limit === "number" ? details.limit : undefined;
  const command =
    details && typeof details.command === "string"
      ? details.command
      : undefined;

  const formatPath = shortenPath;

  if (pathVal) {
    const displayPath = formatPath(pathVal);
    if (offset !== undefined && limit !== undefined) {
      return `${displayPath}:${offset}-${offset + limit}`;
    }
    return displayPath;
  }
  if (command) return command;
  return undefined;
}

function normalizeToolResults(
  toolResults?: Array<string | AgentToolResult>,
): AgentToolResult[] {
  if (!toolResults) return [];
  return toolResults
    .map((tr) => (typeof tr === "string" ? { text: tr } : tr))
    .map((tr) => ({
      text: (tr.text ?? "").trim(),
      toolName: tr.toolName?.trim() || undefined,
      meta: tr.meta ? shortenMeta(tr.meta) : undefined,
    }))
    .filter((tr) => tr.text.length > 0);
}

export function summarizeClaudeMetadata(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];

  if (typeof obj.duration_ms === "number") {
    parts.push(`duration=${obj.duration_ms}ms`);
  }
  if (typeof obj.duration_api_ms === "number") {
    parts.push(`api=${obj.duration_api_ms}ms`);
  }
  if (typeof obj.num_turns === "number") {
    parts.push(`turns=${obj.num_turns}`);
  }
  if (typeof obj.total_cost_usd === "number") {
    parts.push(`cost=$${obj.total_cost_usd.toFixed(4)}`);
  }

  const usage = obj.usage;
  if (usage && typeof usage === "object") {
    const serverToolUse = (
      usage as { server_tool_use?: Record<string, unknown> }
    ).server_tool_use;
    if (serverToolUse && typeof serverToolUse === "object") {
      const toolCalls = Object.values(serverToolUse).reduce<number>(
        (sum, val) => {
          if (typeof val === "number") return sum + val;
          return sum;
        },
        0,
      );
      if (toolCalls > 0) parts.push(`tool_calls=${toolCalls}`);
    }
  }

  const modelUsage = obj.modelUsage;
  if (modelUsage && typeof modelUsage === "object") {
    const models = Object.keys(modelUsage as Record<string, unknown>);
    if (models.length) {
      const display =
        models.length > 2
          ? `${models.slice(0, 2).join(",")}+${models.length - 2}`
          : models.join(",");
      parts.push(`models=${display}`);
    }
  }

  return parts.length ? parts.join(", ") : undefined;
}

function appendThinkingCue(body: string, level?: ThinkLevel): string {
  if (!level || level === "off") return body;
  const cue = (() => {
    switch (level) {
      case "high":
        return "ultrathink";
      case "medium":
        return "think harder";
      case "low":
        return "think hard";
      case "minimal":
        return "think";
      default:
        return "";
    }
  })();
  return [body.trim(), cue].filter(Boolean).join(" ");
}

export async function runCommandReply(
  params: CommandReplyParams,
): Promise<CommandReplyResult> {
  const logger = getChildLogger({ module: "command-reply" });
  const verboseLog = (msg: string) => {
    logger.debug(msg);
    if (isVerbose()) logVerbose(msg);
  };

  const {
    reply,
    templatingCtx,
    sendSystemOnce,
    isNewSession,
    isFirstTurnInSession,
    systemSent,
    timeoutMs,
    timeoutSeconds,
    commandRunner,
    enqueue = enqueueCommand,
    thinkLevel,
    verboseLevel,
    onPartialReply,
  } = params;

  if (!reply.command?.length) {
    throw new Error("reply.command is required for mode=command");
  }
  const agentCfg = reply.agent ?? { kind: "claude" };
  const agentKind: AgentKind = agentCfg.kind ?? "claude";
  const agent = getAgentSpec(agentKind);

  let argv = reply.command.map((part) => applyTemplate(part, templatingCtx));
  const templatePrefix =
    reply.template && (!sendSystemOnce || isFirstTurnInSession || !systemSent)
      ? applyTemplate(reply.template, templatingCtx)
      : "";
  if (templatePrefix && argv.length > 0) {
    argv = [argv[0], templatePrefix, ...argv.slice(1)];
  }

  // Default body index is last arg
  let bodyIndex = Math.max(argv.length - 1, 0);

  // Session args prepared (templated) and injected generically
  if (reply.session) {
    const defaultSessionArgs = (() => {
      switch (agentCfg.kind) {
        case "claude":
          return {
            newArgs: ["--session-id", "{{SessionId}}"],
            resumeArgs: ["--resume", "{{SessionId}}"],
          };
        case "gemini":
          // Gemini CLI supports --resume <id>; starting a new session needs no flag.
          return { newArgs: [], resumeArgs: ["--resume", "{{SessionId}}"] };
        default:
          return {
            newArgs: ["--session", "{{SessionId}}"],
            resumeArgs: ["--session", "{{SessionId}}"],
          };
      }
    })();
    const defaultNew = defaultSessionArgs.newArgs;
    const defaultResume = defaultSessionArgs.resumeArgs;
    const sessionArgList = (
      isNewSession
        ? (reply.session.sessionArgNew ?? defaultNew)
        : (reply.session.sessionArgResume ?? defaultResume)
    ).map((p) => applyTemplate(p, templatingCtx));

    // Tau (pi agent) needs --continue to reload prior messages when resuming.
    // Without it, pi starts from a blank state even though we pass the session file path.
    if (
      agentKind === "pi" &&
      !isNewSession &&
      !sessionArgList.includes("--continue")
    ) {
      sessionArgList.push("--continue");
    }

    if (sessionArgList.length) {
      const insertBeforeBody = reply.session.sessionArgBeforeBody ?? true;
      const insertAt =
        insertBeforeBody && argv.length > 1 ? argv.length - 1 : argv.length;
      argv = [
        ...argv.slice(0, insertAt),
        ...sessionArgList,
        ...argv.slice(insertAt),
      ];
      bodyIndex = Math.max(argv.length - 1, 0);
    }
  }

  if (thinkLevel && thinkLevel !== "off") {
    if (agentKind === "pi") {
      const hasThinkingFlag = argv.some(
        (p, i) =>
          p === "--thinking" ||
          (i > 0 && argv[i - 1] === "--thinking") ||
          p.startsWith("--thinking="),
      );
      if (!hasThinkingFlag) {
        argv.splice(bodyIndex, 0, "--thinking", thinkLevel);
        bodyIndex += 2;
      }
    } else if (argv[bodyIndex]) {
      argv[bodyIndex] = appendThinkingCue(argv[bodyIndex] ?? "", thinkLevel);
    }
  }

  const shouldApplyAgent = agent.isInvocation(argv);
  let finalArgv = shouldApplyAgent
    ? agent.buildArgs({
        argv,
        bodyIndex,
        isNewSession,
        sessionId: templatingCtx.SessionId,
        sendSystemOnce,
        systemSent,
        identityPrefix: agentCfg.identityPrefix,
        format: agentCfg.format,
      })
    : argv;

  // For pi/tau: prefer RPC mode so auto-compaction and streaming events run server-side.
  let rpcInput: string | undefined;
  if (agentKind === "pi") {
    const bodyArg = finalArgv[bodyIndex] ?? templatingCtx.Body ?? "";
    rpcInput = JSON.stringify({ type: "prompt", message: bodyArg }) + "\n";
    // Remove body argument (RPC expects stdin JSON instead of positional message)
    finalArgv = finalArgv.filter((_, idx) => idx !== bodyIndex);
    // Force --mode rpc
    const modeIdx = finalArgv.findIndex((v) => v === "--mode");
    if (modeIdx >= 0 && finalArgv[modeIdx + 1]) {
      finalArgv[modeIdx + 1] = "rpc";
    } else {
      finalArgv.push("--mode", "rpc");
    }
  }

  logVerbose(
    `Running command auto-reply: ${finalArgv.join(" ")}${reply.cwd ? ` (cwd: ${reply.cwd})` : ""}`,
  );
  logger.info(
    {
      agent: agentKind,
      sessionId: templatingCtx.SessionId,
      newSession: isNewSession,
      cwd: reply.cwd,
      command: finalArgv.slice(0, -1), // omit body to reduce noise
    },
    "command auto-reply start",
  );

  const started = Date.now();
  let queuedMs: number | undefined;
  let queuedAhead: number | undefined;
  try {
    let pendingToolName: string | undefined;
    let pendingMetas: string[] = [];
    let pendingTimer: NodeJS.Timeout | null = null;
    const toolMetaById = new Map<string, string | undefined>();
    const flushPendingTool = () => {
      if (!onPartialReply) return;
      if (!pendingToolName && pendingMetas.length === 0) return;
      const text = formatToolAggregate(pendingToolName, pendingMetas);
      const { text: cleanedText, mediaUrls: mediaFound } =
        splitMediaFromOutput(text);
      void onPartialReply({
        text: cleanedText,
        mediaUrls: mediaFound?.length ? mediaFound : undefined,
      } as ReplyPayload);
      pendingToolName = undefined;
      pendingMetas = [];
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    };
    let lastStreamedAssistant: string | undefined;
    const streamAssistant = (msg?: { role?: string; content?: unknown[] }) => {
      if (!onPartialReply || msg?.role !== "assistant") return;
      const textBlocks = Array.isArray(msg.content)
        ? (msg.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => (c.text ?? "").trim())
            .filter(Boolean)
        : [];
      if (textBlocks.length === 0) return;
      const combined = textBlocks.join("\n").trim();
      if (!combined || combined === lastStreamedAssistant) return;
      lastStreamedAssistant = combined;
      const { text: cleanedText, mediaUrls: mediaFound } =
        splitMediaFromOutput(combined);
      void onPartialReply({
        text: cleanedText,
        mediaUrls: mediaFound?.length ? mediaFound : undefined,
      } as ReplyPayload);
    };

    const run = async () => {
      // Prefer long-lived tau RPC for pi agent to avoid cold starts.
      if (agentKind === "pi") {
        const promptIndex = finalArgv.length - 1;
        const body = finalArgv[promptIndex] ?? "";
        // Build rpc args without the prompt body; force --mode rpc.
        const rpcArgv = (() => {
          const copy = [...finalArgv];
          copy.splice(promptIndex, 1);
          const modeIdx = copy.indexOf("--mode");
          if (modeIdx >= 0 && copy[modeIdx + 1]) {
            copy.splice(modeIdx, 2, "--mode", "rpc");
          } else if (!copy.includes("--mode")) {
            copy.splice(copy.length - 1, 0, "--mode", "rpc");
          }
          return copy;
        })();
        const rpcResult = await runPiRpc({
          argv: rpcArgv,
          cwd: reply.cwd,
          prompt: body,
          timeoutMs,
          onEvent: onPartialReply
            ? (line: string) => {
                try {
                  const ev = JSON.parse(line) as {
                    type?: string;
                    message?: {
                      role?: string;
                      content?: unknown[];
                      details?: Record<string, unknown>;
                      arguments?: Record<string, unknown>;
                      toolCallId?: string;
                      tool_call_id?: string;
                      toolName?: string;
                      name?: string;
                    };
                    toolCallId?: string;
                    toolName?: string;
                    args?: Record<string, unknown>;
                  };
                  // Capture metadata as soon as the tool starts (from args).
                  if (ev.type === "tool_execution_start") {
                    const toolName = ev.toolName;
                    const meta = inferToolMeta({
                      toolName,
                      name: ev.toolName,
                      arguments: ev.args,
                    });
                    if (ev.toolCallId) {
                      toolMetaById.set(ev.toolCallId, meta);
                    }
                    if (meta) {
                      if (
                        pendingToolName &&
                        toolName &&
                        toolName !== pendingToolName
                      ) {
                        flushPendingTool();
                      }
                      if (!pendingToolName) pendingToolName = toolName;
                      pendingMetas.push(meta);
                      if (
                        TOOL_RESULT_FLUSH_COUNT > 0 &&
                        pendingMetas.length >= TOOL_RESULT_FLUSH_COUNT
                      ) {
                        flushPendingTool();
                      } else {
                        if (pendingTimer) clearTimeout(pendingTimer);
                        pendingTimer = setTimeout(
                          flushPendingTool,
                          TOOL_RESULT_DEBOUNCE_MS,
                        );
                      }
                    }
                  }
                  if (
                    (ev.type === "message" || ev.type === "message_end") &&
                    ev.message?.role === "tool_result" &&
                    Array.isArray(ev.message.content)
                  ) {
                    const toolName = inferToolName(ev.message);
                    const toolCallId =
                      ev.message.toolCallId ?? ev.message.tool_call_id;
                    const meta =
                      inferToolMeta(ev.message) ??
                      (toolCallId ? toolMetaById.get(toolCallId) : undefined);
                    if (
                      pendingToolName &&
                      toolName &&
                      toolName !== pendingToolName
                    ) {
                      flushPendingTool();
                    }
                    if (!pendingToolName) pendingToolName = toolName;
                    if (meta) pendingMetas.push(meta);
                    if (
                      TOOL_RESULT_FLUSH_COUNT > 0 &&
                      pendingMetas.length >= TOOL_RESULT_FLUSH_COUNT
                    ) {
                      flushPendingTool();
                      return;
                    }
                    if (pendingTimer) clearTimeout(pendingTimer);
                    pendingTimer = setTimeout(
                      flushPendingTool,
                      TOOL_RESULT_DEBOUNCE_MS,
                    );
                  }
                  if (
                    ev.type === "message_end" ||
                    ev.type === "message_update" ||
                    ev.type === "message"
                  ) {
                    streamAssistant(ev.message);
                  }
                } catch {
                  // ignore malformed lines
                }
              }
            : undefined,
        });
        flushPendingTool();
        return rpcResult;
      }
      return await commandRunner(finalArgv, {
        timeoutMs,
        cwd: reply.cwd,
        input: rpcInput,
      });
    };

    const { stdout, stderr, code, signal, killed } = await enqueue(run, {
      onWait: (waitMs, ahead) => {
        queuedMs = waitMs;
        queuedAhead = ahead;
        if (isVerbose()) {
          logVerbose(
            `Command auto-reply queued for ${waitMs}ms (${queuedAhead} ahead)`,
          );
        }
      },
    });
    const rawStdout = stdout.trim();
    let mediaFromCommand: string[] | undefined;
    const trimmed = rawStdout;
    if (stderr?.trim()) {
      logVerbose(`Command auto-reply stderr: ${stderr.trim()}`);
    }

    const logFailure = () => {
      const truncate = (s?: string) =>
        s ? (s.length > 4000 ? `${s.slice(0, 4000)}…` : s) : undefined;
      logger.warn(
        {
          code,
          signal,
          killed,
          argv: finalArgv,
          cwd: reply.cwd,
          stdout: truncate(rawStdout),
          stderr: truncate(stderr),
        },
        "command auto-reply failed",
      );
    };

    const parsed = trimmed ? agent.parseOutput(trimmed) : undefined;
    const parserProvided = !!parsed;

    // Collect assistant texts and tool results from parseOutput (tau RPC can emit many).
    const parsedTexts =
      parsed?.texts?.map((t) => t.trim()).filter(Boolean) ?? [];
    const parsedToolResults = normalizeToolResults(parsed?.toolResults);

    type ReplyItem = { text: string; media?: string[] };
    const replyItems: ReplyItem[] = [];

    const includeToolResultsInline =
      verboseLevel === "on" && !onPartialReply && parsedToolResults.length > 0;

    if (includeToolResultsInline) {
      const aggregated = parsedToolResults.reduce<
        { toolName?: string; metas: string[]; previews: string[] }[]
      >((acc, tr) => {
        const last = acc.at(-1);
        if (last && last.toolName === tr.toolName) {
          if (tr.meta) last.metas.push(tr.meta);
          if (tr.text) last.previews.push(tr.text);
        } else {
          acc.push({
            toolName: tr.toolName,
            metas: tr.meta ? [tr.meta] : [],
            previews: tr.text ? [tr.text] : [],
          });
        }
        return acc;
      }, []);

      const emojiForTool = (tool?: string) => {
        const t = (tool ?? "").toLowerCase();
        if (t === "bash" || t === "shell") return "💻";
        if (t === "read") return "📄";
        if (t === "write") return "✍️";
        if (t === "edit") return "📝";
        if (t === "attach") return "📎";
        return "🛠️";
      };

      const stripToolPrefix = (text: string) =>
        text.replace(/^\[🛠️ [^\]]+\]\s*/, "");

      const formatPreview = (texts: string[]) => {
        const joined = texts.join(" ").trim();
        if (!joined) return "";
        const clipped =
          joined.length > 120 ? `${joined.slice(0, 117)}…` : joined;
        return ` — “${clipped}”`;
      };

      for (const tr of aggregated) {
        const prefix = formatToolAggregate(tr.toolName, tr.metas);
        const preview = formatPreview(tr.previews);
        const decorated = `${emojiForTool(tr.toolName)} ${stripToolPrefix(prefix)}${preview}`;
        const { text: cleanedText, mediaUrls: mediaFound } =
          splitMediaFromOutput(decorated);
        replyItems.push({
          text: cleanedText,
          media: mediaFound?.length ? mediaFound : undefined,
        });
      }
    }

    for (const t of parsedTexts) {
      const { text: cleanedText, mediaUrls: mediaFound } =
        splitMediaFromOutput(t);
      replyItems.push({
        text: cleanedText,
        media: mediaFound?.length ? mediaFound : undefined,
      });
    }

    // If parser gave nothing, fall back to raw stdout as a single message.
    if (replyItems.length === 0 && trimmed && !parserProvided) {
      const { text: cleanedText, mediaUrls: mediaFound } =
        splitMediaFromOutput(trimmed);
      if (cleanedText || mediaFound?.length) {
        replyItems.push({
          text: cleanedText,
          media: mediaFound?.length ? mediaFound : undefined,
        });
      }
    }

    // No content at all → fallback notice.
    if (replyItems.length === 0) {
      const meta = parsed?.meta?.extra?.summary ?? undefined;
      replyItems.push({
        text: `(command produced no output${meta ? `; ${meta}` : ""})`,
      });
      verboseLog("No text/media produced; injecting fallback notice to user");
      logFailure();
    }

    verboseLog(
      `Command auto-reply stdout produced ${replyItems.length} message(s)`,
    );
    const elapsed = Date.now() - started;
    verboseLog(`Command auto-reply finished in ${elapsed}ms`);
    logger.info(
      { durationMs: elapsed, agent: agentKind, cwd: reply.cwd },
      "command auto-reply finished",
    );
    if ((code ?? 0) !== 0) {
      logFailure();
      console.error(
        `Command auto-reply exited with code ${code ?? "unknown"} (signal: ${signal ?? "none"})`,
      );
      // Include any partial output or stderr in error message
      const partialOut = trimmed
        ? `\n\nOutput: ${trimmed.slice(0, 500)}${trimmed.length > 500 ? "..." : ""}`
        : "";
      const errorText = `⚠️ Command exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${partialOut}`;
      return {
        payloads: [{ text: errorText }],
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: code,
          signal,
          killed,
          agentMeta: parsed?.meta,
        },
      };
    }
    if (killed && !signal) {
      console.error(
        `Command auto-reply process killed before completion (exit code ${code ?? "unknown"})`,
      );
      const errorText = `⚠️ Command was killed before completion (exit code ${code ?? "unknown"})`;
      return {
        payloads: [{ text: errorText }],
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: code,
          signal,
          killed,
          agentMeta: parsed?.meta,
        },
      };
    }
    const meta: CommandReplyMeta = {
      durationMs: Date.now() - started,
      queuedMs,
      queuedAhead,
      exitCode: code,
      signal,
      killed,
      agentMeta: parsed?.meta,
    };

    const payloads: ReplyPayload[] = [];

    // Build each reply item sequentially (delivery handled by caller).
    for (const item of replyItems) {
      let mediaUrls =
        item.media ??
        mediaFromCommand ??
        (reply.mediaUrl ? [reply.mediaUrl] : undefined);

      // If mediaMaxMb is set, skip local media paths larger than the cap.
      if (mediaUrls?.length && reply.mediaMaxMb) {
        const maxBytes = reply.mediaMaxMb * 1024 * 1024;
        const filtered: string[] = [];
        for (const url of mediaUrls) {
          if (/^https?:\/\//i.test(url)) {
            filtered.push(url);
            continue;
          }
          const abs = path.isAbsolute(url) ? url : path.resolve(url);
          try {
            const stats = await fs.stat(abs);
            if (stats.size <= maxBytes) {
              filtered.push(url);
            } else if (isVerbose()) {
              logVerbose(
                `Skipping media ${url} (${(stats.size / (1024 * 1024)).toFixed(2)}MB) over cap ${reply.mediaMaxMb}MB`,
              );
            }
          } catch {
            filtered.push(url);
          }
        }
        mediaUrls = filtered;
      }

      const payload =
        item.text || mediaUrls?.length
          ? {
              text: item.text || undefined,
              mediaUrl: mediaUrls?.[0],
              mediaUrls,
            }
          : undefined;

      if (payload) payloads.push(payload);
    }

    verboseLog(`Command auto-reply meta: ${JSON.stringify(meta)}`);
    return { payloads, meta };
  } catch (err) {
    const elapsed = Date.now() - started;
    logger.info(
      { durationMs: elapsed, agent: agentKind, cwd: reply.cwd },
      "command auto-reply failed",
    );
    const anyErr = err as { killed?: boolean; signal?: string };
    const timeoutHit = anyErr.killed === true || anyErr.signal === "SIGKILL";
    const errorObj = err as { stdout?: string; stderr?: string };
    if (errorObj.stderr?.trim()) {
      verboseLog(`Command auto-reply stderr: ${errorObj.stderr.trim()}`);
    }
    if (timeoutHit) {
      console.error(
        `Command auto-reply timed out after ${elapsed}ms (limit ${timeoutMs}ms)`,
      );
      const baseMsg =
        "Command timed out after " +
        `${timeoutSeconds}s${reply.cwd ? ` (cwd: ${reply.cwd})` : ""}. Try a shorter prompt or split the request.`;
      const partial = errorObj.stdout?.trim();
      const partialSnippet =
        partial && partial.length > 800
          ? `${partial.slice(0, 800)}...`
          : partial;
      const text = partialSnippet
        ? `${baseMsg}\n\nPartial output before timeout:\n${partialSnippet}`
        : baseMsg;
      return {
        payloads: [{ text }],
        meta: {
          durationMs: elapsed,
          queuedMs,
          queuedAhead,
          exitCode: undefined,
          signal: anyErr.signal,
          killed: anyErr.killed,
        },
      };
    }
    logError(`Command auto-reply failed after ${elapsed}ms: ${String(err)}`);
    // Send error message to user so they know the command failed
    const errMsg = err instanceof Error ? err.message : String(err);
    const errorText = `⚠️ Command failed: ${errMsg}`;
    return {
      payloads: [{ text: errorText }],
      meta: {
        durationMs: elapsed,
        queuedMs,
        queuedAhead,
        exitCode: undefined,
        signal: anyErr.signal,
        killed: anyErr.killed,
      },
    };
  }
}
