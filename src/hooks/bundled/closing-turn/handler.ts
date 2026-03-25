/**
 * Closing Turn Hook Handler
 *
 * Runs a silent agent turn on the previous session's transcript when /new or
 * /reset is issued. The agent reviews the conversation and updates workspace
 * files (memory logs, tasks, project status).
 *
 * Blocking: the handler awaits the closing turn before returning, so the new
 * session is not created until the closing turn completes.
 *
 * Cache strategy: the closing turn passes the originating session key to
 * agentCommand so the system prompt assembler produces the same tool policy,
 * channel context, and reaction guidance as the previous session. This makes
 * the system prompt byte-identical, enabling Anthropic prompt-cache hits
 * (5-minute TTL). The explicit sessionFile still controls transcript I/O,
 * so closing-turn messages go to the archived file, not the live session.
 *
 * Progress messages are sent directly via routeReply so they arrive before
 * the closing turn begins, giving the user visible feedback during the wait.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AGENT_LANE_SUBAGENT } from "../../../agents/lanes.js";
import { loadModelCatalog } from "../../../agents/model-catalog.js";
import { resolveReasoningDefault } from "../../../agents/model-selection.js";
import { buildInboundMetaSystemPrompt } from "../../../auto-reply/reply/inbound-meta.js";
import { routeReply } from "../../../auto-reply/reply/route-reply.js";
import { agentCommand } from "../../../commands/agent.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStorePath, updateSessionStore } from "../../../config/sessions.js";
import type { SessionEntry } from "../../../config/sessions.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";

const execFileAsync = promisify(execFile);
const log = createSubsystemLogger("hooks/closing-turn");

// ---- Closing turn prompt ----

const DEFAULT_CLOSING_PROMPT = `\
You are running in a silent closing turn after a session reset.
- Do NOT send any messages to the user.
- Do NOT use deliver or message tools.
- Your only job is to update workspace files as instructed.
- This run will not be seen by anyone — write files and exit.

This is the end of a session. Review the full conversation transcript above and perform the session close checklist.

## 1. Daily Memory Log — memory/YYYY-MM-DD.md (today's date)

Append a session summary. This is the PRIMARY output — future sessions find context by searching these logs.

Structure your summary with these sections (include only those with real content):

### Decisions & Reasoning
What was decided, WHO decided it (Eric vs Atlas vs joint), and WHY. The reasoning is the most important part.
Example: "Eric decided to file a new LLC rather than revive Elysian Verge — revival carries $500-1500+ in back fees, new filing is $150 with a clean slate."

### Actions Completed
External actions with real-world effects: emails sent (to whom, about what), files deployed, services configured. Include specifics.
Skip: routine debugging, file edits, tool output, internal workspace changes.

### Open Questions
Only unresolved questions that are BLOCKING or TIME-SENSITIVE. Skip idle curiosity.

**Memory Writing Standards (critical for retrieval):**
- Include proper nouns: people (Kate, Brandon, Will), companies (Sun Collectors, Scanifly), tools (GOG, Lobster, task-db.py)
- Include domain tags: solar, photography, trivia-app, SurveyFlow, openclaw-fork, infrastructure
- Include the WHY, not just the WHAT
- No pronouns without antecedents: "Fixed the issue" → "Fixed GOG keyring auth blocking Kate email delivery from dreamhouse client"
- Each entry must be findable by at least 3 different search queries
- After each bullet, append an importance score: [importance:N] where N is 1-10 (9-10 = critical instruction, 7-8 = prevents mistakes, 5-6 = notable, 3-4 = routine, 1-2 = discard)
- Most items should score 3-6. Reserve 7+ for things that PREVENT REAL ERRORS.
- If the session was purely routine (status checks, small talk), write "No significant changes this session." and move on.
- Total summary: 200-500 words. Quality over quantity.

## 2. PROJECTS.md
Update any project that changed status, milestone, or next step during this session.

## 3. MEMORY.md
Add new decisions or lessons learned ONLY if they have ongoing behavioral impact (importance 8+). Keep the file under 120 lines total. Most things belong in the daily log, not here.

## 4. Tasks
- Run \`task-db.py list --status pending\` FIRST to see existing tasks.
- Run \`task-db.py add\` only for genuinely open threads that need future work AND do not already exist in the task list.
- Run \`task-db.py done <id>\` for items completed in this session.
- Do NOT create tasks for work that was already done in this session.
- Do NOT create tasks that duplicate existing pending tasks.
- Do NOT create tasks from meta-instructions about updating docs or validating features that were part of this session's own workflow.

## 5. TOOLS.md
Update if any new tool, service, or infrastructure was set up or changed.

Be concise. Only write what genuinely changed. Do not repeat information already in these files.

## 6. Session Summary Line
Write a single line (max 80 chars, no markdown) to memory/.last-session-summary in the workspace root.
Format: "[domain] — outcome 1, outcome 2, outcome 3"
Examples:
  "[photography] Pass 1+2 shipped, mark-paid fixed, 9 OQs closed"
  "[trivia-app] reveal mode shipped, beta scope locked"
  "[infrastructure] closing-turn summary line added"
  "[routine] status check, no significant changes"
Use the most specific domain tag that covers the session (photography, trivia-app, surveyflow, solar, openclaw-fork, infrastructure, routine).
If multiple domains, pick the dominant one. This line appears verbatim in the session-saved notification.

## 7. Completion Sentinel (FINAL STEP — do this last)
Append the sentinel comment from the context preamble to the daily memory log file (same file as Section 1).
This must be your absolute last write operation. Other automated systems use its presence as a
reliable signal that the closing turn completed all steps successfully. If it appears before tasks
are created or other sections are done, those systems will incorrectly skip fallback processing.
Do NOT write it earlier (e.g. at the end of Section 1). Append it only after Section 6 is done.`;

// ---- Session file resolution ----

/**
 * Find the previous session's transcript file, handling the case where
 * the file has been renamed with a .reset.* suffix during archival.
 */
