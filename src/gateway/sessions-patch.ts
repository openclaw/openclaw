import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection.js";
import { resolvePlanApproval } from "../agents/plan-mode/index.js";
import { logPlanModeDebug } from "../agents/plan-mode/plan-mode-debug-log.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  resolveSupportedThinkingLevel,
} from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { normalizeExecTarget } from "../infra/exec-approvals.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  applyTraceOverride,
  applyVerboseOverride,
  parseTraceOverride,
  parseVerboseOverride,
} from "../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { normalizeSendPolicy } from "../sessions/send-policy.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  type ErrorCode,
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsPatchParams,
} from "./protocol/index.js";

function invalid(
  message: string,
  /**
   * Live-test iteration 1 Bug 3: optional override for the error code
   * + details payload. Defaults to `INVALID_REQUEST` (existing
   * behavior) so callers passing only `message` work unchanged.
   * Specific failures that the UI treats differently (e.g.
   * `PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS` triggers a bottom toast)
   * pass an explicit code so the client can branch on it.
   */
  code?: ErrorCode,
  details?: unknown,
): { ok: false; error: ErrorShape } {
  return {
    ok: false,
    error: errorShape(
      code ?? ErrorCodes.INVALID_REQUEST,
      message,
      details !== undefined ? { details } : {},
    ),
  };
}

function normalizeExecSecurity(raw: string): "deny" | "allowlist" | "full" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return undefined;
}

function normalizeExecAsk(raw: string): "off" | "on-miss" | "always" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return undefined;
}

function supportsSpawnLineage(storeKey: string): boolean {
  return isSubagentSessionKey(storeKey) || isAcpSessionKey(storeKey);
}

function normalizeSubagentRole(raw: string): "orchestrator" | "leaf" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "orchestrator" || normalized === "leaf") {
    return normalized;
  }
  return undefined;
}

function normalizeSubagentControlScope(raw: string): "children" | "none" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "children" || normalized === "none") {
    return normalized;
  }
  return undefined;
}

