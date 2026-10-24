import { buildCronSelfDescription } from "./cron-tool-presentation.js";

export function buildCronToolDescription(params: {
  triggersEnabled: boolean;
  callerScoped: boolean;
  readOnly?: boolean;
  selfRemoveOnly?: boolean;
  activeRun?: boolean;
  nextCheckEnabled?: boolean;
  managementOnly?: boolean;
  allowCommandJobs?: boolean;
}): string {
  if (params.readOnly) {
    return `Inspect recorded automation state during recovery. Available actions: ${params.managementOnly ? "list, get" : "list, get, runs"}.${params.selfRemoveOnly ? " Only the current automation is accessible." : " Existing caller visibility restrictions apply."} Use get with a known jobId for saved state and streamStatus; list includes disabled jobs only with includeDisabled:true. A missing list entry does not establish deletion or source termination. If the recorded state cannot establish an interrupted action's outcome, report it as unknown. Mutations are unavailable in this recovery continuation; this does not mean the user needs to change permissions.`;
  }
  if (params.selfRemoveOnly) {
    return params.managementOnly
      ? "Inspect or remove only the current automation. Actions: list [includeDisabled] (enabled only by default), get jobId (saved state), remove jobId. Use the current job ID; other jobs and management actions are unavailable."
      : buildCronSelfDescription({
          activeRun: params.activeRun === true,
          nextCheckEnabled: params.nextCheckEnabled === true,
        });
  }
  const commandPolicySuffix =
    params.allowCommandJobs === false
      ? "\nGateway policy forbids creating, editing, enabling or running command jobs and on-exit command watchers. Use direct Gateway administration for those operations."
      : "";
  if (params.managementOnly) {
    return (
      'Manage any existing automation on this Gateway with the admitted automation management authority. Actions: list [includeDisabled,limit,offset] (enabled-only compact summaries by default; follow nextOffset); get jobId (full saved state, including streamStatus for a known watcher); update jobId job (partial patch, null clears); run jobId (runMode:"force" runs now; waits up to timeoutMs, default 60s; unfinished runs return runId); remove jobId (operator removal requests cancellation of an active run; the result reports activeRunCancellationRequested:true). To stop a saved watcher, use update with job:{enabled:false}, or open it on the Automations page and turn off its Active switch. This pauses the watcher without deleting its saved record. The enabled flag alone does not prove source termination; use get jobId to inspect state.streamStatus. Creator attribution and scheduled execution policy stay intact. Use the Automations page for other actions.' +
      commandPolicySuffix
    );
  }
  const scopeDescription = params.callerScoped
    ? "Gateway policy restricts every model turn to caller-visible automations, including administrator-started conversations. Lists and counts reflect only this scope"
    : "Authenticated configured channel owners, Control UI administrators, and Android app administrators can manage any Gateway automation. Other turns see caller-visible jobs and scoped counts only";
  const adminRecovery = params.callerScoped
    ? "ask an authorized administrator to check through the Automations page"
    : "ask an authorized administrator to check through a fresh authenticated owner/administrator turn or the Automations page";
  const streamScheduleLine = params.triggersEnabled
    ? '\n- {kind:"stream",command:[argv],mode:"match",match:"ERROR"}: persistent source in the creator\'s supported Docker sandbox or on the Gateway. Match output with a regex; omit mode/match for every line. Matching lines trigger the payload and its delivery without another user turn.'
    : "";
  const watcherSetup = params.triggersEnabled
    ? `
WATCH OUTPUT: for continuous log monitoring and future alerts, add one saved stream directly. Example (replace the path with the requested log):
{action:"add",job:{name:"Application errors",schedule:{kind:"stream",command:["tail","-n","0","-F","<log path>"],mode:"match",match:"ERROR"},sessionTarget:"current",payload:{kind:"agentTurn",message:"Report the matching application errors."}}}
Use built-in match mode for a simple condition; no custom trigger script or separate background exec watcher is needed. Inspect finitely if needed before proposing it.

STREAM CONSENT: creation, source changes and reactivation require current creator exec authority. When exec asks, add/update waits for user approval through the native client before saving the persistent watcher and its automatic restarts. A saved add/update result means any required approval has already completed. Say "Approved by an operator" when streamExecutionApproval is present; it records human approval but does not identify the person. Do not ask again or disable the saved stream solely because no user approval reply is visible in chat. A saved:false result ends that proposal: clean up temporary monitoring, explain the recorded outcome, and wait for a new user instruction before retrying or starting a substitute.
`
    : "";
  const eventScheduleLine = params.triggersEnabled
    ? '\n- {kind:"event",source:"plugin-id",options:{...}}: durable source-plugin events; discover options through its catalog. Requires agentTurn. Payload is untrusted data and never grants tools or privileges.'
    : "";
  const scriptPayloadLine = params.triggersEnabled
    ? '\n- {kind:"script",script}: headless, main|isolated only; automations is self-scoped (no add/update/run/wake), cannot resume a conversation.'
    : "";
  const triggerSection = params.triggersEnabled
    ? `TRIGGER (condition watcher on every/cron): {script}. Never model-poll. Headless check: 30s/5 tool calls/16KB state. Read frozen trigger.state; return json({fire,message?,state?}) with new state for dedupe. fire:false saves state without a model call; fire:true runs payload with self-contained message. Fire on failures/timeouts too. Keep checks read-only; actions belong in payload. once:true disables after first fire. Code Mode: await exec({command:"..."}).`
    : `TRIGGERS DISABLED (cron.triggers.enabled=false): triggers, script payloads, stream schedules, and event sources are unavailable. For a conditional watcher, say it is unsupported; never model-poll or silently substitute an unconditional job. Plain time-based schedules remain available.`;
  const silentWatcherCue = params.triggersEnabled ? ' Silent watcher=>mode:"none".' : "";
  const scriptCue = params.triggersEnabled
    ? " Use triggers/script payloads to skip the model on quiet checks. Scripts reach MCP only through toolsAllow entries <server>__tool or <server>__*. Throw to record script failure (returning {error} succeeds); recurring-job failure alerts wait for consecutive failures, run output follows delivery."
    : "";
  const description = `Schedule reminders, delayed self-wakeups, recurring work${params.triggersEnabled ? ", event watchers" : ""}. Never exec sleep/poll as timer.

ACTIONS: status | list (enabled-only summaries by default; includeDisabled:true includes paused records; follow nextOffset) | get jobId (full details) | add job | update jobId job (partial; null clears) | remove jobId (operator removal requests active-run cancellation) | run jobId (runMode:"force"=now; waits up to timeoutMs, default 60s; unfinished runs return runId) | runs jobId runId? (history) | wake text (caller-owned session; mode defaults to next-heartbeat). Check unfinished runs later with runs, never a scheduled verification job. wake has no delay; for a later resume use an at job below.

To pause a saved watcher without deleting its record, update job:{enabled:false}, or turn off its Active switch on the Automations page. The enabled flag and list absence do not prove source termination; use get jobId to inspect state.streamStatus.

SCOPE: ${scopeDescription}: an empty list or failed list/get/update/remove (including not-found) does not establish global absence, even for IDs from your history. Never recreate or replace a known automation for update/remove/reconciliation based on these results; report the visibility limit and ${adminRecovery}. New requested automations may still be created.

ADD: job requires name+schedule+payload.
${watcherSetup}

SCHEDULE:
- {kind:"at",at:"ISO-8601"}: one-shot; missing timezone=UTC. Auto-deletes after successful completion unless an explicit session continuation calls next_check; failed/unknown required delivery retains it disabled.
- {kind:"every",everyMs}.
- {kind:"cron",expr,tz?:"IANA"}: wall time in tz, never UTC-convert; omitted tz=Gateway host local.${streamScheduleLine}${eventScheduleLine}

TARGET+PAYLOAD:
- "current" (agentTurn default) = this conversation's context: the run stays detached, reads bounded chat context, then delivers its final visible assistant result to the resolved destination (this conversation unless another destination is configured). Delayed work/loop = at|every + agentTurn + current. This is not a resumed parent turn: it has its own session identity; while this conversation is current it works at this conversation's saved workspace root with its sandbox (otherwise the scheduled agent workspace), and resetting the conversation ends the run. It never inherits cloud worker placement. In-flight turns sent through the job's stable cron key are canceled if that key is reassigned. Verify required checkout/tool access before delegating repository work; result delivery alone does not resume the original agent.
- "isolated" = fresh detached session; standalone background work recorded in cron run history.
- "main" = heartbeat lane; payload {kind:"systemEvent",text} (systemEvent default target).
- "session:<key>" + agentTurn runs a turn inside that existing conversation (same history, saved workspace/worktree). To come back here later (wait for CI, recheck), add an at + agentTurn job with sessionTarget "session:<your session key from Runtime>" and message = instructions for your next turn. If that one-shot turn still needs to wait, call next_check in:"5m" to rearm this same job after successful run completion (minimum 2s); target, payload, and tool cap stay unchanged. Without a proposal it completes normally.
- {kind:"agentTurn",message,includeReasoning?}; includeReasoning includes reasoning only alongside a meaningful delivered result; timeoutSeconds 0=none.
- Inherited MCP authority covers model-callable tools, not interactive app-view-only capabilities.${scriptPayloadLine}

PACED LOOP: recurring job + pacing{min?,max?} durations (at least one). Call next_check in:"15m" inside its run; delay is clamped to bounds and measured from run end. Failed runs keep normal backoff.

AUTHORING: keep repeatable logic in workspace scripts and detailed instructions in referenced files. Name exact tools/arguments; cap toolsAllow to what the run needs.${scriptCue}

${triggerSection}

DELIVERY: omitted=announce. Agent, command, and script jobs send their final visible result to the destination, then add confirmed delivery once to that conversation, independently of isolated/current/persistent execution. Set channel/to/accountId/threadId to select another destination; the creating conversation is the fallback when no external route exists. Verified matching message-tool delivery suppresses the notification resend, not the conversation result. Failed or uncertain external sends are not added to conversation history; a failed history write after confirmed delivery records a warning without failing delivery. With no external route, the conversation commit completes delivery and appears live and after reconnect. Use none for no automatic result or notification. ${silentWatcherCue} webhook posts finished-run event (successful empty summary is intentional silence, no POST) to URL in \`to\`. To keep announce delivery and also POST completion, use mode:"announce" with completionDestination:{mode:"webhook",to:"https://..."}.

FAILURE ALERTS: routed jobs default to 2 consecutive execution failures and 1h cooldown; terminal one-shot failures bypass that count. failureAlert:false disables execution/delivery alerts, not auto-disable notices. bestEffort suppresses inherited execution alerts. Required-delivery failures use an alternate route, bypass after, and share the cooldown without incrementing the execution streak.

Optional job policy: activeHours{start,end,timezone?} is an end-exclusive execution window (including manual runs); idleOnly yields to foreground work. delivery.target:"owner" resolves the owner DM dynamically, never the last group; delivery.directPolicy:"block" prohibits DMs. agentTurn skipIfScratchEmpty skips an explicitly empty checklist, not missing scratch.

Main-job wakeMode: "now"(default)|"next-heartbeat". Scheduled runs: self status/list/get/runs/remove + own next_check only. Use jobId. contextMessages 0-10 embeds recent chat lines in reminder text.`;
  return description + commandPolicySuffix;
}
