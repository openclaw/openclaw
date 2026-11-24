import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readAutomationCreationEvent,
  type AutomationCreationEvent,
  type AutomationCreationPlan,
} from "../../../../src/shared/automation-creation.js";
import {
  AutomationCreationCardBlock,
  type AutomationCreationRow,
} from "../../lib/chat/automation-creation-card.ts";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { automationCreationToolEvents } from "./chat-created-automation-receipts.ts";

type MessageItem = Extract<ChatItem, { kind: "message" }>;
type Declared = { plan: AutomationCreationPlan; source: unknown; runId?: string };

/** The installer uses display-only assistant injections; never accept a plan from user/model text. */
function installerEvent(message: unknown) {
  const m = asOptionalRecord(message);
  return m?.role === "assistant" &&
    m.provider === "openclaw" &&
    m.model === "gateway-injected" &&
    Array.isArray(m.content) &&
    m.content.length === 1
    ? readAutomationCreationEvent(m.content[0])
    : undefined;
}

/** Show saved jobs at their declaration's original position in the assistant's work. */
export function projectAutomationCreationCards(
  history: readonly unknown[],
  live: readonly unknown[],
  firstSources?: Map<string, unknown>,
) {
  const declarations = new Map<string, Declared>();
  const savedSlots = new Map<string, Map<string, string>>();
  const consumed = new Set<unknown>();
  const add = (scope: string, source: unknown, event: AutomationCreationEvent, runId?: string) => {
    const key = "automation-creation:" + JSON.stringify([scope, event.planId]);
    // A newly loaded page can contain the missing declaration for a retained result.
    // Register both ends with the transcript's existing prepend collision guard.
    if (firstSources && !firstSources.has(key)) {
      firstSources.set(key, source);
    }
    if (event.type === "automation_creation_plan") {
      if (!declarations.has(key)) {
        declarations.set(key, { plan: event, source, runId });
      }
      return;
    }
    if (event.status !== "created") {
      return;
    }
    let slots = savedSlots.get(key);
    if (!slots) {
      slots = new Map();
      savedSlots.set(key, slots);
    }
    // A retry can fill a failed slot; a duplicate cannot replace a saved ID.
    if (!slots.has(event.slotId)) {
      slots.set(event.slotId, event.jobId);
    }
  };
  for (const m of history) {
    const event = installerEvent(m);
    if (event) {
      add("installer", m, event);
      consumed.add(m);
    }
  }
  automationCreationToolEvents(
    live.length ? [...history, ...live] : history,
    (event, source, runId) => {
      if (runId) {
        add("run:" + runId, source, event, runId);
      }
    },
  );
  const cards = new Map<unknown, MessageItem[]>();
  for (const [key, { plan, source, runId }] of declarations) {
    const slots = savedSlots.get(key);
    if (!slots) {
      continue;
    }
    const saved = new Set<string>();
    const rows: AutomationCreationRow[] = [];
    for (const slot of plan.slots) {
      const jobId = slots.get(slot.slotId);
      if (jobId && !saved.has(jobId)) {
        saved.add(jobId);
        rows.push({ ...slot, jobId });
      }
    }
    if (!rows.length) {
      continue;
    }
    const item: MessageItem = {
      kind: "message",
      key,
      message: {
        role: "assistant",
        id: key,
        runId,
        timestamp: asOptionalRecord(source)?.timestamp,
        content: [new AutomationCreationCardBlock({ grouped: plan.slots.length > 1, rows })],
      },
    };
    const existing = cards.get(source);
    if (existing) {
      existing.push(item);
    } else {
      cards.set(source, [item]);
    }
  }
  return { cards, consumed };
}
