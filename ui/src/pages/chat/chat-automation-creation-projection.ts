import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readAutomationCreationEvent,
  type AutomationCreationEvent,
  type AutomationCreationPlan,
  type AutomationCreationResult,
} from "../../../../src/shared/automation-creation.js";
import {
  AutomationCreationCardBlock,
  isLiveAutomationInjection,
  type AutomationCreationRow,
} from "../../lib/chat/automation-creation-card.ts";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { hasTerminalRunOutcome } from "./chat-assistant-reply.ts";
import { automationCreationToolEvents } from "./chat-created-automation-receipts.ts";
import { transcriptRunId } from "./chat-thread-run-identity.ts";

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

/** One card per declaration, anchored to its original assistant work even as later receipts arrive. */
export function projectAutomationCreationCards(
  history: readonly unknown[],
  live: readonly unknown[],
  firstSources?: Map<string, unknown>,
) {
  const declarations = new Map<string, Declared>();
  const outcomes = new Map<string, Map<string, AutomationCreationResult>>();
  const consumed = new Set<unknown>();
  const terminal = new Set<string>();
  const add = (
    scope: string,
    source: unknown,
    event: AutomationCreationEvent,
    fresh: boolean,
    runId?: string,
  ) => {
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
    let slots = outcomes.get(key);
    if (!slots) {
      slots = new Map();
      outcomes.set(key, slots);
    }
    // A retried add may succeed after a failure; a later duplicate/error cannot undo a persisted ID.
    const previous = slots.get(event.slotId);
    const outcome =
      !fresh && event.status === "created" ? { ...event, definition: undefined } : event;
    if (
      previous?.status !== "created" ||
      (outcome.status === "created" &&
        previous.jobId === outcome.jobId &&
        !previous.definition &&
        outcome.definition)
    ) {
      slots.set(event.slotId, outcome);
    }
  };
  for (const m of history) {
    const event = installerEvent(m);
    if (event) {
      add("installer", m, event, isLiveAutomationInjection(m));
      consumed.add(m);
    }
  }
  automationCreationToolEvents(
    live.length ? [...history, ...live] : history,
    (event, source, runId) => {
      if (runId) {
        add(
          "run:" + runId,
          source,
          event,
          asOptionalRecord(source)?.["__openclawToolStreamLive"] === true,
          runId,
        );
      }
    },
  );
  if (declarations.size) {
    for (const m of history) {
      const id = transcriptRunId(m);
      if (id && asOptionalRecord(m)?.role === "assistant" && hasTerminalRunOutcome(m, id)) {
        terminal.add(id);
      }
    }
  }
  const cards = new Map<unknown, MessageItem[]>();
  for (const [key, { plan, source, runId }] of declarations) {
    const saved = new Set<string>();
    const rows = plan.slots.map<AutomationCreationRow>((slot) => {
      const result = outcomes.get(key)?.get(slot.slotId);
      if (result?.status === "created" && !saved.has(result.jobId)) {
        saved.add(result.jobId);
        return {
          ...slot,
          status: "created",
          jobId: result.jobId,
          ...(result.definition ? { definition: result.definition } : {}),
        };
      }
      return { ...slot, status: result || (runId && terminal.has(runId)) ? "failed" : "pending" };
    });
    const item: MessageItem = {
      kind: "message",
      key,
      message: {
        role: "assistant",
        id: key,
        runId,
        timestamp: asOptionalRecord(source)?.timestamp,
        content: [new AutomationCreationCardBlock({ planId: plan.planId, rows })],
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