export async function applySessionsPatchToStore(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  storeKey: string;
  patch: SessionsPatchParams;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
}): Promise<{ ok: true; entry: SessionEntry } | { ok: false; error: ErrorShape }> {
  const { cfg, store, storeKey, patch } = params;
  const now = Date.now();
  const parsedAgent = parseAgentSessionKey(storeKey);
  const sessionAgentId = normalizeAgentId(parsedAgent?.agentId ?? resolveDefaultAgentId(cfg));
  const resolvedDefault = resolveDefaultModelForAgent({ cfg, agentId: sessionAgentId });
  const subagentModelHint = isSubagentSessionKey(storeKey)
    ? resolveSubagentConfiguredModelSelection({ cfg, agentId: sessionAgentId })
    : undefined;

  const existing = store[storeKey];
  const next: SessionEntry = existing
    ? {
        ...existing,
        updatedAt: Math.max(existing.updatedAt ?? 0, now),
      }
    : { sessionId: randomUUID(), updatedAt: now };

  if ("spawnedBy" in patch) {
    const raw = patch.spawnedBy;
    if (raw === null) {
      if (existing?.spawnedBy) {
        return invalid("spawnedBy cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid spawnedBy: empty");
      }
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("spawnedBy is only supported for subagent:* or acp:* sessions");
      }
      if (existing?.spawnedBy && existing.spawnedBy !== trimmed) {
        return invalid("spawnedBy cannot be changed once set");
      }
      next.spawnedBy = trimmed;
    }
  }

  if ("spawnedWorkspaceDir" in patch) {
    const raw = patch.spawnedWorkspaceDir;
    if (raw === null) {
      if (existing?.spawnedWorkspaceDir) {
        return invalid("spawnedWorkspaceDir cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("spawnedWorkspaceDir is only supported for subagent:* or acp:* sessions");
      }
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid spawnedWorkspaceDir: empty");
      }
      if (existing?.spawnedWorkspaceDir && existing.spawnedWorkspaceDir !== trimmed) {
        return invalid("spawnedWorkspaceDir cannot be changed once set");
      }
      next.spawnedWorkspaceDir = trimmed;
    }
  }

  if ("spawnDepth" in patch) {
    const raw = patch.spawnDepth;
    if (raw === null) {
      if (typeof existing?.spawnDepth === "number") {
        return invalid("spawnDepth cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("spawnDepth is only supported for subagent:* or acp:* sessions");
      }
      const numeric = raw;
      if (!Number.isInteger(numeric) || numeric < 0) {
        return invalid("invalid spawnDepth (use an integer >= 0)");
      }
      const normalized = numeric;
      if (typeof existing?.spawnDepth === "number" && existing.spawnDepth !== normalized) {
        return invalid("spawnDepth cannot be changed once set");
      }
      next.spawnDepth = normalized;
    }
  }

  if ("subagentRole" in patch) {
    const raw = patch.subagentRole;
    if (raw === null) {
      if (existing?.subagentRole) {
        return invalid("subagentRole cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("subagentRole is only supported for subagent:* or acp:* sessions");
      }
      const normalized = normalizeSubagentRole(raw);
      if (!normalized) {
        return invalid('invalid subagentRole (use "orchestrator" or "leaf")');
      }
      if (existing?.subagentRole && existing.subagentRole !== normalized) {
        return invalid("subagentRole cannot be changed once set");
      }
      next.subagentRole = normalized;
    }
  }

  if ("subagentControlScope" in patch) {
    const raw = patch.subagentControlScope;
    if (raw === null) {
      if (existing?.subagentControlScope) {
        return invalid("subagentControlScope cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("subagentControlScope is only supported for subagent:* or acp:* sessions");
      }
      const normalized = normalizeSubagentControlScope(raw);
      if (!normalized) {
        return invalid('invalid subagentControlScope (use "children" or "none")');
      }
      if (existing?.subagentControlScope && existing.subagentControlScope !== normalized) {
        return invalid("subagentControlScope cannot be changed once set");
      }
      next.subagentControlScope = normalized;
    }
  }

  if ("label" in patch) {
    const raw = patch.label;
    if (raw === null) {
      delete next.label;
    } else if (raw !== undefined) {
      const parsed = parseSessionLabel(raw);
      if (!parsed.ok) {
        return invalid(parsed.error);
      }
      for (const [key, entry] of Object.entries(store)) {
        if (key === storeKey) {
          continue;
        }
        if (entry?.label === parsed.label) {
          return invalid(`label already in use: ${parsed.label}`);
        }
      }
      next.label = parsed.label;
    }
  }

  if ("thinkingLevel" in patch) {
    const raw = patch.thinkingLevel;
    if (raw === null) {
      // Clear the override and fall back to model default
      delete next.thinkingLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeThinkLevel(raw);
      if (!normalized) {
        const hintProvider =
          normalizeOptionalString(existing?.providerOverride) || resolvedDefault.provider;
        const hintModel = normalizeOptionalString(existing?.modelOverride) || resolvedDefault.model;
        return invalid(
          `invalid thinkingLevel (use ${formatThinkingLevels(hintProvider, hintModel, "|")})`,
        );
      }
      next.thinkingLevel = normalized;
    }
  }

  if ("fastMode" in patch) {
    const raw = patch.fastMode;
    if (raw === null) {
      delete next.fastMode;
    } else if (raw !== undefined) {
      const normalized = normalizeFastMode(raw);
      if (normalized === undefined) {
        return invalid("invalid fastMode (use true or false)");
      }
      next.fastMode = normalized;
    }
  }

  if ("verboseLevel" in patch) {
    const raw = patch.verboseLevel;
    const parsed = parseVerboseOverride(raw);
    if (!parsed.ok) {
      return invalid(parsed.error);
    }
    applyVerboseOverride(next, parsed.value);
  }

  if ("traceLevel" in patch) {
    const raw = patch.traceLevel;
    const parsed = parseTraceOverride(raw);
    if (!parsed.ok) {
      return invalid(parsed.error);
    }
    applyTraceOverride(next, parsed.value);
  }

  if ("reasoningLevel" in patch) {
    const raw = patch.reasoningLevel;
    if (raw === null) {
      delete next.reasoningLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeReasoningLevel(raw);
      if (!normalized) {
        return invalid('invalid reasoningLevel (use "on"|"off"|"stream")');
      }
      // Persist "off" explicitly so that resolveDefaultReasoningLevel()
      // does not re-enable reasoning for capable models (#24406).
      next.reasoningLevel = normalized;
    }
  }

  if ("responseUsage" in patch) {
    const raw = patch.responseUsage;
    if (raw === null) {
      delete next.responseUsage;
    } else if (raw !== undefined) {
      const normalized = normalizeUsageDisplay(raw);
      if (!normalized) {
        return invalid('invalid responseUsage (use "off"|"tokens"|"full")');
      }
      if (normalized === "off") {
        delete next.responseUsage;
      } else {
        next.responseUsage = normalized;
      }
    }
  }

  if ("elevatedLevel" in patch) {
    const raw = patch.elevatedLevel;
    if (raw === null) {
      delete next.elevatedLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeElevatedLevel(raw);
      if (!normalized) {
        return invalid('invalid elevatedLevel (use "on"|"off"|"ask"|"full")');
      }
      // Persist "off" explicitly so patches can override defaults.
      next.elevatedLevel = normalized;
    }
  }

  if ("execHost" in patch) {
    const raw = patch.execHost;
    if (raw === null) {
      delete next.execHost;
    } else if (raw !== undefined) {
      const normalized = normalizeExecTarget(raw) ?? undefined;
      if (!normalized) {
        return invalid('invalid execHost (use "auto"|"sandbox"|"gateway"|"node")');
      }
      next.execHost = normalized;
    }
  }

  if ("execSecurity" in patch) {
    const raw = patch.execSecurity;
    if (raw === null) {
      delete next.execSecurity;
    } else if (raw !== undefined) {
      const normalized = normalizeExecSecurity(raw);
      if (!normalized) {
        return invalid('invalid execSecurity (use "deny"|"allowlist"|"full")');
      }
      next.execSecurity = normalized;
    }
  }

  if ("execAsk" in patch) {
    const raw = patch.execAsk;
    if (raw === null) {
      delete next.execAsk;
    } else if (raw !== undefined) {
      const normalized = normalizeExecAsk(raw);
      if (!normalized) {
        return invalid('invalid execAsk (use "off"|"on-miss"|"always")');
      }
      next.execAsk = normalized;
    }
  }

  if ("execNode" in patch) {
    const raw = patch.execNode;
    if (raw === null) {
      delete next.execNode;
    } else if (raw !== undefined) {
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid execNode: empty");
      }
      next.execNode = trimmed;
    }
  }

  // PR-8: plan-mode toggle. Wire-format only exposes the literal mode; the
  // server constructs the full PlanModeSessionState shape on transitions.
  // Gated on agents.defaults.planMode.enabled (Copilot P1 #67840
  // r3096735725 — the opt-in contract requires sessions.patch to refuse
  // arming the gate when the feature is off).
  if ("planMode" in patch) {
    const raw = patch.planMode;
    const planModeEnabled = cfg.agents?.defaults?.planMode?.enabled === true;
    // Live-test iteration 1 Bug 4: trace state transitions.
    if (raw !== undefined) {
      const fromMode = next.planMode?.mode ?? "normal";
      const toMode = raw === null ? "normal" : raw === "normal" || raw === "plan" ? raw : fromMode;
      if (fromMode !== toMode) {
        logPlanModeDebug({
          kind: "state_transition",
          sessionKey: storeKey,
          from: fromMode,
          to: toMode,
          trigger: "sessions.patch.planMode",
        });
      }
    }
    // "normal" / null clears state — always allowed (prevents getting
    // stranded in plan mode if the operator turns the feature off).
    if (raw === null || raw === "normal") {
      // PR-9 Wave B3: capture nudge job ids BEFORE deleting so the
      // cleanup helper can remove the corresponding crons. Fire-and-
      // forget — cleanup failures degrade to no-op (the nudges fire
      // into a normal-mode session and A1's `buildActivePlanNudge`
      // returns null).
      const previousNudgeIds = next.planMode?.nudgeJobIds;
      if (previousNudgeIds && previousNudgeIds.length > 0) {
        const ids = [...previousNudgeIds];
        void (async () => {
          try {
            const { cleanupPlanNudges } = await import("../agents/plan-mode/plan-nudge-crons.js");
            await cleanupPlanNudges({ jobIds: ids });
          } catch {
            /* best-effort */
          }
        })();
      }
      // PR-11 review fix (Codex P2 #3105134664): preserve
      // `lastPlanSteps` and `autoApprove` across the planMode→normal
      // transition. Pre-fix, /plan off (and any other normal-mode
      // toggle) erased the persisted plan snapshot — losing the
      // sidebar-recovery + audit trail. Operators expected to be able
      // to re-read the prior plan after toggling back to normal.
      const preservedPlanSteps = next.planMode?.lastPlanSteps;
      const preservedAutoApprove = next.planMode?.autoApprove === true;
      if (preservedPlanSteps?.length || preservedAutoApprove) {
        next.planMode = {
          mode: "normal",
          approval: "none",
          rejectionCount: 0,
          updatedAt: now,
          ...(preservedAutoApprove ? { autoApprove: true } : {}),
          ...(preservedPlanSteps?.length ? { lastPlanSteps: preservedPlanSteps } : {}),
        };
      } else {
        delete next.planMode;
      }
    } else if (raw === "plan") {
      if (!planModeEnabled) {
        return invalid(
          "plan mode is disabled — set `agents.defaults.planMode.enabled: true` to enable",
        );
      }
      const planNow = Date.now();
      if (next.planMode?.mode === "plan") {
        // Already in plan mode — refresh updatedAt but preserve approval state.
        next.planMode = { ...next.planMode, updatedAt: planNow };
      } else {
        // Fresh entry: clear any stale rejection history, reset to a clean
        // pending-nothing state. The agent calls exit_plan_mode to actually
        // submit a plan for approval; until then approval is "none".
        //
        // PR-10 auto-mode: if the user pre-armed auto-approve via
        // `/plan auto on` BEFORE entering plan mode, we materialized a
        // `mode: "normal"` placeholder entry with `autoApprove: true`.
        // Carry that flag forward into the fresh plan-mode entry so the
        // very first plan submission auto-approves as the user expects.
        // Without this, `/plan auto on` then `/plan on` silently loses
        // the flag (user-visible bug — review M3).
        const carryAutoApprove = next.planMode?.autoApprove === true;
        next.planMode = {
          mode: "plan",
          approval: "none",
          enteredAt: planNow,
          updatedAt: planNow,
          rejectionCount: 0,
          ...(carryAutoApprove ? { autoApprove: true } : {}),
        };
      }
    } else if (raw !== undefined) {
      return invalid('invalid planMode (use "plan"|"normal" or null)');
    }
  }

  // PR-8 follow-up: resolve a pending plan approval. The mode-toggle
  // pathway above handles user-driven enter/exit; this handles the
  // user clicking Approve/Reject/Edit on an approval card emitted by
  // `exit_plan_mode`. Goes through `resolvePlanApproval` from #67538
  // for the state-machine semantics (rejection cycle counter, terminal-
  // state guards, approvalId mismatch as no-op, etc.).
  if ("planApproval" in patch && patch.planApproval !== undefined) {
    const planModeEnabled = cfg.agents?.defaults?.planMode?.enabled === true;
    if (!planModeEnabled) {
      return invalid(
        "plan mode is disabled — set `agents.defaults.planMode.enabled: true` to enable",
      );
    }
    const action = patch.planApproval.action;
    // PR-10 ask_user_question: "answer" routes through the runtime as
    // a synthetic user message tagged [QUESTION_ANSWER]. It does NOT
    // transition planMode or use the resolvePlanApproval state machine.
    // Handled in the runtime (next-turn injection), not here — server
    // accepts the patch and lets the client know it's been recorded.
    if (action === "answer") {
      const answer = normalizeOptionalString(patch.planApproval.answer) || undefined;
      if (!answer) {
        return invalid('planApproval action="answer" requires `answer` text');
      }
      // PR-11 review fix (Codex P1 cluster #3105216364 / #3105247854 /
      // #3105261556): persist the synthetic `[QUESTION_ANSWER]: <text>`
      // injection on the SessionEntry so the runtime sees it on the
      // NEXT agent turn (regardless of which channel the
      // `/plan answer` came from). Single source of truth — replaces
      // the per-caller "inject via channel send" pattern that leaked
      // the marker into user-visible chat history.
      //
      // The `[QUESTION_ANSWER]:` marker (with COLON) matches the
      // canonical format documented in
      // `src/agents/tool-description-presets.ts` and used by the
      // webchat path at `ui/src/ui/app.ts:1118`.
      //
      // Mention-neutralize the answer before storing so an answer
      // containing `@channel`/`@here`/`@everyone` can't ping the
      // delivery channel when the synthetic message later renders.
      const safeAnswer = answer
        .replace(/@(channel|here|everyone)\b/gi, "@\u{FE6B}$1")
        .replace(/<@/g, "<\u{200B}@");
      next.pendingAgentInjection = `[QUESTION_ANSWER]: ${safeAnswer}`;
    } else if (action === "auto") {
      // PR-10 auto-mode toggle. Sets the session's autoApprove flag
      // without resolving any specific approval. When enabled, future
      // exit_plan_mode submissions auto-resolve as "approve" via the
      // autoApproveIfEnabled branch in
      // src/agents/pi-embedded-subscribe.handlers.tools.ts.
      //
      // PR-10 deep-dive review: require an explicit `autoEnabled`
      // boolean. A malformed patch (`{action:"auto"}` with the field
      // omitted) was previously coerced to `false` via
      // `=== true`, silently disabling auto-approve. That's a
      // surprising no-op; reject the patch instead so the client sees
      // a clear validation error.
      if (typeof patch.planApproval.autoEnabled !== "boolean") {
        return invalid('planApproval action="auto" requires `autoEnabled: boolean`');
      }
      const autoEnabled = patch.planApproval.autoEnabled;
      if (!next.planMode) {
        // No active plan-mode session — toggle is meaningful only when
        // plan mode is armed. Allow the toggle to be set in advance so
        // the next enter_plan_mode picks it up.
        next.planMode = {
          mode: "normal",
          approval: "none",
          rejectionCount: 0,
          updatedAt: now,
          autoApprove: autoEnabled,
        };
      } else {
        next.planMode = {
          ...next.planMode,
          autoApprove: autoEnabled,
          updatedAt: now,
        };
      }
    } else {
      // Existing approve/reject/edit path.
      if (!next.planMode) {
        return invalid("planApproval requires an active plan-mode session");
      }
      // PR-11 review fix (Copilot #3104741699): require a pending
      // approval before allowing approve/edit/reject. Pre-fix the
      // server accepted these actions even when planMode.approval was
      // "none" (e.g. session in plan mode but no plan submitted yet),
      // letting any client patch transition the session out of plan
      // mode without an actual approval round-trip.
      if (next.planMode.approval !== "pending") {
        return invalid(
          `planApproval action="${action}" requires a pending approval (current state: ${next.planMode.approval}); call exit_plan_mode first`,
        );
      }
      // Live-test iteration 1 Bug 3: approval-side subagent gate. The
      // tool-side gate at `exit-plan-mode-tool.ts:230` blocks the
      // submission when subagents are in flight at submission time,
      // but a NEW subagent spawned during the user's approval window
      // bypasses that check entirely — the agent's plan would proceed
      // with subagents still mid-flight, leading to mutations against
      // partial subagent results.
      //
      // Gate: when `approve` or `edit` is requested, look up the parent
      // run's ctx via `getAgentRunContext(approvalRunId)` and reject
      // if any subagents are still open. `reject` is NOT gated — the
      // user can reject regardless of subagent state (negative
      // feedback should always be accepted). The runId is captured by
      // the plan-snapshot-persister at exit_plan_mode time and
      // persisted on `planMode.approvalRunId`.
      if (action === "approve" || action === "edit") {
        const approvalRunId = (next.planMode as { approvalRunId?: string }).approvalRunId;
        if (approvalRunId) {
          const parentCtx = getAgentRunContext(approvalRunId);
          const open = parentCtx?.openSubagentRunIds;
          if (open && open.size > 0) {
            // Live-test iteration 1 Bug 4: log the gate rejection so
            // debug tail can correlate UI toast firings with server
            // gate decisions.
            logPlanModeDebug({
              kind: "approval_event",
              sessionKey: storeKey,
              action,
              openSubagentCount: open.size,
              result: "rejected_by_subagent_gate",
            });
            const ids = [...open].slice(0, 5).join(", ");
            const more = open.size > 5 ? ` and ${open.size - 5} more` : "";
            return invalid(
              `Cannot ${action} plan: ${open.size} subagent(s) you spawned during this ` +
                `plan-mode cycle are still running (${ids}${more}). Wait for their ` +
                `results to return before approving so the agent can incorporate them ` +
                `before executing.`,
              "PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS",
              { openSubagentRunIds: [...open] },
            );
          }
        }
      }
      const feedback = normalizeOptionalString(patch.planApproval.feedback) || undefined;
      const expectedApprovalId =
        normalizeOptionalString(patch.planApproval.approvalId) || undefined;
      const resolved = resolvePlanApproval(next.planMode, action, feedback, expectedApprovalId);
      // resolvePlanApproval returns the same reference when the action is
      // a no-op (stale approvalId, terminal-state guard, etc.). Detecting
      // this lets the client distinguish "applied" from "ignored" without
      // querying the resulting state shape.
      if (resolved === next.planMode) {
        return invalid(
          "planApproval ignored: stale approvalId or session is in a terminal approval state",
        );
      }
      next.planMode = { ...resolved, updatedAt: now };
      // PR-11 review fix (Codex P2 #3105311664 — escalation cluster):
      // stamp `recentlyApprovedAt` at SessionEntry ROOT on the
      // approve/edit transitions. This field SURVIVES the `planMode`
      // deletion below (mode → "normal" clears planMode entirely),
      // so downstream paths like
      // `resolveYieldDuringApprovedPlanInstruction` can detect
      // "just approved" within a grace window without depending on
      // `planMode.approval` (which is reset/cleared on transition).
      //
      // PR-11 review fix (Codex P1 #3105356737 / #3105389082): also
      // persist a `[PLAN_DECISION]: approved` synthetic-message
      // injection on the SessionEntry so the runtime sees it on the
      // NEXT agent turn — this is the same mechanism used for
      // `[QUESTION_ANSWER]:` (action="answer"). Single source of
      // truth: any caller of `sessions.patch { planApproval: action }`
      // gets the injection automatically without per-channel wiring.
      // Webchat continues to work via the existing direct injection
      // path; non-web channels (Telegram /plan accept etc.) get the
      // injection via this gateway-side path once PR-15 wires the
      // runtime consumer.
      if (action === "approve" || action === "edit") {
        next.recentlyApprovedAt = now;
        const decisionLabel = action === "approve" ? "approved" : "edited";
        next.pendingAgentInjection = `[PLAN_DECISION]: ${decisionLabel}`;
        // Live-test iteration 1 Bug 4: log the successful approval +
        // synthetic injection write. Pair-up with the rejection log
        // above so debug tail shows the full approval lifecycle.
        logPlanModeDebug({
          kind: "approval_event",
          sessionKey: storeKey,
          action,
          openSubagentCount: 0,
          result: "accepted",
        });
        logPlanModeDebug({
          kind: "synthetic_injection",
          sessionKey: storeKey,
          tag: "[PLAN_DECISION]",
          preview: decisionLabel,
        });
      } else if (action === "reject") {
        // On reject, agent stays in plan mode and revises.
        const safeFeedback = (feedback ?? "")
          .replace(/@(channel|here|everyone)\b/gi, "@\u{FE6B}$1")
          .replace(/<@/g, "<\u{200B}@");
        next.pendingAgentInjection = safeFeedback
          ? `[PLAN_DECISION]: rejected\nfeedback: ${safeFeedback}`
          : `[PLAN_DECISION]: rejected`;
      }
      // Approve / edit transition the mode to "normal" — the approval
      // resolution unlocks mutations. Clear the per-session planMode entry
      // so subsequent reads see no active plan state (matches the
      // sessions.patch { planMode: "normal" } semantics).
      if (next.planMode.mode === "normal") {
        // PR-12 Bug A1: clean up scheduled nudge crons on EVERY
        // plan-mode close path (was previously only fired in the
        // `raw === "normal"` branch above). Without this, every
        // approve/reject/edit cycle leaks 3 wake-up crons that fire
        // hours later as orphaned nudges interrupting unrelated work.
        // Capture the ids BEFORE we rewrite/delete the entry.
        const previousNudgeIds = next.planMode.nudgeJobIds;
        if (previousNudgeIds && previousNudgeIds.length > 0) {
          const ids = [...previousNudgeIds];
          void (async () => {
            try {
              const { cleanupPlanNudges } = await import("../agents/plan-mode/plan-nudge-crons.js");
              await cleanupPlanNudges({ jobIds: ids });
            } catch {
              /* best-effort */
            }
          })();
        }
        // PR-10 auto-mode: preserve `autoApprove` flag across the close
        // so the next enter_plan_mode keeps the toggle. Without this
        // the user would have to re-toggle every plan cycle.
        const preservedAutoApprove = next.planMode.autoApprove;
        if (preservedAutoApprove) {
          next.planMode = {
            mode: "normal",
            approval: "none",
            rejectionCount: 0,
            updatedAt: now,
            autoApprove: true,
            // Note: `nudgeJobIds` is NOT carried forward — they were
            // just cancelled above. The next enter_plan_mode will
            // schedule a fresh batch.
          };
        } else {
          delete next.planMode;
        }
      }
    }
  }

  // PR-8 follow-up: persist live plan-step snapshot from the runtime.
  // Written by `update_plan` after each call so the Control UI can
  // rebuild the live-plan sidebar after a hard refresh. Independent of
  // planMode/planApproval — the runtime may write `lastPlanSteps` in a
  // patch that doesn't touch either of those fields.
  //
  // We DO NOT clear `lastPlanSteps` when planMode is set to "normal" —
  // the user may want to view the prior plan even after toggling out
  // of plan mode. Only `/new` (sessions.reset) drops it.
  if ("lastPlanSteps" in patch && patch.lastPlanSteps !== undefined) {
    if (!Array.isArray(patch.lastPlanSteps)) {
      return invalid("lastPlanSteps must be an array");
    }
    if (!next.planMode) {
      // Materialize a minimal planMode entry so the snapshot has a home.
      // Keeps the schema invariant ("lastPlanSteps lives under planMode")
      // while supporting runtime writes that arrive before any explicit
      // planMode toggle (e.g., the agent calls update_plan in normal
      // mode — we still want the sidebar to render it).
      next.planMode = {
        mode: "normal",
        approval: "none",
        rejectionCount: 0,
        updatedAt: now,
      };
    }
    next.planMode = {
      ...next.planMode,
      lastPlanSteps: patch.lastPlanSteps.map((s) => ({
        step: s.step,
        status: s.status,
        ...(s.activeForm !== undefined ? { activeForm: s.activeForm } : {}),
        // PR-9 Wave B1 — persist optional closure-gate fields per step.
        ...(s.acceptanceCriteria !== undefined ? { acceptanceCriteria: s.acceptanceCriteria } : {}),
        ...(s.verifiedCriteria !== undefined ? { verifiedCriteria: s.verifiedCriteria } : {}),
      })),
      lastPlanUpdatedAt: now,
    };
  }

  if ("model" in patch) {
    const raw = patch.model;
    if (raw === null) {
      applyModelOverrideToSessionEntry({
        entry: next,
        selection: {
          provider: resolvedDefault.provider,
          model: resolvedDefault.model,
          isDefault: true,
        },
        markLiveSwitchPending: true,
      });
    } else if (raw !== undefined) {
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid model: empty");
      }
      if (!params.loadGatewayModelCatalog) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, "model catalog unavailable"),
        };
      }
      const catalog = await params.loadGatewayModelCatalog();
      const resolved = resolveAllowedModelRef({
        cfg,
        catalog,
        raw: trimmed,
        defaultProvider: resolvedDefault.provider,
        defaultModel: subagentModelHint ?? resolvedDefault.model,
      });
      if ("error" in resolved) {
        return invalid(resolved.error);
      }
      const isDefault =
        resolved.ref.provider === resolvedDefault.provider &&
        resolved.ref.model === resolvedDefault.model;
      applyModelOverrideToSessionEntry({
        entry: next,
        selection: {
          provider: resolved.ref.provider,
          model: resolved.ref.model,
          isDefault,
        },
        markLiveSwitchPending: true,
      });
    }
  }

  if (next.thinkingLevel) {
    const effectiveProvider = next.providerOverride ?? resolvedDefault.provider;
    const effectiveModel = next.modelOverride ?? resolvedDefault.model;
    const thinkingLevel = normalizeThinkLevel(next.thinkingLevel);
    if (!thinkingLevel) {
      delete next.thinkingLevel;
    } else if (
      !isThinkingLevelSupported({
        provider: effectiveProvider,
        model: effectiveModel,
        level: thinkingLevel,
      })
    ) {
      if ("thinkingLevel" in patch) {
        return invalid(
          `thinkingLevel "${thinkingLevel}" is not supported for ${effectiveProvider}/${effectiveModel} (use ${formatThinkingLevels(effectiveProvider, effectiveModel, "|")})`,
        );
      }
      next.thinkingLevel = resolveSupportedThinkingLevel({
        provider: effectiveProvider,
        model: effectiveModel,
        level: thinkingLevel,
      });
    }
  }

  if ("sendPolicy" in patch) {
    const raw = patch.sendPolicy;
    if (raw === null) {
      delete next.sendPolicy;
    } else if (raw !== undefined) {
      const normalized = normalizeSendPolicy(raw);
      if (!normalized) {
        return invalid('invalid sendPolicy (use "allow"|"deny")');
      }
      next.sendPolicy = normalized;
    }
  }

  if ("groupActivation" in patch) {
    const raw = patch.groupActivation;
    if (raw === null) {
      delete next.groupActivation;
    } else if (raw !== undefined) {
      const normalized = normalizeGroupActivation(raw);
      if (!normalized) {
        return invalid('invalid groupActivation (use "mention"|"always")');
      }
      next.groupActivation = normalized;
    }
  }

  store[storeKey] = next;
  return { ok: true, entry: next };
}
