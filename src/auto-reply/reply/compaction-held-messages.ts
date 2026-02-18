/**
 * Pure formatting helpers for the post-compaction held-messages feature (Issue #88/#90).
 *
 * Two payloads are produced when the verification gate is active:
 *  - User-facing: shows what was happening + accumulated held messages. No agent internals.
 *  - Agent context: freeze protocol + next actions + do-not-touch. Injected as system context,
 *    invisible to the user.
 *
 * Issue #90 additions:
 *  - buildTriagePrompt: stage-2 prompt shown after user acks (when held messages exist)
 *  - parseTriageResponse: parse user's triage decision into approved indices
 */

export type HeldMessage = {
  body: string;
  timestamp: number;
  senderId?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage-1: verification text (shown while gate is active)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the user-facing verification text shown during the compaction gate.
 *
 * Includes:
 *  - What the agent was doing (next actions + active tasks from context-transfer.json)
 *  - Pending decisions
 *  - Messages accumulated so far (Q1, Q2, ...)
 *  - CTA: "What should I do? Type 'ok' to resume."
 *
 * Does NOT include agent internals (do-not-touch, freeze protocol, etc).
 */
export function buildUserVerificationText(params: {
  contextData: Record<string, unknown> | null;
  heldMessages: HeldMessage[];
}): string {
  const { contextData, heldMessages } = params;
  const userLines: string[] = [];

  if (!contextData) {
    userLines.push("⚠️ I was compacting. (No context transfer summary available.)");
  } else {
    // What was happening (next actions + active tasks)
    const taskLines: string[] = [];

    const nextActions = Array.isArray(contextData.nextActions) ? contextData.nextActions : [];
    for (const item of nextActions) {
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const action = typeof rec.action === "string" ? rec.action : JSON.stringify(item);
        const p = typeof rec.priority === "number" ? `${String(rec.priority)}. ` : "• ";
        taskLines.push(`${p}${action}`);
      } else if (typeof item === "string") {
        taskLines.push(`• ${item}`);
      }
    }

    const activeTasks = Array.isArray(contextData.activeTasks) ? contextData.activeTasks : [];
    for (const task of activeTasks) {
      if (task && typeof task === "object") {
        const rec = task as Record<string, unknown>;
        const desc = typeof rec.description === "string" ? rec.description : JSON.stringify(task);
        const status = typeof rec.status === "string" ? ` [${rec.status}]` : "";
        taskLines.push(`• ${desc}${status}`);
      }
    }

    if (taskLines.length > 0) {
      userLines.push("⚠️ I was compacting. Here's what I think I was doing:");
      userLines.push(...taskLines);
    } else {
      userLines.push("⚠️ I was compacting.");
    }

    // Pending decisions (user-relevant, show these)
    const decisions = Array.isArray(contextData.pendingDecisions)
      ? contextData.pendingDecisions
      : [];
    if (decisions.length > 0) {
      userLines.push("\nPending decisions:");
      for (const d of decisions) {
        userLines.push(`• ${typeof d === "string" ? d : JSON.stringify(d)}`);
      }
    }
  }

  // Held messages
  if (heldMessages.length > 0) {
    userLines.push("\nMessages that came in while I was compacting:");
    heldMessages.forEach((msg, i) => {
      userLines.push(`[Q${i + 1}] ${msg.body}`);
    });
    userLines.push("\nWhat should I do? Type 'ok' to resume.");
  } else {
    userLines.push("\nType 'ok' to resume.");
  }

  return userLines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage-2: triage prompt + response parsing (Issue #90)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the stage-2 triage prompt shown after the user acks (when held messages exist).
 * Asks the user to decide which messages to handle.
 */
export function buildTriagePrompt(heldMessages: HeldMessage[]): string {
  if (heldMessages.length === 0) {
    return "";
  }
  const lines: string[] = ["✅ Resuming. Here are the queued messages — which should I handle?", ""];
  heldMessages.forEach((msg, i) => {
    lines.push(`[Q${i + 1}] ${msg.body}`);
  });
  lines.push("");
  lines.push(
    `Reply: "do Q1, Q3" / "do all" / "skip all" / or describe what you want.`,
  );
  return lines.join("\n");
}

/**
 * The result of parsing a user's triage response.
 *
 *  - "all"     → handle every held message
 *  - "none"    → discard all
 *  - "indices" → handle specific 0-indexed messages (from user's 1-indexed Qn notation)
 *  - "freeform"→ pass the user's full instruction to the agent with all messages as context
 */
export type TriageResult =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "indices"; approved: number[] }
  | { kind: "freeform"; instruction: string };

/** Patterns that mean "handle everything" (whole-text match). */
const ALL_PATTERNS = [
  /^do\s+all$/i,
  /^handle\s+all$/i,
  /^yes\s+all$/i,
  /^all\s+of\s+them$/i,
  /^everything$/i,
  /^all$/i,
];

/** Patterns that mean "discard everything" (whole-text match). */
const NONE_PATTERNS = [
  /^skip\s+all$/i,
  /^ignore\s+all$/i,
  /^none$/i,
  /^discard\s+all$/i,
  /^forget\s+(?:it\s+)?all$/i,
];

/**
 * Extract 1-indexed Q-numbers from text, e.g. "Q1, Q3" → [1, 3].
 */
function extractQNumbers(text: string): number[] {
  const matches = [...text.matchAll(/\bq(\d+)\b/gi)];
  const nums = matches.map((m) => parseInt(m[1], 10)).filter((n) => n >= 1);
  // Deduplicate and sort
  return [...new Set(nums)].sort((a, b) => a - b);
}

/**
 * A "structured" triage command is one whose text consists ONLY of:
 *   - An optional action verb (do / handle / process / run)
 *   - OR a skip verb (skip / ignore / exclude)
 *   - Q-number references (Q1, Q2, ...)
 *   - Connectors (and, or, comma)
 * Anything else is a freeform instruction.
 */
const STRUCTURED_DO_RE =
  /^(?:(?:do|handle|process|run)\s+)?(?:q\d+(?:\s*[,&]?\s*(?:and|or)?\s*q\d+)*)$/i;
const STRUCTURED_SKIP_RE =
  /^(?:skip|ignore|exclude)\s+(?:q\d+(?:\s*[,&]?\s*(?:and|or)?\s*q\d+)*)$/i;

/**
 * Parse the user's triage response into a TriageResult.
 *
 * @param response - Raw user reply to the triage prompt.
 * @param count    - Number of held messages (used to validate indices).
 */
export function parseTriageResponse(response: string, count: number): TriageResult {
  const normalized = response.trim();

  // "skip all" / "none" — exact whole-text match
  if (NONE_PATTERNS.some((p) => p.test(normalized))) {
    return { kind: "none" };
  }

  // "do all" / "all" — exact whole-text match
  if (ALL_PATTERNS.some((p) => p.test(normalized))) {
    return { kind: "all" };
  }

  const qNums = extractQNumbers(normalized);

  // "skip Q2" / "ignore Q1, Q3" — structured skip (strict pattern)
  if (STRUCTURED_SKIP_RE.test(normalized) && qNums.length > 0) {
    const allIndices = Array.from({ length: count }, (_, i) => i + 1);
    const skipSet = new Set(qNums);
    const approved = allIndices.filter((n) => !skipSet.has(n));
    if (approved.length === 0) {
      return { kind: "none" };
    }
    return { kind: "indices", approved: approved.map((n) => n - 1) };
  }

  // "do Q1, Q3" or bare "Q1, Q3" — structured approve (strict pattern)
  if (STRUCTURED_DO_RE.test(normalized) && qNums.length > 0) {
    const valid = qNums.filter((n) => n >= 1 && n <= count);
    if (valid.length > 0) {
      return { kind: "indices", approved: valid.map((n) => n - 1) };
    }
  }

  // Fallback: freeform instruction — pass everything to agent with user's words
  return { kind: "freeform", instruction: normalized };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent freeze context (injected invisibly after triage resolves)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the agent system context injected (invisibly) when the user types 'ok'.
 *
 * Includes the freeze protocol, next actions, do-not-touch items, and queued messages.
 * Returns empty string if there's nothing useful to inject.
 *
 * @param approvedMessages - When provided (after stage-2 triage), only these messages are
 *   included. When omitted, all heldMessages are included (pre-triage / no-held-messages path).
 * @param trageInstruction - Freeform triage instruction from user (if kind="freeform").
 */
export function buildAgentFreezeContext(params: {
  contextData: Record<string, unknown> | null;
  heldMessages: HeldMessage[];
  approvedMessages?: HeldMessage[];
  trageInstruction?: string;
}): string {
  const { contextData, heldMessages, approvedMessages, trageInstruction } = params;
  const messagesToInject = approvedMessages ?? heldMessages;

  if (!contextData && messagesToInject.length === 0 && !trageInstruction) {
    return "";
  }

  const agentLines: string[] = ["[POST-COMPACTION FREEZE PROTOCOL]"];
  agentLines.push("Do not process queued messages without explicit user approval.");

  if (contextData) {
    const nextActions = Array.isArray(contextData.nextActions) ? contextData.nextActions : [];
    if (nextActions.length > 0) {
      agentLines.push("\nNext actions:");
      for (const item of nextActions) {
        let action: string;
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          action = typeof rec.action === "string" ? rec.action : JSON.stringify(item);
        } else {
          action = String(item);
        }
        agentLines.push(`• ${action}`);
      }
    }

    const doNotTouch = Array.isArray(contextData.doNotTouch) ? contextData.doNotTouch : [];
    if (doNotTouch.length > 0) {
      agentLines.push("\nDo not touch:");
      for (const d of doNotTouch) {
        agentLines.push(`• ${typeof d === "string" ? d : JSON.stringify(d)}`);
      }
    }
  }

  if (trageInstruction) {
    // Freeform: inject all messages + user instruction
    agentLines.push("\nQueued messages (user provided freeform instruction):");
    heldMessages.forEach((msg, i) => {
      agentLines.push(`[Q${i + 1}] ${msg.body}`);
    });
    agentLines.push(`\nUser instruction: ${trageInstruction}`);
    agentLines.push(
      "\nFollow the user's instruction above — do not execute anything beyond what it requests.",
    );
  } else if (messagesToInject.length > 0) {
    agentLines.push("\nQueued messages (approved by user):");
    messagesToInject.forEach((msg, i) => {
      agentLines.push(`[Q${i + 1}] ${msg.body}`);
    });
    agentLines.push(
      "\nOnly act on items the user explicitly approves (e.g. 'do Q1 and Q3, skip Q2'). Unaddressed queued items are discarded — do not act on them.",
    );
  }

  return agentLines.join("\n");
}
