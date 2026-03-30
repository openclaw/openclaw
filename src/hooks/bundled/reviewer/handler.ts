/**
 * Reviewer Hook — GPT-5.4 post-turn quality gate.
 *
 * Fires on every message:sent event. When the agent finishes a turn and
 * delivers a response, this hook calls GPT-5.4 to evaluate the response.
 * If approved, reacts with :approved_by_fractal_reviewer:.
 * If continuation is needed, injects feedback via the reviewer dispatch
 * mechanism (bypassing Slack's self-message limitation).
 *
 * No debounce — fires immediately on the last message:sent of each dispatch.
 * The internal hook only fires ONCE per dispatch cycle (after all block
 * replies are delivered), so there's no need to debounce.
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import type { InternalHookEvent, MessageSentHookContext } from "../../internal-hooks.js";

const log = createSubsystemLogger("hooks/reviewer");

// ── Types ───────────────────────────────────────────────────────────

interface ReviewerConfig {
  enabled?: boolean;
  model?: string;
  maxIterations?: number;
  approveEmoji?: string;
  systemPromptPath?: string;
}

interface ReviewResult {
  action: "approve" | "continue";
  message?: string;
  confidence?: number;
  suggestions?: string;
}

// ── State ───────────────────────────────────────────────────────────

const iterationCounts = new Map<string, number>();
const activeReviews = new Set<string>();

// ── Default system prompt ───────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `# Reviewer — Quality Gate for Opus

You are a senior quality reviewer for an AI assistant (Opus, claude-opus-4-6).
You review the assistant's ENTIRE turn in a Slack thread after it finishes.

## Your Job
Evaluate whether Opus:
1. Actually DID what was asked (not just described it)
2. Used tools correctly and verified results
3. Addressed ALL parts of the user's request
4. Made accurate claims supported by evidence

## Response Format
Respond with a valid JSON object. No other text.

APPROVED (target ~90% of reviews):
{"action":"approve","message":"","confidence":0.95}

CONTINUE (only for genuine gaps):
{"action":"continue","message":"Specific actionable feedback here","confidence":0.8}

## Guidelines
- Be constructive: state what's MISSING, not what's wrong
- Never nitpick formatting, tone, or style
- If the user seems satisfied, approve
- Tool errors that the agent already handled → approve
- Claims without evidence → flag
- Incomplete task execution → flag
- The TOOL ACTIVITY section only contains calls from the CURRENT agent turn. Previous turns' tool calls are not included.`;

// ── Helpers ─────────────────────────────────────────────────────────

function resolveReviewerConfig(cfg: OpenClawConfig): ReviewerConfig | undefined {
  // Read from hooks.internal.entries.reviewer config
  const hooksCfg = resolveHookConfig(cfg, "reviewer") as ReviewerConfig | undefined;
  if (!hooksCfg?.enabled) {
    return undefined;
  }
  return hooksCfg;
}

function loadSystemPrompt(config: ReviewerConfig, workspaceDir?: string): string {
  if (config.systemPromptPath && workspaceDir) {
    const promptPath = path.isAbsolute(config.systemPromptPath)
      ? config.systemPromptPath
      : path.join(workspaceDir, config.systemPromptPath);
    try {
      return fs.readFileSync(promptPath, "utf-8").trim();
    } catch {
      log.warn(`Failed to load reviewer prompt from ${promptPath}, using default`);
    }
  }
  return DEFAULT_SYSTEM_PROMPT;
}

function resolveOpenAIApiKey(): string | undefined {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  // Try loading from common env files
  const os = require("node:os");
  const envPaths = [
    path.join(os.homedir(), ".hermes", ".env"),
    path.join(os.homedir(), ".openclaw-test", ".env"),
    path.join(os.homedir(), ".openclaw", ".env"),
  ];
  for (const envPath of envPaths) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("OPENAI_API_KEY=")) {
          const val = trimmed
            .slice("OPENAI_API_KEY=".length)
            .trim()
            .replace(/^["']|["']$/g, "");
          if (val) {
            process.env.OPENAI_API_KEY = val;
            return val;
          }
        }
      }
    } catch {}
  }
  return undefined;
}

function resolveLangfuseConfig():
  | { secretKey: string; publicKey: string; baseUrl: string }
  | undefined {
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://us.cloud.langfuse.com";
  if (!secretKey || !publicKey) {
    return undefined;
  }
  return { secretKey, publicKey, baseUrl };
}

function sendLangfuseTrace(params: {
  langfuse: { secretKey: string; publicKey: string; baseUrl: string };
  traceId: string;
  model: string;
  input: Array<{ role: string; content: string }>;
  output: string;
  usage: { input?: number; output?: number };
  threadTs: string;
  channelId?: string;
  action: string;
  iteration?: number;
  threadMessageCount?: number;
}): void {
  const {
    langfuse,
    traceId,
    model,
    input,
    output,
    usage,
    threadTs,
    channelId,
    action,
    iteration,
    threadMessageCount,
  } = params;
  const auth = Buffer.from(`${langfuse.publicKey}:${langfuse.secretKey}`).toString("base64");
  const now = new Date().toISOString();
  // sessionId groups all reviews for the same Slack thread in Langfuse
  const sessionId = `thread-${threadTs}`;
  const tags = ["reviewer", action, ...(channelId ? [`ch:${channelId}`] : [])];
  const body = {
    batch: [
      {
        id: `${traceId}-trace`,
        type: "trace-create",
        timestamp: now,
        body: {
          id: traceId,
          name: "reviewer",
          sessionId,
          tags,
          input,
          output: { action, message: output },
          metadata: { threadTs, channelId, action, model, iteration, threadMessageCount },
        },
      },
      {
        id: `${traceId}-gen`,
        type: "generation-create",
        timestamp: now,
        body: {
          id: `${traceId}-gen`,
          traceId,
          name: "review-call",
          model,
          startTime: now,
          endTime: now,
          input,
          output,
          usage: { input: usage.input, output: usage.output, unit: "TOKENS" },
          metadata: { threadTs, channelId, action, iteration, threadMessageCount },
        },
      },
    ],
  };
  fetch(`${langfuse.baseUrl}/api/public/ingestion`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => log.warn(`langfuse trace failed: ${String(err)}`));
}

// ── Tool call extraction from session JSONL ──────────────────────────

function extractToolCallsFromSession(
  stateDir: string,
  threadTs: string,
  sessionKey?: string,
): string[] {
  try {
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    const candidates = files
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .toSorted((a, b) => b.mtime - a.mtime)
      .slice(0, 10);

    // Also resolve session file from sessions.json if we have a sessionKey
    let sessionFileFromIndex: string | undefined;
    if (sessionKey) {
      try {
        const indexPath = path.join(sessionsDir, "sessions.json");
        const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        const sessions = index.sessions ?? index;
        if (Array.isArray(sessions)) {
          for (const s of sessions) {
            if (s.key === sessionKey || s.sessionKey === sessionKey) {
              sessionFileFromIndex = s.sessionFile ?? s.file;
              break;
            }
          }
        }
      } catch {}
    }

    const entries: string[] = [];

    const extractFromFile = (filePath: string): boolean => {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "message") {
            continue;
          }
          const msg = entry.message;
          const role = msg?.role ?? "";
          const blocks = msg?.content;

          // Extract tool calls (assistant role)
          if (role === "assistant" && Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block?.type !== "toolCall") {
                continue;
              }
              const toolName = block.name ?? "";
              const _toolId = block.id ?? "";
              const args = block.arguments ?? {};
              let callStr = "";
              if (toolName === "exec") {
                callStr = `[CALL exec]: ${(args.command ?? "").slice(0, 300)}`;
              } else if (toolName === "memory_search") {
                callStr = `[CALL memory_search]: query="${args.query ?? ""}"`;
              } else if (toolName === "read") {
                callStr = `[CALL read]: ${args.path ?? args.file_path ?? ""}`;
              } else if (toolName === "write") {
                callStr = `[CALL write]: ${args.path ?? ""} (${(args.content ?? "").length} chars)`;
              } else if (toolName === "message") {
                continue; // Skip — Slack messages are already in thread
              } else {
                callStr = `[CALL ${toolName}]: ${JSON.stringify(args).slice(0, 200)}`;
              }
              entries.push(callStr);
            }
          }

          // Extract tool results (toolResult role)
          if (role === "toolResult") {
            let resultText = "";
            if (Array.isArray(blocks)) {
              for (const block of blocks) {
                if (block?.type === "text") {
                  resultText += block.text ?? "";
                }
              }
            } else if (typeof blocks === "string") {
              resultText = blocks;
            }
            if (resultText) {
              const truncated =
                resultText.length > 500
                  ? resultText.slice(0, 500) + `... (${resultText.length} chars total)`
                  : resultText;
              entries.push(`[RESULT]: ${truncated}`);
            }
          }
        } catch {}
      }
      return entries.length > 0;
    };

    // Strategy 1: Find session matching threadTs (thread-level sessions)
    for (const { name } of candidates) {
      const filePath = path.join(sessionsDir, name);
      const isTopicMatch = name.includes(threadTs.replace(".", ""));
      if (isTopicMatch) {
        if (extractFromFile(filePath)) {
          return entries;
        }
      }
    }

    // Strategy 2: Search file content for threadTs
    for (const { name } of candidates) {
      const filePath = path.join(sessionsDir, name);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        if (content.includes(threadTs) && extractFromFile(filePath)) {
          return entries;
        }
      } catch {}
    }

    // Strategy 3: Use the session file from sessions.json index (channel-level session)
    if (sessionFileFromIndex) {
      const resolvedPath = sessionFileFromIndex.startsWith("/")
        ? sessionFileFromIndex
        : path.join(sessionsDir, sessionFileFromIndex);
      try {
        if (fs.existsSync(resolvedPath) && extractFromFile(resolvedPath)) {
          return entries;
        }
      } catch {}
    }

    // Strategy 4: Fall back to most recent active session (likely the one that just finished)
    if (entries.length === 0 && candidates.length > 0) {
      const mostRecent = path.join(sessionsDir, candidates[0].name);
      extractFromFile(mostRecent);
    }

    return entries;
  } catch (err) {
    log.warn(`extractToolCalls failed: ${String(err)}`);
    return [];
  }
}

// ── Hindsight memory pre-fetch ──────────────────────────────────────

async function queryHindsight(query: string): Promise<string[]> {
  try {
    const body = JSON.stringify({
      query,
      budget: "high",
      limit: 5,
    });
    const res = await fetch("http://localhost:8888/v1/default/banks/openclaw/memories/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log.warn(`Hindsight recall returned ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { results?: Array<{ text?: string; memory?: string }> };
    const results = data.results ?? [];
    return results
      .filter((r) => r.text || r.memory)
      .slice(0, 5)
      .map((r) => ((r.text ?? r.memory) as string).slice(0, 300));
  } catch (err) {
    log.warn(`Hindsight query failed: ${String(err)}`);
    return [];
  }
}

async function callReviewer(params: {
  model: string;
  systemPrompt: string;
  threadMessages: Array<{ role: string; text: string }>;
  threadTs: string;
  channelId?: string;
  iteration?: number;
  toolCalls?: string[];
  memories?: string[];
}): Promise<ReviewResult> {
  const apiKey = resolveOpenAIApiKey();
  if (!apiKey) {
    log.warn("No OpenAI API key found — auto-approving");
    return { action: "approve", message: "", confidence: 1.0 };
  }
  // Dynamic import to avoid bundling openai in the main gateway
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  // Send the FULL thread — no truncation. GPT-5.4 has 128k context, use it.
  const transcript = params.threadMessages.map((m) => `[${m.role}]: ${m.text}`).join("\n\n");

  // Build tool activity section if available (calls + results paired)
  let toolSection = "";
  if (params.toolCalls && params.toolCalls.length > 0) {
    // Keep last 80 entries (calls + results) to give reviewer full visibility
    const recentTools = params.toolCalls.slice(-80);
    toolSection = `\n\n--- AGENT TOOL ACTIVITY (behind-the-scenes commands and their results) ---\n${recentTools.join("\n")}\n--- END TOOL ACTIVITY ---`;
  }

  // Build memory section from Hindsight pre-fetch
  let memorySection = "";
  if (params.memories && params.memories.length > 0) {
    memorySection = `\n\n--- RELEVANT MEMORIES (retrieved from Hindsight semantic memory) ---
These are past learnings, rules, and observations that Opus saved during previous work. They were retrieved by searching for topics related to this thread. Use them to evaluate whether Opus is following known rules, repeating past mistakes, or missing context it should already have.
${params.memories.map((m, i) => `${i + 1}. ${m}`).join("\n")}
--- END MEMORIES ---`;
  }

  const userContent = `Review this conversation thread. The assistant is Opus.\n\n--- THREAD ---\n${transcript}\n--- END ---${toolSection}${memorySection}\n\nEvaluate the assistant's last response. Respond with JSON only.`;
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: userContent },
  ];

  const response = await client.chat.completions.create({
    model: params.model,
    messages,
    temperature: 0.3,
    max_completion_tokens: 1000,
    response_format: { type: "json_object" },
  });

  const rawOutput = response.choices[0]?.message?.content ?? "{}";
  let result: ReviewResult;
  try {
    result = JSON.parse(rawOutput) as ReviewResult;
  } catch {
    result = { action: "approve", message: "", confidence: 1.0 };
  }

  // Fire-and-forget Langfuse trace
  const langfuse = resolveLangfuseConfig();
  if (langfuse) {
    const traceId = `reviewer-${params.threadTs}-${Date.now()}`;
    sendLangfuseTrace({
      langfuse,
      traceId,
      model: params.model,
      input: messages,
      output: rawOutput,
      usage: {
        input: response.usage?.prompt_tokens,
        output: response.usage?.completion_tokens,
      },
      threadTs: params.threadTs,
      channelId: params.channelId,
      action: result.action,
      iteration: params.iteration,
      threadMessageCount: params.threadMessages.length,
    });
    log.info(`langfuse trace sent: ${traceId}`);
  } else {
    log.warn("no langfuse config — skipping trace");
  }

  return result;
}

async function fetchSlackThread(
  token: string,
  channelId: string,
  threadTs: string,
  botUserId?: string,
): Promise<Array<{ role: string; text: string; ts?: string }>> {
  const allMessages: Array<{ user?: string; text?: string; ts?: string }> = [];
  let cursor: string | undefined;

  // Paginate to get ALL messages (Slack returns oldest-first, max 200 per page)
  do {
    const params = new URLSearchParams({ channel: channelId, ts: threadTs, limit: "200" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const res = await fetch(`https://slack.com/api/conversations.replies?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as {
      ok?: boolean;
      messages?: Array<{ user?: string; text?: string; ts?: string }>;
      error?: string;
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) {
      log.warn(`conversations.replies failed: ${data.error ?? "unknown"}`);
      break;
    }
    allMessages.push(...(data.messages ?? []));
    cursor = data.has_more ? data.response_metadata?.next_cursor : undefined;
  } while (cursor);

  log.info(`fetchSlackThread: ${allMessages.length} messages fetched (paginated)`);
  return allMessages.map((m) => ({
    role: m.user === botUserId ? "Assistant" : `User (${m.user ?? "unknown"})`,
    text: m.text ?? "(no text)",
    ts: m.ts,
  }));
}

async function slackReact(
  token: string,
  channelId: string,
  ts: string,
  emoji: string,
): Promise<void> {
  try {
    const res = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId, timestamp: ts, name: emoji }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!data.ok) {
      log.warn(`reactions.add failed for :${emoji}: on ${ts}: ${data.error ?? "unknown"}`);
      // If custom emoji doesn't exist, fall back to a standard one
      if (data.error === "invalid_name") {
        await fetch("https://slack.com/api/reactions.add", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ channel: channelId, timestamp: ts, name: "white_check_mark" }),
        });
      }
    } else {
      log.info(`reaction :${emoji}: added to ${ts}`);
    }
  } catch (err) {
    log.warn(`slackReact error: ${String(err)}`);
  }
}

async function slackPost(
  token: string,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: channelId, thread_ts: threadTs, text }),
  });
}

// ── Handler ─────────────────────────────────────────────────────────

const handler: HookHandler = async (event: InternalHookEvent) => {
  if (event.type !== "message" || event.action !== "sent") {
    return;
  }

  const ctx = event.context as Partial<MessageSentHookContext> & Record<string, unknown>;
  log.info(
    `handler called: type=${event.type} action=${event.action} hasCfg=${!!ctx.cfg} channelId=${ctx.channelId ?? "-"} sessionKey=${event.sessionKey ?? "-"}`,
  );

  // Load config from context or fall back to disk
  let cfg = ctx.cfg as OpenClawConfig | undefined;
  if (!cfg) {
    try {
      const stateDir =
        process.env.OPENCLAW_STATE_DIR ?? path.join(require("node:os").homedir(), ".openclaw");
      const cfgPath = path.join(stateDir, "openclaw.json");
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as OpenClawConfig;
      log.info("loaded config from disk (event context had no cfg)");
    } catch (err) {
      log.warn(
        `no config in event context and failed to load from disk: ${String(err)} — skipping review`,
      );
      return;
    }
  }

  // Extract channelId from context or parse from sessionKey
  if (!ctx.channelId || ctx.channelId === "slack") {
    // Parse channelId from sessionKey: "agent:main:slack:channel:c0ahskbndb6:thread:..."
    const sk = event.sessionKey ?? "";
    const channelMatch = sk.match(/channel:(c[a-z0-9]+)/i);
    if (channelMatch) {
      ctx.channelId = channelMatch[1].toUpperCase();
      log.info(`resolved channelId from sessionKey: ${ctx.channelId}`);
    }
  }

  // Extract conversationId (threadTs) from sessionKey if missing
  if (!ctx.conversationId) {
    const sk = event.sessionKey ?? "";
    const threadMatch = sk.match(/thread:(\d+\.\d+)/);
    if (threadMatch) {
      ctx.conversationId = threadMatch[1];
      log.info(`resolved conversationId from sessionKey: ${ctx.conversationId}`);
    }
  }

  const reviewerConfig = resolveReviewerConfig(cfg);
  log.info(`reviewerConfig: ${reviewerConfig ? JSON.stringify(reviewerConfig) : "null"}`);
  if (!reviewerConfig) {
    return;
  }
  if (ctx.success === false) {
    return;
  }

  const channelId = ctx.channelId;
  const threadTs = ctx.conversationId;
  if (!channelId || !threadTs) {
    return;
  }

  const sessionKey = event.sessionKey;
  if (activeReviews.has(sessionKey)) {
    return;
  }

  // Check iteration limit
  const maxIterations = reviewerConfig.maxIterations ?? 3;
  const count = iterationCounts.get(threadTs) ?? 0;
  if (count >= maxIterations) {
    log.info(`max iterations (${maxIterations}) reached for thread ${threadTs} — auto-approving`);
    iterationCounts.delete(threadTs);
    return;
  }

  activeReviews.add(sessionKey);
  log.info(
    `starting review: session=${sessionKey} channel=${channelId} thread=${threadTs} iteration=${count + 1}/${maxIterations}`,
  );

  try {
    // Read Slack token from config
    const slackConfig = (cfg as Record<string, unknown>).channels as
      | Record<string, unknown>
      | undefined;
    const slackCfg = slackConfig?.slack as Record<string, unknown> | undefined;
    const botToken = slackCfg?.botToken as string | undefined;
    if (!botToken) {
      log.warn("No Slack bot token found in config — skipping review");
      return;
    }
    log.info(`bot token found, fetching thread...`);

    // Resolve bot user ID for role assignment
    const botUserId = ctx.botUserId as string | undefined;

    // Get workspace dir for system prompt loading
    const agentDefaults = (
      (cfg as Record<string, unknown>).agents as Record<string, unknown> | undefined
    )?.defaults as Record<string, unknown> | undefined;
    const workspaceDir = agentDefaults?.workspace as string | undefined;

    const systemPrompt = loadSystemPrompt(reviewerConfig, workspaceDir);
    const model = reviewerConfig.model ?? "gpt-5.4";

    // Fetch thread, extract tool calls, and query Hindsight in parallel
    const stateDir =
      process.env.OPENCLAW_STATE_DIR ?? path.join(require("node:os").homedir(), ".openclaw");
    const [threadMessages, toolCalls] = await Promise.all([
      fetchSlackThread(botToken, channelId, threadTs, botUserId),
      Promise.resolve(extractToolCallsFromSession(stateDir, threadTs, sessionKey)),
    ]);
    log.info(
      `thread fetched: ${threadMessages.length} messages, ${toolCalls.length} tool calls, calling ${model}...`,
    );
    if (threadMessages.length === 0) {
      return;
    }

    // Pre-fetch relevant memories from Hindsight based on recent human messages
    const humanMessages = threadMessages
      .filter((m) => !m.role.startsWith("Assistant"))
      .slice(-3)
      .map((m) => m.text)
      .join(" ")
      .slice(0, 200);
    const memories = humanMessages ? await queryHindsight(humanMessages) : [];
    log.info(
      `hindsight pre-fetch: ${memories.length} memories for query "${humanMessages.slice(0, 60)}..."`,
    );

    const result = await callReviewer({
      model,
      systemPrompt,
      threadMessages,
      threadTs,
      channelId,
      iteration: count + 1,
      toolCalls,
      memories,
    });
    const action = result.action ?? "approve";

    log.info(
      `thread=${threadTs} action=${action} confidence=${result.confidence ?? "-"} iteration=${count + 1}`,
    );

    if (action === "continue" && result.message) {
      iterationCounts.set(threadTs, count + 1);

      let feedbackText = `🔍 *Reviewer:* ${result.message}`;
      if (result.suggestions) {
        feedbackText += `\n\n_Suggestions from reviewer: ${result.suggestions}_`;
      }

      // Post feedback to Slack for visibility
      await slackPost(botToken, channelId, threadTs, feedbackText);

      // Inject feedback via internal dispatch (bypasses Slack self-message limitation).
      // The dispatch function is registered on globalThis by the Slack provider at startup.
      const dispatchKey = Symbol.for("openclaw.reviewerDispatch");
      const dispatchFn = (
        globalThis as Record<
          symbol,
          | ((p: { channelId: string; threadTs: string; text: string }) => Promise<boolean>)
          | undefined
        >
      )[dispatchKey];
      if (dispatchFn) {
        const dispatched = await dispatchFn({ channelId, threadTs, text: feedbackText });
        log.info(`internal dispatch: ${dispatched ? "ok" : "failed"}`);
      } else {
        log.warn("no reviewer dispatch function registered — feedback posted to Slack only");
      }
    } else {
      // Approved — react and clear iteration counter
      iterationCounts.delete(threadTs);
      const emoji = reviewerConfig.approveEmoji ?? "approved_by_fractal_reviewer";

      // Prefer messageId from hook context; fall back to the last bot message ts
      const lastBotMsg = threadMessages.filter((m) => m.role === "Assistant").pop();
      const reactTs = ctx.messageId ?? lastBotMsg?.ts;
      if (reactTs) {
        await slackReact(botToken, channelId, reactTs, emoji);
      } else {
        log.warn("no message ts available for approval reaction — skipping react");
      }

      // Post suggestions even on approve (non-blocking improvement feedback)
      if (result.suggestions) {
        await slackPost(
          botToken,
          channelId,
          threadTs,
          `💡 _Suggestions from reviewer: ${result.suggestions}_`,
        );
      }
    }
  } catch (err) {
    log.error(`review failed: ${String(err)}`);
  } finally {
    activeReviews.delete(sessionKey);
  }
};

export default handler;
