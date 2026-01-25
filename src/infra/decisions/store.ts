import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

import type {
  CreateDecisionParams,
  DecisionOption,
  DecisionRecord,
  DecisionStore,
  RespondDecisionParams,
} from "./store.types.js";

const log = createSubsystemLogger("decisions");

function resolveDecisionStorePath(): string {
  return path.join(resolveStateDir(), "decisions", "store.json");
}

function loadDecisionStore(): DecisionStore {
  const storePath = resolveDecisionStorePath();
  try {
    if (!fs.existsSync(storePath)) {
      return { version: 1, decisions: {} };
    }
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as DecisionStore;
    return parsed;
  } catch (err) {
    log.warn("failed to load decision store", { error: String(err) });
    return { version: 1, decisions: {} };
  }
}

function saveDecisionStore(store: DecisionStore): void {
  const storePath = resolveDecisionStorePath();
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  store.updatedAt = Date.now();
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
}

function generateDecisionId(): string {
  return `D_${crypto.randomUUID().slice(0, 8)}`;
}

function buildOptions(
  type: CreateDecisionParams["type"],
  rawOptions?: CreateDecisionParams["options"],
): DecisionOption[] | undefined {
  if (type === "text") return undefined;

  if (type === "binary") {
    return [
      { id: "approve", label: "Approve", value: "approve", style: "primary" },
      { id: "reject", label: "Reject", value: "reject", style: "danger" },
    ];
  }

  if (type === "confirmation") {
    return [
      { id: "proceed", label: "Proceed", value: "proceed", style: "primary" },
      { id: "cancel", label: "Cancel", value: "cancel", style: "danger" },
    ];
  }

  // choice type
  if (!rawOptions || rawOptions.length === 0) {
    throw new Error("choice type requires at least one option");
  }

  return rawOptions.map((opt, idx) => ({
    id: opt.value || `opt_${idx}`,
    label: opt.label,
    value: opt.value || opt.label,
    style: opt.style,
  }));
}

export function createDecision(params: CreateDecisionParams): DecisionRecord {
  const store = loadDecisionStore();
  const now = Date.now();
  const timeoutMs = (params.timeoutMinutes ?? 30) * 60 * 1000;
  const expiresAt = timeoutMs > 0 ? now + timeoutMs : undefined;

  const decision: DecisionRecord = {
    decisionId: generateDecisionId(),
    type: params.type,
    status: "pending",
    title: params.title,
    question: params.question,
    options: buildOptions(params.type, params.options),
    context: params.context ?? {},
    createdAt: now,
    expiresAt,
  };

  store.decisions[decision.decisionId] = decision;
  saveDecisionStore(store);

  log.info("created decision", {
    decisionId: decision.decisionId,
    type: decision.type,
    title: decision.title,
  });

  return decision;
}

export function respondToDecision(params: RespondDecisionParams): DecisionRecord | null {
  const store = loadDecisionStore();
  const decision = store.decisions[params.decisionId];

  if (!decision) {
    log.warn("decision not found", { decisionId: params.decisionId });
    return null;
  }

  if (decision.status !== "pending") {
    log.warn("decision already resolved", {
      decisionId: params.decisionId,
      status: decision.status,
    });
    return decision;
  }

  const now = Date.now();
  if (decision.expiresAt && decision.expiresAt < now) {
    decision.status = "expired";
    saveDecisionStore(store);
    return decision;
  }

  decision.status = "responded";
  decision.respondedAt = now;
  decision.respondedBy = params.respondedBy;
  decision.response = {
    optionId: params.optionId,
    optionValue: params.optionValue,
    textValue: params.textValue,
  };

  saveDecisionStore(store);

  log.info("decision responded", {
    decisionId: decision.decisionId,
    respondedBy: params.respondedBy.userId,
    optionId: params.optionId,
    optionValue: params.optionValue,
  });

  return decision;
}

export function getDecision(decisionId: string): DecisionRecord | null {
  const store = loadDecisionStore();
  return store.decisions[decisionId] ?? null;
}

export function listDecisions(filter?: {
  status?: DecisionRecord["status"];
  agentId?: string;
  sessionKey?: string;
}): DecisionRecord[] {
  const store = loadDecisionStore();
  let decisions = Object.values(store.decisions);

  // Expire old pending decisions
  const now = Date.now();
  let needsSave = false;
  for (const d of decisions) {
    if (d.status === "pending" && d.expiresAt && d.expiresAt < now) {
      d.status = "expired";
      needsSave = true;
    }
  }
  if (needsSave) saveDecisionStore(store);

  if (filter?.status) {
    decisions = decisions.filter((d) => d.status === filter.status);
  }
  if (filter?.agentId) {
    decisions = decisions.filter((d) => d.context.agentId === filter.agentId);
  }
  if (filter?.sessionKey) {
    decisions = decisions.filter((d) => d.context.sessionKey === filter.sessionKey);
  }

  return decisions.sort((a, b) => b.createdAt - a.createdAt);
}

export function updateDecisionSlackInfo(
  decisionId: string,
  slackChannel: string,
  slackMessageTs: string,
): DecisionRecord | null {
  const store = loadDecisionStore();
  const decision = store.decisions[decisionId];

  if (!decision) return null;

  decision.slackChannel = slackChannel;
  decision.slackMessageTs = slackMessageTs;
  saveDecisionStore(store);

  return decision;
}

export function cleanupExpiredDecisions(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  const store = loadDecisionStore();
  const now = Date.now();
  let cleaned = 0;

  for (const [id, decision] of Object.entries(store.decisions)) {
    const age = now - decision.createdAt;
    if (age > maxAgeMs && decision.status !== "pending") {
      delete store.decisions[id];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    saveDecisionStore(store);
    log.info("cleaned up expired decisions", { count: cleaned });
  }

  return cleaned;
}
