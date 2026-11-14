// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
/**
 * Continuation prompt guidance (CONTINUE_WORK / continue_delegate / request_compaction)
 * rendered into the OpenClaw system prompt when the continuation feature is enabled.
 */

/** Tooling-list hint steering delegate work to `continue_delegate` when the tool is available. */
export function delegateToolHint(availableTools: ReadonlySet<string>): string[] {
  return availableTools.has("continue_delegate")
    ? [
        "For background, delayed, silent, or compaction-aware delegate work, prefer `continue_delegate` over shell sleeps, ad-hoc `openclaw ...` CLI calls, or manual relay patterns.",
      ]
    : [];
}

/** Continuation & delegation sections; main sessions get the full guide, sub-agents chain hops. */
export function buildContinuationLines(
  params: { continuationEnabled?: boolean },
  isMinimal: boolean,
  availableTools: ReadonlySet<string>,
): string[] {
  const lines: string[] = [];
  // Continuation tokens — only when the feature is enabled and not in subagent mode
  // RFC §3.4: system prompt branches on tool availability (uses outer `availableTools`).
  if (!isMinimal && params.continuationEnabled) {
    lines.push(
      "## Continuation & Delegation",
      "### How you wake",
      "You run only when an inbound message arrives, a scheduled automation fires, or a continuation you armed wakes you.",
      "If you end a turn without arming one, nothing else wakes you.",
      "- Your own next turn, for concrete work left in this session: `continue_work` (or CONTINUE_WORK).",
      "- Work that should run beside you or later: `continue_delegate`.",
      "- Waiting for a delegate or sub-agent already running: `sessions_yield`; its result wakes you.",
      "",
      "### Self-elected turns",
      ...(availableTools.has("continue_work")
        ? [
            "Use the `continue_work` tool to request another turn with structured `reason` and optional `delaySeconds`.",
            "Fallback bracket syntax remains available: CONTINUE_WORK or CONTINUE_WORK:30.",
          ]
        : [
            "End your response with CONTINUE_WORK to request another turn after a delay.",
            "End with CONTINUE_WORK:30 to specify delay in seconds.",
          ]),
      "Use it only when work remains; do not use it to wait, idle, or keep the session alive.",
      "",
      "### Delegated continuation",
      ...(availableTools.has("continue_delegate")
        ? [
            "Use the `continue_delegate` tool to queue background sub-agents for dispatch after this response, after a delay,",
            "or when this session compacts. The gateway owns their timing and delivery.",
            "",
            "Tool parameters:",
            "  task (required) — the delegated sub-agent's task; include scope, context, and desired return shape",
            "  delaySeconds — seconds to wait before spawning (0 or omitted = after this response; clamped to configured min/max)",
            '  mode — "normal" (default, announces to channel), "silent" (internal context only),',
            '         "silent-wake" (silent + triggers your next turn), "post-compaction" (fires at compaction)',
            "  attachments / attachAs — typed inline snapshots mounted into the new child workspace",
            "",
            "Call the tool multiple times in one turn for parallel fan-out while the main session stays free.",
            "",
            "Fallback bracket syntax (if the tool call fails or is unavailable):",
            "  [[CONTINUE_DELEGATE: task +30s | silent-wake]]",
            "Modifiers: +Ns for delay, | silent, | silent-wake. End your response with the bracket.",
            "Bracket syntax cannot carry attachment blobs; reference an existing workspace file instead.",
          ]
        : [
            "End your response with [[CONTINUE_DELEGATE: task description]] to dispatch a sub-agent",
            "with gateway-managed timing and delivery control.",
            "",
            "Syntax:",
            "  [[CONTINUE_DELEGATE: task +30s]]               — delayed spawn, normal return",
            "  [[CONTINUE_DELEGATE: task | silent]]            — result as internal context only (no channel output)",
            "  [[CONTINUE_DELEGATE: task | silent-wake]]       — silent result + triggers your next turn",
            "  [[CONTINUE_DELEGATE: task +30s | silent-wake]]  — delayed spawn, silent return, triggers next turn",
            "Bracket syntax cannot carry attachment blobs; reference an existing workspace file instead.",
            "",
            "The task text is free-form. Include working context alongside the instruction.",
          ]),
      "",
      "Use `silent` when the result should only inform later turns. Use `silent-wake` when it",
      "should also wake you to act on it.",
      "",
      ...(availableTools.has("request_compaction")
        ? [
            "### Compaction",
            "Use the `request_compaction` tool to request compaction now and reclaim context window space.",
            "Pair with `continue_delegate` post-compaction shards as the lifeboat for working state.",
            "",
          ]
        : []),
      "### When to use CONTINUE_DELEGATE vs sessions_spawn",
      "Use sessions_spawn for immediate, explicit workers you want to manage directly, for ACP",
      "runtime spawns, or when the shard needs explicit spawn-time controls such as cwd or threads.",
      ...(availableTools.has("continue_delegate")
        ? [
            "The typed `continue_delegate` tool can carry inline attachments into its new child workspace.",
          ]
        : []),
      "Bracket `[[CONTINUE_DELEGATE: ...]]` syntax cannot carry attachment blobs; it may reference",
      "a file that already exists in the workspace.",
      "Use `continue_delegate` (or `[[CONTINUE_DELEGATE:]]` bracket syntax) when you need:",
      "  - Delayed dispatch — schedule work for N seconds from now",
      "  - Silent return — result arrives as internal context, no channel output",
      "  - Wake-on-return — silent result that triggers your next turn",
      "  - Background fan-out — multiple narrow shards while the main session keeps thinking/responding",
      "  - Compaction handoff — preserve working state or partial results across compaction",
      "  - Chain tracking — gateway enforces cost cap and depth limit across linked dispatches",
      "",
      "Do not use `exec`, shell sleeps, or manual `openclaw ...` commands to imitate delayed",
      "delegate scheduling when `continue_delegate` or `sessions_spawn` already fits the job.",
      "",
      "### Cooperative yield",
      "Use `sessions_yield` to end your turn immediately, aborting any queued tool calls.",
      "The session parks until an external event (subagent result, user message) arrives.",
      "This is useful after dispatching delegates when you should stop and wait for results,",
      "rather than requesting another turn on a timer.",
      "",
      "**Do NOT pair `sessions_yield` with `message`-tool or other delivery-tool calls in the",
      "same response.** `sessions_yield` aborts queued tool-calls, including in-flight",
      "`message`-tool deliveries, before their bodies reach the channel. Result: empty",
      "placeholder lines on channel (e.g. `\u2709\ufe0f Message`, `\u23f8\ufe0f Yield`) while",
      "your composed prose-body is dropped. For a routine clean turn-end where you have",
      "nothing more to do, fire no yield tool — the framework ends your turn naturally",
      "once all queued tool-calls complete. Reserve `sessions_yield` for the explicit",
      "wait-on-external-event case it was built for (subagent results, delegate returns).",
      "",
      "### Context pressure",
      "When you receive a [system:context-pressure] event, your context window is approaching capacity.",
      ...(availableTools.has("continue_delegate")
        ? [
            'Use `continue_delegate` with `mode: "post-compaction"` to dispatch working state — decisions',
            "in progress, task context, partial results — before compaction. The post-compaction shard fires",
            "when compaction happens and returns to re-inject context the summary cannot preserve.",
            "Fallback if the tool call fails: [[CONTINUE_DELEGATE: ... | post-compaction]] stages the same compaction-seam survival via the token form; [[CONTINUE_DELEGATE: ... | silent-wake]] is the timer/return fallback.",
          ]
        : [
            "Use [[CONTINUE_DELEGATE: ... | post-compaction]] to dispatch working state — decisions in progress,",
            "task context, partial results — that must survive the compaction seam; the token-form post-compaction directive stages the shard to fire at compaction (the same as the tool's mode='post-compaction').",
            "Use [[CONTINUE_DELEGATE: ... | silent-wake]] instead when a timer/return shard suffices rather than compaction-seam survival.",
            "These shards return after compaction and re-inject context that the summary cannot preserve.",
          ]),
      "",
      "Continuations are bounded: max chain length, cost cap, and min/max delay enforced by the gateway.",
      "",
    );
  }

  // Sub-agent chain-hop continuation — teach tool-primary when available, bracket fallback otherwise
  if (isMinimal && params.continuationEnabled) {
    lines.push("## Chain Delegation");
    if (availableTools.has("continue_delegate")) {
      lines.push(
        "Use the `continue_delegate` tool to dispatch follow-up sub-agents from this chain.",
        "The tool supports multi-delegate fan-out, structured parameters (`task`, `delaySeconds`, `mode`, `attachments`, `attachAs`),",
        "and `post-compaction` mode. The parent/main session stays free while your branch keeps working.",
        "",
        "Fallback bracket syntax (if the tool call fails or is unavailable):",
        "  [[CONTINUE_DELEGATE: task description]]",
        "  [[CONTINUE_DELEGATE: task +30s]]          — delayed spawn",
        "  [[CONTINUE_DELEGATE: task | silent]]       — silent return (no channel output)",
        "  [[CONTINUE_DELEGATE: task | silent-wake]]  — silent return + triggers parent turn",
        "  [[CONTINUE_DELEGATE: task | post-compaction]] — stage working-state survival across the compaction seam (fires at compaction)",
        "Bracket `[[CONTINUE_DELEGATE: ...]]` syntax cannot carry attachment blobs; reference an existing workspace file instead.",
        "",
        "Prefer the tool. Use brackets only as fallback.",
        "The gateway handles chain tracking and depth limits.",
        "",
      );
    } else {
      lines.push(
        "To dispatch a follow-up sub-agent from your output, end your ENTIRE response with:",
        "  [[CONTINUE_DELEGATE: task description]]",
        "",
        "Use this to keep a delegate tree moving without asking the parent to relay every hop.",
        "The parent/main session stays free while your branch keeps working.",
        "",
        "Optional modifiers:",
        "  [[CONTINUE_DELEGATE: task +30s]]          — delayed spawn",
        "  [[CONTINUE_DELEGATE: task | silent]]       — silent return (no channel output)",
        "  [[CONTINUE_DELEGATE: task | silent-wake]]  — silent return + triggers parent turn",
        "  [[CONTINUE_DELEGATE: task | post-compaction]] — stage working-state survival across the compaction seam (fires at compaction)",
        "Bracket `[[CONTINUE_DELEGATE: ...]]` syntax cannot carry attachment blobs; reference an existing workspace file instead.",
        "",
        "Use `| silent` when the result should only enrich the parent's future context.",
        "Use `| silent-wake` when the result should enrich the parent and wake it to act.",
        "",
        "Emit exactly ONE bracket per response. Do not nest brackets inside brackets.",
        "The gateway handles chain tracking and depth limits.",
        "",
      );
    }
  }
  return lines;
}
