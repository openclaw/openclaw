import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  AssistantMessage,
  Message,
} from "@mariozechner/pi-ai";
import { piSpec } from "../agents/pi.js";
import type { AgentMeta, AgentToolResult } from "../agents/types.js";
import type { ClawdisConfig } from "../config/config.js";
import { isVerbose, logVerbose } from "../globals.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { logError } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { enqueueCommand } from "../process/command-queue.js";
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

function stripStructuralPrefixes(text: string): string {
  return text
    .replace(/\[[^\]]+\]\s*/g, "")
    .replace(/^[ \t]*[A-Za-z0-9+()\-_. ]+:\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripRpcNoise(raw: string): string {
  // Drop rpc streaming scaffolding (toolcall deltas, audio buffer events) before parsing.
  const lines = raw.split(/\n+/);
  const kept: string[] = [];
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      const type = evt?.type;
      const msg = evt?.message ?? evt?.assistantMessageEvent;
      const msgType = msg?.type;
      const role = msg?.role;

      // Drop early lifecycle frames; we only want final assistant/tool outputs.
      if (type === "message_start") continue;

      // RPC streaming emits one message_update per delta; skip them to avoid flooding fallbacks.
      if (type === "message_update") continue;

      // Ignore toolcall delta chatter and input buffer append events.
      if (type === "message_update" && msgType === "toolcall_delta") continue;
      if (type === "input_audio_buffer.append") continue;

      // Keep only assistant/tool messages; drop agent_start/turn_start/user/etc.
      const isAssistant = role === "assistant";
      const isToolRole =
        typeof role === "string" && role.toLowerCase().includes("tool");
      if (!isAssistant && !isToolRole) continue;

      // Ignore assistant messages that have no text content unless they carry usage (final message_end often does).
      if (msg?.role === "assistant" && Array.isArray(msg?.content)) {
        const hasText = msg.content.some(
          (c: unknown) => (c as { type?: string })?.type === "text",
        );
        const hasUsage =
          typeof msg?.usage === "object" &&
          (msg.usage?.input != null || msg.usage?.output != null);
        if (!hasText && !hasUsage) continue;
      }
    } catch {
      // not JSON; keep as-is
    }
    if (line.trim()) kept.push(line);
  }
  return kept.join("\n");
}

async function runJsonFallback(opts: {
  argv: string[];
  cwd?: string;
  timeoutMs: number;
}): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(opts.argv[0], opts.argv.slice(1), {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `pi json fallback timed out after ${Math.round(opts.timeoutMs / 1000)}s`,
        ),
      );
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code: code ?? 0,
        signal,
        killed: child.killed,
      });
    });
  });
}

function extractRpcAssistantText(raw: string): string | undefined {
  if (!raw.trim()) return undefined;
  let deltaBuffer = "";
  let lastAssistant: string | undefined;
  for (const line of raw.split(/\n+/)) {
    try {
      const evt = JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
        assistantMessageEvent?: {
          type?: string;
          delta?: string;
          content?: string;
        };
      };
      if (
        evt.type === "message_end" &&
        evt.message?.role === "assistant" &&
        Array.isArray(evt.message.content)
      ) {
        const text = evt.message.content
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n")
          .trim();
        if (text) {
          lastAssistant = text;
          deltaBuffer = "";
        }
      }
      if (evt.type === "message_update" && evt.assistantMessageEvent) {
        const evtType = evt.assistantMessageEvent.type;
        if (
          evtType === "text_delta" ||
          evtType === "text_end" ||
          evtType === "text_start"
        ) {
          const chunk =
            typeof evt.assistantMessageEvent.delta === "string"
              ? evt.assistantMessageEvent.delta
              : typeof evt.assistantMessageEvent.content === "string"
                ? evt.assistantMessageEvent.content
                : "";
          if (chunk) {
            deltaBuffer += chunk;
            lastAssistant = deltaBuffer;
          }
        }
      }
    } catch {
      // ignore malformed/non-JSON lines
    }
  }
  return lastAssistant?.trim() || undefined;
}

function extractAssistantTextLoosely(raw: string): string | undefined {
  // Fallback: grab the last "text":"..." occurrence from a JSON-ish blob.
  const matches = [...raw.matchAll(/"text"\s*:\s*"([^"]+?)"/g)];
  if (!matches.length) return undefined;
  const last = matches.at(-1)?.[1];
  return last ? last.replace(/\\n/g, "\n").trim() : undefined;
}

