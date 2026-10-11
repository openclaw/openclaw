import { isRecord } from "../../utils.js";

export function formatCronTerminalPresentation(
  params: unknown,
  result: unknown,
): { text: string } | undefined {
  if (!isRecord(params) || !isRecord(result) || !isRecord(result.details)) {
    return undefined;
  }
  switch (params.action) {
    case "status": {
      const enabled = result.details.enabled === true ? "yes" : "no";
      return { text: `Automations scheduler status.\nEnabled: ${enabled}` };
    }
    case "list": {
      const total =
        typeof result.details.total === "number" &&
        Number.isFinite(result.details.total) &&
        result.details.total >= 0
          ? Math.floor(result.details.total)
          : undefined;
      const count =
        total ?? (Array.isArray(result.details.jobs) ? result.details.jobs.length : undefined);
      return count === undefined
        ? { text: "Automations listed." }
        : { text: `Automations listed.\nCount: ${count}` };
    }
    case "get":
      return { text: "Automation loaded." };
    case "runs": {
      const entries = Array.isArray(result.details.entries)
        ? result.details.entries.length
        : undefined;
      return entries === undefined
        ? { text: "Automation run history loaded." }
        : { text: `Automation run history loaded.\nCount: ${entries}` };
    }
    default:
      return undefined;
  }
}

export function buildCronSelfDescription(params: {
  activeRun: boolean;
  pacingEnabled: boolean;
}): string {
  const inspection =
    "Inspect or remove only the current automation. Actions: status; list [includeDisabled]; get/runs/remove jobId. Use the current job ID. To stop a finished job, remove it; creating/updating/running jobs and waking sessions are unavailable. Return the task result; the scheduler owns delivery.";
  if (!params.activeRun) {
    return inspection;
  }
  return (
    inspection +
    " scratch_get reads this job's checklist and revision; scratch_set replaces or clears content using expectedRevision from the read (reread after a revision conflict). record_result accepts one outcome (no_change, progress, done, blocked, needs_attention) and concise summary for this run. no_change or NO_REPLY keeps the response silent." +
    (params.pacingEnabled ? ' next_check in:"15m" proposes the next delay for this paced job.' : "")
  );
}