function findSessionFile(params: {
  sessionFile?: string;
  sessionId?: string;
  storePath?: string;
}): string | undefined {
  const { sessionFile, sessionId } = params;

  // Try the direct path first
  if (sessionFile && fs.existsSync(sessionFile)) {
    return sessionFile;
  }

  // If the file has been archived (renamed to .reset.*), find it
  if (sessionId) {
    const searchDirs: string[] = [];
    if (sessionFile) {
      searchDirs.push(path.dirname(sessionFile));
    }
    if (params.storePath) {
      searchDirs.push(params.storePath);
    }

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) {
        continue;
      }
      try {
        const files = fs.readdirSync(dir);
        const match = files.find((f) => f.startsWith(sessionId) && f.includes(".jsonl"));
        if (match) {
          const fullPath = path.join(dir, match);
          if (fs.existsSync(fullPath)) {
            return fullPath;
          }
        }
      } catch {
        // Directory read failed — continue
      }
    }
  }

  return undefined;
}

/**
 * Resolve the sessions store path (sessions.json file) from config.
 * Delegates to the canonical resolveStorePath from config/sessions to ensure
 * the path is always a file path (e.g. sessions/sessions.json), not a directory.
 */
function resolveStoreFilePath(cfg?: OpenClawConfig, agentId?: string): string | undefined {
  const store = cfg?.session?.store;
  return resolveStorePath(typeof store === "string" && store.trim() ? store : undefined, {
    agentId: agentId || "main",
  });
}

// ---- Portfolio pulse ----

/**
 * Build a brief programmatic status block from task-db.py and photo-db.py.
 * Zero tokens — pure shell output. Falls back gracefully if tools are unavailable.
 */