type CommandReplyConfig = NonNullable<ClawdisConfig["inbound"]>["reply"] & {
  mode: "command";
};

type EnqueueCommandFn = typeof enqueueCommand;

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
  enqueue?: EnqueueCommandFn;
  thinkLevel?: ThinkLevel;
  verboseLevel?: "off" | "on";
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
  runId?: string;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
  }) => void;
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
    enqueue = enqueueCommand,
    thinkLevel,
    verboseLevel,
    onPartialReply,
  } = params;

  if (!reply.command?.length) {
    throw new Error("reply.command is required for mode=command");
  }
  const agentCfg = reply.agent ?? { kind: "pi" };
  const agent = piSpec;
  const agentKind = "pi";
  const rawCommand = reply.command;
  const hasBodyTemplate = rawCommand.some((part) =>
    /\{\{Body(Stripped)?\}\}/.test(part),
  );
  let argv = rawCommand.map((part) => applyTemplate(part, templatingCtx));
  const templatePrefix =
    reply.template && (!sendSystemOnce || isFirstTurnInSession || !systemSent)
      ? applyTemplate(reply.template, templatingCtx)
      : "";
  let prefixOffset = 0;
  if (templatePrefix && argv.length > 0) {
    argv = [argv[0], templatePrefix, ...argv.slice(1)];
    prefixOffset = 1;
  }

  // Extract (or synthesize) the prompt body so RPC mode works even when the
  // command array omits {{Body}} (common for tau --mode rpc configs).
  let bodyArg: string | undefined;
  if (hasBodyTemplate) {
    const idx = rawCommand.findIndex((part) =>
      /\{\{Body(Stripped)?\}\}/.test(part),
    );
    const templatedIdx = idx >= 0 ? idx + prefixOffset : -1;
    if (templatedIdx >= 0 && templatedIdx < argv.length) {
      bodyArg = argv.splice(templatedIdx, 1)[0];
    }
  }
  if (!bodyArg) {
    bodyArg = templatingCtx.Body ?? templatingCtx.BodyStripped ?? "";
  }

  // Default body index is last arg after we append it below.
  let bodyIndex = Math.max(argv.length, 0);

  const bodyMarker = `__clawdis_body__${Math.random().toString(36).slice(2)}`;
  let sessionArgList: string[] = [];
  let insertSessionBeforeBody = true;

  // Session args prepared (templated) and injected generically
  if (reply.session) {
    const defaultSessionDir = path.join(os.homedir(), ".clawdis", "sessions");
    const sessionPath = path.join(defaultSessionDir, "{{SessionId}}.jsonl");
    const defaultSessionArgs = {
      newArgs: ["--session", sessionPath],
      resumeArgs: ["--session", sessionPath],
    };
    const defaultNew = defaultSessionArgs.newArgs;
    const defaultResume = defaultSessionArgs.resumeArgs;
    sessionArgList = (
      isNewSession
        ? (reply.session.sessionArgNew ?? defaultNew)
        : (reply.session.sessionArgResume ?? defaultResume)
    ).map((p) => applyTemplate(p, templatingCtx));

    // If we are writing session files, ensure the directory exists.
    const sessionFlagIndex = sessionArgList.indexOf("--session");
    const sessionPathArg =
      sessionFlagIndex >= 0 ? sessionArgList[sessionFlagIndex + 1] : undefined;
    if (sessionPathArg && !sessionPathArg.includes("://")) {
      const dir = path.dirname(sessionPathArg);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch {
        // best-effort
      }
    }

    // Tau (pi agent) needs --continue to reload prior messages when resuming.
    // Without it, pi starts from a blank state even though we pass the session file path.
    if (!isNewSession && !sessionArgList.includes("--continue")) {
      sessionArgList.push("--continue");
    }

    insertSessionBeforeBody = reply.session.sessionArgBeforeBody ?? true;
  }

  if (insertSessionBeforeBody && sessionArgList.length) {
    argv = [...argv, ...sessionArgList];
  }

  argv = [...argv, `${bodyMarker}${bodyArg}`];
  bodyIndex = argv.length - 1;

  if (!insertSessionBeforeBody && sessionArgList.length) {
    argv = [...argv, ...sessionArgList];
  }

  if (thinkLevel && thinkLevel !== "off") {
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
  }
  const builtArgv = agent.buildArgs({
    argv,
    bodyIndex,
    isNewSession,
    sessionId: templatingCtx.SessionId,
    sendSystemOnce,
    systemSent,
    identityPrefix: agentCfg.identityPrefix,
    format: agentCfg.format,
  });

  const promptIndex = builtArgv.findIndex(
    (arg) => typeof arg === "string" && arg.includes(bodyMarker),
  );
  const promptArg: string =
    promptIndex >= 0
      ? (builtArgv[promptIndex] as string).replace(bodyMarker, "")
      : ((builtArgv[builtArgv.length - 1] as string | undefined) ?? "");

  const finalArgv = builtArgv.map((arg, idx) => {
    if (idx === promptIndex && typeof arg === "string") return promptArg;
    return typeof arg === "string" ? arg.replace(bodyMarker, "") : arg;
  });

  // Drive pi via RPC stdin so auto-compaction and streaming run server-side.
  let rpcArgv = finalArgv;
  const bodyIdx =
    promptIndex >= 0 ? promptIndex : Math.max(finalArgv.length - 1, 0);
  rpcArgv = finalArgv.filter((_, idx) => idx !== bodyIdx);
  const modeIdx = rpcArgv.indexOf("--mode");
  if (modeIdx >= 0 && rpcArgv[modeIdx + 1]) {
    rpcArgv[modeIdx + 1] = "rpc";
  } else {
    rpcArgv.push("--mode", "rpc");
  }

  logVerbose(
    `Running command auto-reply: ${rpcArgv.join(" ")}${reply.cwd ? ` (cwd: ${reply.cwd})` : ""}`,
  );
  logger.info(
    {
      agent: agentKind,
      sessionId: templatingCtx.SessionId,
      newSession: isNewSession,
      cwd: reply.cwd,
      command: rpcArgv.slice(0, -1), // omit body to reduce noise
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
    let streamedAny = false;
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
      streamedAny = true;
      pendingToolName = undefined;
      pendingMetas = [];
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    };
    let lastStreamedAssistant: string | undefined;
    const streamAssistantFinal = (msg?: AssistantMessage) => {
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
      streamedAny = true;
    };

    const preferRpc = process.env.CLAWDIS_USE_PI_RPC === "1";

    const run = async () => {
      const runId = params.runId ?? crypto.randomUUID();
      let body = promptArg ?? "";
      if (!body || !body.trim()) {
        body = templatingCtx.Body ?? templatingCtx.BodyStripped ?? "";
      }
      if (!preferRpc) {
        const jsonArgv = (() => {
          const copy = [...finalArgv];
          const idx = copy.indexOf("--mode");
          if (idx >= 0 && copy[idx + 1]) copy[idx + 1] = "json";
          else copy.push("--mode", "json");
          return copy;
        })();
        logVerbose(
          `Running command auto-reply in json mode: ${jsonArgv.join(" ")}${reply.cwd ? ` (cwd: ${reply.cwd})` : ""}`,
        );
        return await runJsonFallback({
          argv: jsonArgv,
          cwd: reply.cwd,
          timeoutMs,
        });
      }

      const rpcPromptIndex =
        promptIndex >= 0 ? promptIndex : finalArgv.length - 1;
      logVerbose(
        `pi rpc prompt (${body.length} chars): ${body.slice(0, 200).replace(/\n/g, "\\n")}`,
      );
      // Build rpc args without the prompt body; force --mode rpc.
      const rpcArgvForRun = (() => {
        const copy = [...finalArgv];
        copy.splice(rpcPromptIndex, 1);
        const modeIdx = copy.indexOf("--mode");
        if (modeIdx >= 0 && copy[modeIdx + 1]) {
          copy.splice(modeIdx, 2, "--mode", "rpc");
        } else if (!copy.includes("--mode")) {
          copy.splice(copy.length - 1, 0, "--mode", "rpc");
        }
        return copy;
      })();
      type RpcStreamEvent =
        | AgentEvent
        // Tau sometimes emits a bare "message" frame; treat it like message_end for parsing.
        | { type: "message"; message: Message }
        | { type: "message_end"; message: Message };

      const rpcResult = await runPiRpc({
        argv: rpcArgvForRun,
        cwd: reply.cwd,
        prompt: body,
        timeoutMs,
        onEvent: (line: string) => {
          let ev: RpcStreamEvent;
          try {
            ev = JSON.parse(line) as RpcStreamEvent;
          } catch {
            return;
          }

          // Forward tool lifecycle events to the agent bus.
          if (ev.type === "tool_execution_start") {
            emitAgentEvent({
              runId,
              stream: "tool",
              data: {
                phase: "start",
                name: ev.toolName,
                toolCallId: ev.toolCallId,
                args: ev.args,
              },
            });
            params.onAgentEvent?.({
              stream: "tool",
              data: {
                phase: "start",
                name: ev.toolName,
                toolCallId: ev.toolCallId,
              },
            });
          }

          if (
            "message" in ev &&
            ev.message &&
            (ev.type === "message" || ev.type === "message_end")
          ) {
            const msg = ev.message as Message & {
              toolCallId?: string;
              tool_call_id?: string;
            };
            const role = (msg.role ?? "") as string;
            const isToolResult =
              role === "toolResult" || role === "tool_result";
            if (isToolResult && Array.isArray(msg.content)) {
              const toolName = inferToolName(msg);
              const toolCallId = msg.toolCallId ?? msg.tool_call_id;
              const meta =
                inferToolMeta(msg) ??
                (toolCallId ? toolMetaById.get(toolCallId) : undefined);

              emitAgentEvent({
                runId,
                stream: "tool",
                data: {
                  phase: "result",
                  name: toolName,
                  toolCallId,
                  meta,
                },
              });
              params.onAgentEvent?.({
                stream: "tool",
                data: {
                  phase: "result",
                  name: toolName,
                  toolCallId,
                  meta,
                },
              });

              if (pendingToolName && toolName && toolName !== pendingToolName) {
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
              return;
            }

            if (msg.role === "assistant") {
              streamAssistantFinal(msg as AssistantMessage);
            }
          }

          if (
            ev.type === "message_end" &&
            "message" in ev &&
            ev.message &&
            ev.message.role === "assistant"
          ) {
            streamAssistantFinal(ev.message as AssistantMessage);
            const text = extractRpcAssistantText(line);
            if (text) {
              params.onAgentEvent?.({
                stream: "assistant",
                data: { text },
              });
            }
          }

          // Preserve existing partial reply hook when provided.
          if (
            onPartialReply &&
            "message" in ev &&
            ev.message?.role === "assistant"
          ) {
            // Let the existing logic reuse the already-parsed message.
            try {
              streamAssistantFinal(ev.message as AssistantMessage);
            } catch {
              /* ignore */
            }
          }
        },
      });
      flushPendingTool();
      return rpcResult;
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
    let stdoutUsed = stdout;
    let stderrUsed = stderr;
    let codeUsed = code;
    let signalUsed = signal;
    let killedUsed = killed;
    let rpcAssistantText = extractRpcAssistantText(stdoutUsed);
    let rawStdout = stdoutUsed.trim();
    const _rpcUserEmpty =
      /"role":"user","content":\[\{"type":"text","text":""\}\]/.test(rawStdout);
    const anthropicNoMessages = rawStdout.includes(
      "messages: at least one message is required",
    );
    const shouldRetryJson =
      preferRpc && body.trim().length > 0 && anthropicNoMessages;
    if (shouldRetryJson) {
      const jsonArgv = (() => {
        const copy = [...finalArgv];
        const idx = copy.indexOf("--mode");
        if (idx >= 0 && copy[idx + 1]) copy[idx + 1] = "json";
        else copy.push("--mode", "json");
        return copy;
      })();
      logVerbose(
        `pi rpc returned empty user text; retrying with json mode: ${jsonArgv.join(" ")}`,
      );
      try {
        const fallback = await runJsonFallback({
          argv: jsonArgv,
          cwd: reply.cwd,
          timeoutMs,
        });
        stdoutUsed = fallback.stdout;
        stderrUsed = fallback.stderr;
        codeUsed = fallback.code;
        signalUsed = fallback.signal ?? null;
        killedUsed = fallback.killed;
        rpcAssistantText = extractRpcAssistantText(stdoutUsed);
        rawStdout = stdoutUsed.trim();
      } catch (err) {
        logVerbose(`json fallback failed: ${String(err)}`);
      }
    }
    let mediaFromCommand: string[] | undefined;
    const trimmed = stripRpcNoise(rawStdout);
    if (stderrUsed?.trim()) {
      logVerbose(`Command auto-reply stderr: ${stderrUsed.trim()}`);
    }

    const logFailure = () => {
      const truncate = (s?: string) =>
        s ? (s.length > 4000 ? `${s.slice(0, 4000)}…` : s) : undefined;
      logger.warn(
        {
          code: codeUsed,
          signal: signalUsed,
          killed: killedUsed,
          argv: finalArgv,
          cwd: reply.cwd,
          stdout: truncate(rawStdout),
          stderr: truncate(stderrUsed),
        },
        "command auto-reply failed",
      );
    };

    const parsed = trimmed ? agent.parseOutput(trimmed) : undefined;

    // Collect assistant texts and tool results from parseOutput (tau RPC can emit many).
    const parsedTexts =
      parsed?.texts?.map((t) => t.trim()).filter(Boolean) ?? [];
    const parsedToolResults = normalizeToolResults(parsed?.toolResults);
    const hasParsedContent =
      parsedTexts.length > 0 || parsedToolResults.length > 0;

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

    // If parser gave nothing, fall back to best-effort assistant text (prefers RPC deltas).
    const fallbackText =
      rpcAssistantText ??
      extractRpcAssistantText(trimmed) ??
      extractAssistantTextLoosely(trimmed) ??
      trimmed;
    const normalize = (s?: string) =>
      stripStructuralPrefixes((s ?? "").trim()).toLowerCase();
    const bodyNorm = normalize(
      templatingCtx.Body ?? templatingCtx.BodyStripped,
    );
    const fallbackNorm = normalize(fallbackText);
    const promptEcho =
      fallbackText &&
      (fallbackText === (templatingCtx.Body ?? "") ||
        fallbackText === (templatingCtx.BodyStripped ?? "") ||
        (bodyNorm.length > 0 && bodyNorm === fallbackNorm));
    const safeFallbackText = promptEcho ? undefined : fallbackText;

    if (replyItems.length === 0 && safeFallbackText && !hasParsedContent) {
      const { text: cleanedText, mediaUrls: mediaFound } =
        splitMediaFromOutput(safeFallbackText);
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
    if ((codeUsed ?? 0) !== 0) {
      logFailure();
      console.error(
        `Command auto-reply exited with code ${codeUsed ?? "unknown"} (signal: ${signalUsed ?? "none"})`,
      );
      // Include any partial output or stderr in error message
      const summarySource = rpcAssistantText ?? trimmed;
      const partialOut = summarySource
        ? `\n\nOutput: ${summarySource.slice(0, 500)}${summarySource.length > 500 ? "..." : ""}`
        : "";
      const errorText = `⚠️ Command exited with code ${codeUsed ?? "unknown"}${signalUsed ? ` (${signalUsed})` : ""}${partialOut}`;
      return {
        payloads: [{ text: errorText }],
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: codeUsed,
          signal: signalUsed,
          killed: killedUsed,
          agentMeta: parsed?.meta,
        },
      };
    }
    if (killedUsed && !signalUsed) {
      console.error(
        `Command auto-reply process killed before completion (exit code ${codeUsed ?? "unknown"})`,
      );
      const errorText = `⚠️ Command was killed before completion (exit code ${codeUsed ?? "unknown"})`;
      return {
        payloads: [{ text: errorText }],
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: codeUsed,
          signal: signalUsed,
          killed: killedUsed,
          agentMeta: parsed?.meta,
        },
      };
    }
    const meta: CommandReplyMeta = {
      durationMs: Date.now() - started,
      queuedMs,
      queuedAhead,
      exitCode: codeUsed,
      signal: signalUsed,
      killed: killedUsed,
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
    return { payloads: streamedAny && onPartialReply ? [] : payloads, meta };
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
      const partial =
        extractRpcAssistantText(errorObj.stdout ?? "") ||
        extractAssistantTextLoosely(errorObj.stdout ?? "") ||
        stripRpcNoise(errorObj.stdout ?? "");
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
