/**
 * Pure formatting helpers for the post-compaction held-messages feature (Issue #88).
 *
 * Two payloads are produced when the verification gate is active:
 *  - User-facing: shows what was happening + accumulated held messages. No agent internals.
 *  - Agent context: freeze protocol + next actions + do-not-touch. Injected as system context,
 *    invisible to the user.
 */

export type HeldMessage = {
  body: string;
  timestamp: number;
  senderId?: string;
};

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

/**
 * Build the agent system context injected (invisibly) when the user types 'ok'.
 *
 * Includes the freeze protocol, next actions, do-not-touch items, and queued messages.
 * Returns empty string if there's nothing useful to inject.
 */
export function buildAgentFreezeContext(params: {
  contextData: Record<string, unknown> | null;
  heldMessages: HeldMessage[];
}): string {
  const { contextData, heldMessages } = params;

  if (!contextData && heldMessages.length === 0) {
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

  if (heldMessages.length > 0) {
    agentLines.push("\nQueued messages (awaiting user triage):");
    heldMessages.forEach((msg, i) => {
      agentLines.push(`[Q${i + 1}] ${msg.body}`);
    });
    agentLines.push(
      "\nOnly act on items the user explicitly approves (e.g. 'do Q1 and Q3, skip Q2'). Unaddressed queued items are discarded — do not act on them.",
    );
  }

  return agentLines.join("\n");
}