async function buildPortfolioPulse(workspaceDir: string): Promise<string | undefined> {
  const python = "python3";
  const taskTool = path.join(workspaceDir, "tools", "task-db.py");
  const photoTool = path.join(workspaceDir, "tools", "photo-db.py");

  const lines: string[] = ["📊 *Portfolio pulse:*"];

  try {
    // Tasks: overdue + due-soon counts
    const { stdout: taskOut } = await execFileAsync(python, [taskTool, "triage", "--compact"], {
      timeout: 5000,
      cwd: workspaceDir,
    });
    const triage = JSON.parse(taskOut.trim()) as {
      counts?: { overdue?: number; due_soon?: number };
      overdue?: Array<{ title: string }>;
      due_soon?: Array<{ title: string }>;
    };
    const overdue = triage.counts?.overdue ?? triage.overdue?.length ?? 0;
    const dueSoon = triage.counts?.due_soon ?? triage.due_soon?.length ?? 0;
    const overdueLabel = overdue === 1 ? "task" : "tasks";
    const dueSoonLabel = dueSoon === 1 ? "task" : "tasks";
    if (overdue > 0) {
      lines.push(`• 🔴 ${overdue} overdue ${overdueLabel}`);
      for (const t of (triage.overdue ?? []).slice(0, 2)) {
        lines.push(`  – ${t.title}`);
      }
    }
    if (dueSoon > 0) {
      lines.push(`• 🟡 ${dueSoon} ${dueSoonLabel} due this week`);
    }
    if (overdue === 0 && dueSoon === 0) {
      lines.push("• ✅ No overdue or upcoming tasks");
    }
  } catch {
    // task-db unavailable — skip
  }

  try {
    // Photography: active jobs + unpaid invoices
    const { stdout: photoOut } = await execFileAsync(python, [photoTool, "summary"], {
      timeout: 5000,
      cwd: workspaceDir,
    });
    const photo = JSON.parse(photoOut.trim()) as {
      active_job_count?: number;
      unpaid_invoice_count?: number;
      total_outstanding?: number;
    };
    const jobs = photo.active_job_count ?? 0;
    const unpaid = photo.unpaid_invoice_count ?? 0;
    const outstanding = photo.total_outstanding ?? 0;
    const jobLabel = jobs === 1 ? "job" : "jobs";
    if (jobs > 0 || unpaid > 0) {
      const parts: string[] = [`${jobs} active ${jobLabel}`];
      if (unpaid > 0) {
        parts.push(`${unpaid} unpaid invoice ($${outstanding.toFixed(0)})`);
      }
      lines.push(`• 📷 Photography: ${parts.join(", ")}`);
    }
  } catch {
    // photo-db unavailable — skip
  }

  // Only return if we have something beyond the header
  return lines.length > 1 ? lines.join("\n") : undefined;
}

// ---- Delivery helper ----

/** Delay helper (ms). */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Parse channel + to from a session key and send a message directly.
 * Returns false if the session key can't be parsed or send fails.
 *
 * Checks routeReply's ok field (routeReply never throws — it returns
 * { ok: false } on failure). On first failure, retries once after a
 * short delay to ride out transient network blips (e.g. IPv6→IPv4
 * fallback in the Telegram fetch dispatcher).
 */
async function sendDirect(params: {
  text: string;
  sessionKey: string;
  cfg: OpenClawConfig;
}): Promise<boolean> {
  try {
    const parsed = parseAgentSessionKey(params.sessionKey);
    const parts = parsed?.rest?.split(":").filter(Boolean) ?? [];
    const channel = parts[0];
    const to = parts[parts.length - 1];
    if (!channel || !to) {
      return false;
    }

    const send = () =>
      routeReply({
        payload: { text: params.text },
        channel: channel as Parameters<typeof routeReply>[0]["channel"],
        to,
        sessionKey: params.sessionKey,
        cfg: params.cfg,
      });

    const result = await send();
    if (result.ok) {
      return true;
    }

    // First attempt failed — retry once after a short delay.
    // The Telegram fetch dispatcher may need a moment to settle on IPv4
    // after an IPv6 timeout triggers the sticky fallback.
    log.warn(`sendDirect failed (will retry): ${result.error ?? "unknown"}`);
    await sleep(1500);

    const retry = await send();
    if (retry.ok) {
      log.info("sendDirect retry succeeded");
      return true;
    }

    log.warn(`sendDirect retry also failed: ${retry.error ?? "unknown"}`);
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`sendDirect threw: ${message}`);
    return false;
  }
}

