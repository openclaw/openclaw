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
    ? '\n- {kind:"stream",command:[argv]}: fires on supervised process output; disabled only when cron.triggers.enabled=false.'
    : "";
  const scriptPayloadLine = params.triggersEnabled
    ? '\n- {kind:"script",script}: main|isolated only; disabled only when cron.triggers.enabled=false.'
    : "";
  const triggerSection = params.triggersEnabled
    ? `TRIGGER (condition watcher on every/cron): {script}; available unless cron.triggers.enabled=false — if off, say so; never model-poll instead. Quiet headless check, no model; 30s/5 tool calls/16KB state. Read frozen trigger.state, return json({fire,message?,state?}) with NEW state; dedupe via state, never memory. fire:false saves state only. fire:true runs payload; message is that run's entire context — self-contained. Fire on failures/timeouts too; success-only watchers look healthy when broken. Script stays read-only; actions belong in payload. once:true disables after first fire. Code Mode: await exec({command:"..."}).`
    : `TRIGGERS DISABLED (cron.triggers.enabled=false): condition triggers, script payloads, and stream schedules are unavailable here. Omit trigger; use plain time-based schedules. If the user asks for a conditional watcher, say it is unsupported — never model-poll instead, and never silently create an unconditional job in its place.`;
  const silentWatcherCue = params.triggersEnabled ? ' Silent watcher=>mode:"none".' : "";
  const scriptCue = params.triggersEnabled
    ? " When a script can decide there is nothing to do, use a trigger or script payload so quiet fires skip the model; scripts reach MCP only for servers named in toolsAllow (<server>__tool or <server>__*). When a run fails, throw from the script so the run records the failure (returning {error} still succeeds); only the failure alert waits for consecutive failures, run output still follows the job's delivery."
    : "";
  return `Gateway scheduler: reminders, delayed self-wakeups, loops, recurring work${params.triggersEnabled ? ", event watchers" : ""}. Never exec sleep/poll as timer.

ACTIONS: status | list [includeDisabled,limit?,offset?] (compact summaries with timing; use nextOffset for the next page) | get jobId (full schedule, payload, and delivery details) | add job | update jobId job (partial: only supplied fields change; null clears) | remove jobId (operator removal requests cancellation of an active run; the result reports activeRunCancellationRequested:true) | run jobId (runMode "force"=now; waits up to timeoutMs, default 60s, and returns the finished run: status, error, deliveryStatus, summary; a longer run, or a main-session job that starts after this turn, returns runId — check it later with runs jobId runId, never with a scheduled verify job) | runs jobId runId? = history | wake text enqueues a normal follow-up in the caller-owned session (sessionKey/agentId to pick another).

SCOPE: Authenticated configured channel owner and Control UI administrator turns can list/get/update/run/remove any Gateway automation. Other turns see only caller-visible jobs; totals/counts and hasMore describe that scoped view, not global inventory. In that restricted view, an empty list or failed list/get/update/remove (including not-found) does not establish global absence, whatever the source of a known job id (including your own history). Never recreate or replace a known automation to satisfy an update/remove or reconciliation request solely because of these results. Report that you cannot establish global absence and ask an authorized administrator to check through a fresh authenticated configured channel owner or Control UI administrator turn or the Automations page. Genuinely new, requested automations can still be created.

ADD: job requires schedule+payload.

SCHEDULE:
- {kind:"at",at:"ISO-8601"} one-shot; no tz=UTC; auto-deletes after successful completion: delivery confirmed, not requested, intentionally silent, or explicitly bestEffort. Failed/unknown required delivery retains it disabled.
- {kind:"every",everyMs}.
- {kind:"cron",expr,tz?:"IANA"}: expr is wall time in tz; never pre-convert to UTC; no tz=gateway host local. 18:00 Shanghai => {expr:"0 18 * * *",tz:"Asia/Shanghai"}.${streamScheduleLine}

TARGET+PAYLOAD:
- "current" (agentTurn default) = this conversation: the run stays detached, reads bounded chat context, then commits its final visible assistant result to this conversation's durable history. Delayed work/loop = at|every + agentTurn + current. This is not a resumed parent turn: it uses the scheduled agent workspace with its own session identity, not the conversation worktree or cloud worker placement. In-flight turns sent through the job's stable cron key are canceled if that key is reassigned. Verify required checkout/tool access before delegating repository work; result delivery alone does not resume the original agent.
- "isolated" = fresh detached session; standalone background work recorded in cron run history.
- "main" = normal main-session follow-up; payload {kind:"systemEvent",text} (systemEvent default target). The run waits for actual execution and delivery.
- "session:<key>" = named session.
- {kind:"agentTurn",message,includeReasoning?}; includeReasoning includes reasoning only alongside a meaningful delivered result; timeoutSeconds 0=none.
- Inherited configured MCP authority includes only model-callable tools; interactive app-view-only capabilities are excluded from headless jobs.${scriptPayloadLine}

PACED LOOP: recurring job + pacing{min?,max?} durations ("15m","4h"; at least one). Inside its run, job calls next_check in:"<dur>" to set the next delay (clamped to bounds, measured from run end; failed runs keep normal backoff). Adaptive polling: tighten when active, back off when quiet.

AUTHORING (recurring): every fire re-runs the same instructions; keep the model for judgment only. Put repeatable logic (listing/diffing, dedupe, checkpoints/watermarks) in a workspace script the payload runs in one exec; keep detailed instructions in a workspace file beside it that the message references ("Follow scripts/<job>.md"), so fixes need only file edits. Message names exact tool ids + argument shapes; cap toolsAllow to what the run needs.${scriptCue}

${triggerSection}

DELIVERY: where detached run output goes. Omitted=announce (current=>canonical session commit, plus one normal channel send for external chats; isolated=>last route; set channel/to for a specific chat — no messaging tool inside the run). A current announce succeeds only after its history commit; WebChat observes that commit live and after reconnect without another user message.${silentWatcherCue} webhook posts finished-run event (successful empty summary is intentional silence, no POST) to URL in \`to\`. To keep announce delivery and also POST completion, use mode:"announce" with completionDestination:{mode:"webhook",to:"https://..."}.

FAILURE ALERTS: jobs with a failure route default to alerting after 2 consecutive execution failures with a 1h cooldown. Route order: job failureAlert fields, delivery.failureDestination over global cron.failureAlert destination fields, then primary announce. failureAlert:false disables execution/delivery alerts, not the auto-disable safety notice; a failureAlert object activates/tunes. bestEffort suppresses inherited execution alerts. Required completion-delivery failure uses only an alternate route, bypasses after, and shares the execution-alert cooldown from the first failure; it does not increment the execution streak.

Optional job policy: activeHours{start,end,timezone?} is an end-exclusive execution window (including manual runs); idleOnly yields to foreground work. delivery.target:"owner" resolves the owner DM dynamically, never the last group; delivery.directPolicy:"block" prohibits DMs. agentTurn skipIfScratchEmpty skips an explicitly empty checklist, not missing scratch. jobId canonical (id=compat). contextMessages 0-10 embeds recent chat lines into reminder text.`;
}