export function buildCronToolDescription(params: { triggersEnabled: boolean }): string {
  const streamScheduleLine = params.triggersEnabled
    ? '\n- {kind:"stream",command:[argv]}: supervised process output.'
    : "";
  const scriptPayloadLine = params.triggersEnabled
    ? '\n- {kind:"script",script}: headless, main|isolated only; automations is self-scoped (no add/update/run/wake), cannot resume a conversation.'
    : "";
  const triggerSection = params.triggersEnabled
    ? `TRIGGER (condition watcher on every/cron): {script}. Never model-poll. Headless check: 30s/5 tool calls/16KB state. Read frozen trigger.state; return json({fire,message?,state?}) with new state for dedupe. fire:false saves state without a model call; fire:true runs payload with self-contained message. Fire on failures/timeouts too. Keep checks read-only; actions belong in payload. once:true disables after first fire. Code Mode: await exec({command:"..."}).`
    : `TRIGGERS DISABLED (cron.triggers.enabled=false): triggers, script payloads, and stream schedules are unavailable. For a conditional watcher, say it is unsupported; never model-poll or silently substitute an unconditional job. Plain time-based schedules remain available.`;
  const silentWatcherCue = params.triggersEnabled ? ' Silent watcher=>mode:"none".' : "";
  const scriptCue = params.triggersEnabled
    ? " Use triggers/script payloads to skip the model on quiet checks. Scripts reach MCP only through toolsAllow entries <server>__tool or <server>__*. Throw to record script failure (returning {error} succeeds); recurring-job failure alerts wait for consecutive failures, run output follows delivery."
    : "";
  return `Schedule reminders, delayed self-wakeups, recurring work${params.triggersEnabled ? ", event watchers" : ""}. Never exec sleep/poll as timer.

ACTIONS: status | list (summaries; follow nextOffset) | get jobId (full details) | add job | update jobId job (partial; null clears) | remove jobId (operator removal requests active-run cancellation) | run jobId (runMode:"force"=now; waits up to timeoutMs, default 60s; unfinished runs return runId) | runs jobId runId? (history) | wake text enqueues a normal follow-up in the caller-owned session (sessionKey/agentId to pick another). Check unfinished runs later with runs, never a scheduled verification job. wake has no delay; for a later resume use an at job below.

SCOPE: Authenticated configured channel owners and Control UI administrators can manage any Gateway automation. Other turns see caller-visible jobs and scoped counts only: an empty list or failed list/get/update/remove (including not-found) does not establish global absence, even for IDs from your history. Never recreate or replace a known automation for update/remove/reconciliation based on these results; report the visibility limit and ask an authorized administrator to check through a fresh authenticated owner/administrator turn or the Automations page. New requested automations may still be created.

ADD: job requires schedule+payload.

SCHEDULE:
- {kind:"at",at:"ISO-8601"}: one-shot; missing timezone=UTC. Auto-deletes after successful completion; failed/unknown required delivery retains it disabled.
- {kind:"every",everyMs}.
- {kind:"cron",expr,tz?:"IANA"}: wall time in tz, never UTC-convert; omitted tz=Gateway host local.${streamScheduleLine}

TARGET+PAYLOAD:
- "current" (agentTurn default) = this conversation's context: the run stays detached, reads bounded chat context, then delivers its final visible assistant result to the resolved destination (this conversation unless another destination is configured). Delayed work/loop = at|every + agentTurn + current. This is not a resumed parent turn: it uses the scheduled agent workspace with its own session identity, not the conversation worktree or cloud worker placement. In-flight turns sent through the job's stable cron key are canceled if that key is reassigned. Verify required checkout/tool access before delegating repository work; result delivery alone does not resume the original agent.
- "isolated" = fresh detached session; standalone background work recorded in cron run history.
- "main" = normal main-session follow-up; payload {kind:"systemEvent",text} (systemEvent default target). The run waits for actual execution and delivery.
- "session:<key>" + agentTurn runs a turn inside that existing conversation (same history, saved workspace/worktree). To come back here later (wait for CI, recheck), add an at + agentTurn job with sessionTarget "session:<your session key from Runtime>" and message = instructions for your next turn.
- {kind:"agentTurn",message,includeReasoning?}; includeReasoning includes reasoning only alongside a meaningful delivered result; timeoutSeconds 0=none.
- Inherited MCP authority covers model-callable tools, not interactive app-view-only capabilities.${scriptPayloadLine}

PACED LOOP: recurring job + pacing{min?,max?} durations (at least one). Call next_check in:"15m" inside its run; delay is clamped to bounds and measured from run end. Failed runs keep normal backoff.

AUTHORING: keep repeatable logic in workspace scripts and detailed instructions in referenced files. Name exact tools/arguments; cap toolsAllow to what the run needs.${scriptCue}

${triggerSection}

DELIVERY: omitted=announce. Agent, command, and script jobs send their final visible result to the destination, then add confirmed delivery once to that conversation, independently of isolated/current/persistent execution. Set channel/to/accountId/threadId to select another destination; the creating conversation is the fallback when no external route exists. Verified matching message-tool delivery suppresses the notification resend, not the conversation result. Failed or uncertain external sends are not added to conversation history; a failed history write after confirmed delivery records a warning without failing delivery. With no external route, the conversation commit completes delivery and appears live and after reconnect. Use none for no automatic result or notification. ${silentWatcherCue} webhook posts finished-run event (successful empty summary is intentional silence, no POST) to URL in \`to\`. To keep announce delivery and also POST completion, use mode:"announce" with completionDestination:{mode:"webhook",to:"https://..."}.

FAILURE ALERTS: routed jobs default to 2 consecutive execution failures and 1h cooldown; terminal one-shot failures bypass that count. failureAlert:false disables execution/delivery alerts, not auto-disable notices. bestEffort suppresses inherited execution alerts. Required-delivery failures use an alternate route, bypass after, and share the cooldown without incrementing the execution streak.

Optional job policy: activeHours{start,end,timezone?} is an end-exclusive execution window (including manual runs); idleOnly yields to foreground work. delivery.target:"owner" resolves the owner DM dynamically, never the last group; delivery.directPolicy:"block" prohibits DMs. agentTurn skipIfScratchEmpty skips an explicitly empty checklist, not missing scratch. jobId canonical (id=compat). contextMessages 0-10 embeds recent chat lines into reminder text.`;
}