// ---- Main closing turn runner ----

async function runClosingTurn(params: {
  sessionFile: string;
  oldSessionId: string;
  agentId: string;
  timeoutSeconds: number;
  prompt: string;
  sessionKey: string;
  completionMessage?: string;
  workspaceDir?: string;
  previousSessionEntry?: Partial<SessionEntry>;
  cfg: OpenClawConfig;
}): Promise<void> {
  const {
    sessionFile,
    oldSessionId,
    agentId,
    timeoutSeconds,
    prompt,
    sessionKey,
    completionMessage,
    workspaceDir,
    previousSessionEntry,
    cfg,
  } = params;
  const timeoutMs = timeoutSeconds * 1000;

  // ── 1. Send immediate progress message ──────────────────────────────────
  await sendDirect({ text: "⏳ Saving session context...", sessionKey, cfg });

  // ── 2. Send portfolio pulse (zero-token, programmatic) ──────────────────
  if (workspaceDir) {
    try {
      const pulse = await buildPortfolioPulse(workspaceDir);
      if (pulse) {
        await sendDirect({ text: pulse, sessionKey, cfg });
      }
    } catch {
      // Non-fatal — skip pulse on any error
    }
  }

  // ── 2b. Clear stale session summary sentinel ────────────────────────────
  // Write a sentinel to .last-session-summary so that if the closing turn
  // times out or fails, the completion notification cannot display a stale
  // summary from a previous session. The closing turn LLM will overwrite
  // this file with the real summary as its final step.
  if (workspaceDir) {
    try {
      const summaryPath = path.join(workspaceDir, "memory", ".last-session-summary");
      fs.writeFileSync(summaryPath, `[closing-turn in progress: ${oldSessionId.slice(0, 8)}]`);
    } catch {
      // Non-fatal — worst case is a stale read (existing behavior)
    }
  }

  // ── 3. Run the LLM closing turn (blocking — new session waits) ───────────
  log.info(`Spawning for session ${oldSessionId} → ${sessionFile}`);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  // Derive the message channel from the session key (e.g. "telegram" from
  // "agent:main:telegram:direct:7898601152") so that createOpenClawCodingTools
  // applies the same tool policy as a real inbound message on that channel.
  // Without this, messageProvider is undefined → full tool set (nodes/cron/gateway)
  // → different system prompt digest → cache miss.
  const sessionKeyChannel = (() => {
    const parsed = parseAgentSessionKey(sessionKey);
    return parsed?.rest?.split(":").filter(Boolean)[0] ?? undefined;
  })();

  // Build the Inbound Context system prompt block from the previous session's
  // origin metadata. Live Telegram sessions always include this block (built from
  // the inbound message context). Injecting it here makes the closing turn's
  // system prompt byte-identical to live turns → prompt-cache hit.
  const inboundMetaPrompt = (() => {
    const origin = previousSessionEntry?.origin as
      | {
          provider?: string;
          surface?: string;
          chatType?: string;
          to?: string;
          accountId?: string;
        }
      | undefined;
    if (!origin) {
      return undefined;
    }
    try {
      return buildInboundMetaSystemPrompt({
        Provider: origin.provider ?? sessionKeyChannel,
        Surface: origin.surface ?? sessionKeyChannel,
        ChatType: origin.chatType ?? "direct",
        OriginatingTo: origin.to,
        AccountId: origin.accountId,
      });
    } catch {
      return undefined;
    }
  })();

  // Inherit the previous session's reasoning/thinking state so the runtime line
  // in the system prompt matches the live session (Reasoning: on vs off).
  //
  // Reasoning and thinking are separate concepts:
  //   - reasoningLevel ("on"|"off"|"stream"): Anthropic extended thinking shown to user
  //   - thinkingLevel ("low"|"medium"|"high"|...): extended thinking compute budget
  //
  // The live session flow calls resolveDefaultReasoningLevel() which checks the model
  // catalog for `reasoning: true` and auto-enables it (e.g. claude-sonnet-4-6 → "on").
  // agentCommand does NOT do this auto-detection; it defaults to "off" unless an
  // explicit reasoning override is passed.
  //
  // Strategy:
  //   1. If the session explicitly set reasoningLevel ("on"|"off"|"stream") → pass it.
  //   2. If reasoningLevel is absent → run catalog lookup to match the live session default.
  //   3. Pass thinkingLevel separately via `thinking` if present.
  const inheritedThinkingLevel = previousSessionEntry?.thinkingLevel?.trim() || undefined;

  // Resolve the effective model for the closing turn. Prefer the previous session's model
  // override (e.g., user was on Opus) over the config default. This matters for both:
  //   a) Reasoning auto-detection (model catalog lookup must use the right model)
  //   b) Actual model used by agentCommand (must match for Anthropic cache to hit)
  const sessionModelOverride = previousSessionEntry?.modelOverride?.trim() || undefined;
  const sessionProviderOverride = previousSessionEntry?.providerOverride?.trim() || undefined;
  const effectiveModelRef = (() => {
    if (sessionModelOverride) {
      const provider = sessionProviderOverride || "anthropic";
      return `${provider}/${sessionModelOverride}`;
    }
    const modelCfg = cfg?.agents?.defaults?.model;
    return typeof modelCfg === "string" ? modelCfg : (modelCfg?.primary ?? "");
  })();

  const inheritedReasoningLevel = await (async (): Promise<string | undefined> => {
    const persisted = previousSessionEntry?.reasoningLevel;
    if (persisted !== undefined && persisted !== null) {
      // User explicitly set or cleared reasoning — honour it.
      return persisted.trim() || undefined;
    }
    // No explicit override: resolve model default (same logic as get-reply-directives.ts).
    // Use the effective model (session override or config default) — not always the config model.
    try {
      const [provider, ...rest] = effectiveModelRef.split("/");
      const model = rest.join("/");
      if (!provider || !model) {
        return undefined;
      }
      const catalog = await loadModelCatalog({ config: cfg });
      return resolveReasoningDefault({ provider, model, catalog }) || undefined;
    } catch {
      return undefined;
    }
  })();

  // Inject the session's model override into the store before calling agentCommand.
  // agentCommand has no direct model parameter — it reads modelOverride/providerOverride from
  // the session store entry under sessionKey. Since the session was just reset (entry cleared),
  // we create a minimal entry with the inherited model override so the closing turn runs on
  // the same model as the previous session (critical for Anthropic cache key matching).
  // The new session will overwrite this entry when it starts.
  if (sessionModelOverride) {
    const storePath = resolveStoreFilePath(cfg, agentId);
    if (storePath) {
      try {
        await updateSessionStore(storePath, (store) => {
          const existing = store[sessionKey];
          store[sessionKey] = {
            ...existing,
            modelOverride: sessionModelOverride,
            ...(sessionProviderOverride ? { providerOverride: sessionProviderOverride } : {}),
          } as SessionEntry;
        });
        log.info(
          `Injected model override ${effectiveModelRef} into session store for closing turn`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Could not inject model override into session store: ${message}`);
        // Non-fatal — agentCommand will fall back to config default model.
      }
    }
  }

  // Build a context preamble injected as the user message prefix, before the closing prompt.
  // This ensures every session summary written to memory/YYYY-MM-DD.md contains:
  //   - The session ID (first 8 chars) — searchable by BM25 for "what happened in session X"
  //   - The ISO date — fills in if file naming ever drifts
  //   - Day of week — enables temporal queries like "what happened last Tuesday"
  // The LLM is instructed to include this in a metadata line at the top of its output.
  const now = new Date();
  const isoDate = now.toISOString().slice(0, 10);
  const dayOfWeek = now.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "America/Chicago",
  });
  const shortSessionId = oldSessionId.slice(0, 8);
  const contextPreamble =
    `Session context: session ID = ${shortSessionId}, date = ${isoDate} (${dayOfWeek}).\n` +
    `Start your memory log output with this metadata line: "_Session: ${shortSessionId} — ${dayOfWeek}, ${isoDate}_"\n` +
    `Completion sentinel (Section 7 — write LAST, after all other sections): append "<!-- closing-turn: ${shortSessionId} -->" to the daily memory log. This is a machine-readable completion marker — only write it as your final action.\n\n`;

  let succeeded = false;
  try {
    await agentCommand({
      message: contextPreamble + prompt,
      sessionFile,
      agentId,
      deliver: false,
      // Use senderIsOwner: false to match live Telegram sessions (owner status is
      // determined by ownerAllowFrom config; without it, senderIsOwner=false).
      // This prevents owner-only tools (nodes, cron, gateway) from appearing in
      // the tool list, keeping the system prompt digest identical to live turns.
      senderIsOwner: false,
      abortSignal: abortController.signal,
      // Pass the originating session key so the system prompt assembler
      // produces the same tool policy, channel context, and reaction
      // guidance as the previous Telegram session. This makes the system
      // prompt byte-identical → Anthropic prompt-cache hit.
      // The explicit sessionFile still controls transcript read/write,
      // so closing-turn messages go to the archived file, not the live session.
      sessionKey,
      // Pass the channel so createOpenClawCodingTools applies the same tool
      // policy as a real inbound turn (e.g. Telegram hides nodes/cron/gateway).
      // Without this the tool list differs → different digest → no cache hit.
      channel: sessionKeyChannel,
      // Inject the Inbound Context block to match the live session system prompt.
      // Live turns include this block (built from inbound message context); without
      // it the prompt is shorter and the digest differs → cache miss.
      ...(inboundMetaPrompt ? { extraSystemPrompt: inboundMetaPrompt } : {}),
      // Inherit the previous session's reasoning level so the runtime line matches.
      // Live sessions auto-enable reasoning for models that support it (e.g. Sonnet → "on").
      // agentCommand defaults to "off" unless we pass it explicitly — causing a digest mismatch.
      ...(inheritedReasoningLevel ? { reasoning: inheritedReasoningLevel } : {}),
      // Inherit explicit thinking level (extended compute budget) if set.
      ...(inheritedThinkingLevel ? { thinking: inheritedThinkingLevel } : {}),
      // Run in the subagent lane so the closing-turn is not registered as an
      // active run on the main session lane. Without this, any message:sent
      // event (e.g. from the cache-ttl-warning hook) can trigger interrupt-mode
      // queue logic which calls abortEmbeddedPiRun on the main session —
      // killing the closing-turn's in-flight Anthropic API call mid-turn.
      lane: String(AGENT_LANE_SUBAGENT),
    });
    succeeded = true;
    log.info(`Completed for session ${oldSessionId}`);
  } catch (err) {
    if (abortController.signal.aborted) {
      log.warn(`Timed out after ${timeoutSeconds}s for session ${oldSessionId}`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed for session ${oldSessionId}: ${message}`);
    }
  } finally {
    clearTimeout(timeoutId);

    // ── Clean up injected session overrides ───────────────────────────────
    // The closing turn temporarily injected modelOverride/providerOverride into
    // the new session's store entry so agentCommand would run on the same model
    // as the previous session (for Anthropic cache hits). Now that the turn is
    // done, remove them so the new session starts on the configured default model.
    //
    // Also clean up thinkingLevel: agentCommand persists `thinking` back to the
    // session store when it's passed (agent.ts ~line 928). The closing turn
    // passes inheritedThinkingLevel for cache-key matching, but that must not
    // bleed into the new session — thinkingLevel should reset to undefined on /new.
    if (sessionModelOverride || inheritedThinkingLevel) {
      const storePath = resolveStoreFilePath(cfg, agentId);
      if (storePath) {
        try {
          await updateSessionStore(storePath, (store) => {
            const existing = store[sessionKey];
            if (existing) {
              delete existing.modelOverride;
              delete existing.providerOverride;
              delete existing.thinkingLevel;
            }
          });
          log.info("Cleaned up injected model override and thinkingLevel from session store");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`Could not clean up model override: ${message}`);
        }
      }
    }
  }

  // ── 4. Send completion notification ─────────────────────────────────────
  // Try to read the session summary line written by the closing turn.
  // Falls back to the generic message if the file isn't there.
  // If the file still contains the sentinel from step 2b, the closing turn
  // did not finish writing — treat as incomplete.
  let sessionSummaryLine: string | undefined;
  if (workspaceDir) {
    try {
      const summaryPath = path.join(workspaceDir, "memory", ".last-session-summary");
      const raw = fs.readFileSync(summaryPath, "utf8").trim();
      if (raw && !raw.startsWith("[closing-turn in progress")) {
        sessionSummaryLine = raw.slice(0, 100);
      }
    } catch {
      // File not written — use default message
    }
  }

  const notifyText = succeeded
    ? (completionMessage ??
      (sessionSummaryLine
        ? `✅ Session context saved — ${sessionSummaryLine}`
        : "✅ Session context saved — previous session is now searchable"))
    : "⚠️ Session context save timed out or failed — previous session may not be fully indexed";
  await sendDirect({ text: notifyText, sessionKey, cfg });
}

// ---- Hook handler ----

const handler: HookHandler = async (event) => {
  if (event.type !== "command") {
    return;
  }
  if (event.action !== "new" && event.action !== "reset") {
    return;
  }

  const context = event.context;
  const cfg = context.cfg as OpenClawConfig | undefined;

  // Check hook-level config
  const hookConfig = resolveHookConfig(cfg, "closing-turn");
  if (hookConfig?.enabled === false) {
    return;
  }

  // Resolve previous session entry
  const previousSessionEntry = (context.previousSessionEntry ||
    context.sessionEntry ||
    {}) as Partial<SessionEntry>;
  const oldSessionId = previousSessionEntry.sessionId;

  if (!oldSessionId) {
    log.debug("No previous session ID — skipping");
    return;
  }

  const oldSessionFile = previousSessionEntry.sessionFile;
  const agentId =
    (context.agentId as string) || event.sessionKey?.match(/^agent:([^:]+)/)?.[1] || "main";

  // Resolve store path for file search
  const storePath = resolveStoreFilePath(cfg, agentId);

  // Find the session transcript file
  const sessionFile = findSessionFile({
    sessionFile: oldSessionFile,
    sessionId: oldSessionId,
    storePath,
  });

  if (!sessionFile) {
    log.warn(`No transcript found for session ${oldSessionId}`);
    return;
  }

  // Resolve config
  const timeoutSeconds =
    typeof hookConfig?.timeoutSeconds === "number" && hookConfig.timeoutSeconds > 0
      ? hookConfig.timeoutSeconds
      : 180;
  const prompt =
    typeof hookConfig?.prompt === "string" && hookConfig.prompt.trim()
      ? hookConfig.prompt
      : DEFAULT_CLOSING_PROMPT;

  const workspaceDir = (context.workspaceDir as string | undefined) ?? undefined;

  // Await the closing turn — new session creation is gated on completion.
  // Progress messages are sent directly via routeReply inside runClosingTurn
  // so the user sees feedback before the LLM turn begins.
  await runClosingTurn({
    sessionFile,
    oldSessionId,
    agentId,
    timeoutSeconds,
    prompt,
    sessionKey: event.sessionKey,
    workspaceDir,
    previousSessionEntry,
    cfg: cfg as OpenClawConfig,
    completionMessage:
      typeof hookConfig?.completionMessage === "string" ? hookConfig.completionMessage : undefined,
  });
};

export default handler;
