import type { GatewayBrowserClient } from "../gateway.ts";
import type { GatewaySessionRow } from "../types.ts";

export const WORKBOARD_STATUSES = [
  "backlog",
  "todo",
  "running",
  "review",
  "blocked",
  "done",
] as const;

export const WORKBOARD_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type WorkboardStatus = (typeof WORKBOARD_STATUSES)[number];
export type WorkboardPriority = (typeof WORKBOARD_PRIORITIES)[number];

export type WorkboardCard = {
  id: string;
  title: string;
  notes?: string;
  status: WorkboardStatus;
  priority: WorkboardPriority;
  labels: string[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  taskId?: string;
  sourceUrl?: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
};

export type WorkboardLifecycleState =
  | "unlinked"
  | "missing"
  | "idle"
  | "running"
  | "succeeded"
  | "failed";

export type WorkboardLifecycle = {
  session: GatewaySessionRow | null;
  state: WorkboardLifecycleState;
  targetStatus?: WorkboardStatus;
};

export type WorkboardUiState = {
  loading: boolean;
  loaded: boolean;
  loadAttempted: boolean;
  error: string | null;
  cards: WorkboardCard[];
  statuses: readonly WorkboardStatus[];
  query: string;
  priorityFilter: "all" | WorkboardPriority;
  draftOpen: boolean;
  draftTitle: string;
  draftNotes: string;
  draftPriority: WorkboardPriority;
  draftAgentId: string;
  draftSessionKey: string;
  busyCardId: string | null;
  draggedCardId: string | null;
  syncingCardIds: Set<string>;
};

type WorkboardHost = object;

const workboardStates = new WeakMap<WorkboardHost, WorkboardUiState>();

function createDefaultState(): WorkboardUiState {
  return {
    loading: false,
    loaded: false,
    loadAttempted: false,
    error: null,
    cards: [],
    statuses: WORKBOARD_STATUSES,
    query: "",
    priorityFilter: "all",
    draftOpen: false,
    draftTitle: "",
    draftNotes: "",
    draftPriority: "normal",
    draftAgentId: "",
    draftSessionKey: "",
    busyCardId: null,
    draggedCardId: null,
    syncingCardIds: new Set(),
  };
}

export function getWorkboardState(host: WorkboardHost): WorkboardUiState {
  let state = workboardStates.get(host);
  if (!state) {
    state = createDefaultState();
    workboardStates.set(host, state);
  }
  return state;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Unknown workboard error.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeCard(value: unknown): WorkboardCard | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id : "";
  const title = typeof value.title === "string" ? value.title : "";
  const status = WORKBOARD_STATUSES.includes(value.status as WorkboardStatus)
    ? (value.status as WorkboardStatus)
    : "todo";
  const priority = WORKBOARD_PRIORITIES.includes(value.priority as WorkboardPriority)
    ? (value.priority as WorkboardPriority)
    : "normal";
  if (!id || !title) {
    return null;
  }
  return {
    id,
    title,
    status,
    priority,
    labels: Array.isArray(value.labels)
      ? value.labels.filter((label): label is string => typeof label === "string")
      : [],
    position: typeof value.position === "number" ? value.position : 0,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
    ...(typeof value.sourceUrl === "string" ? { sourceUrl: value.sourceUrl } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === "number" ? { completedAt: value.completedAt } : {}),
  };
}

function normalizeCardsPayload(payload: unknown): {
  cards: WorkboardCard[];
  statuses: readonly WorkboardStatus[];
} {
  if (!isRecord(payload)) {
    return { cards: [], statuses: WORKBOARD_STATUSES };
  }
  const cards = Array.isArray(payload.cards)
    ? payload.cards.map(normalizeCard).filter((card): card is WorkboardCard => card !== null)
    : [];
  const statuses = Array.isArray(payload.statuses)
    ? payload.statuses.filter((status): status is WorkboardStatus =>
        WORKBOARD_STATUSES.includes(status as WorkboardStatus),
      )
    : WORKBOARD_STATUSES;
  return { cards, statuses: statuses.length ? statuses : WORKBOARD_STATUSES };
}

function normalizeCardPayload(payload: unknown): WorkboardCard {
  const card = isRecord(payload) ? normalizeCard(payload.card) : null;
  if (!card) {
    throw new Error("workboard response did not include a card");
  }
  return card;
}

export async function loadWorkboard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  force?: boolean;
}) {
  const state = getWorkboardState(params.host);
  if (!params.client || state.loading || (!params.force && (state.loaded || state.loadAttempted))) {
    return;
  }
  state.loadAttempted = true;
  state.loading = true;
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.list", {});
    const normalized = normalizeCardsPayload(payload);
    state.cards = normalized.cards;
    state.statuses = normalized.statuses;
    state.loaded = true;
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.loading = false;
    params.requestUpdate?.();
  }
}

function replaceCard(state: WorkboardUiState, card: WorkboardCard) {
  const next = state.cards.filter((existing) => existing.id !== card.id);
  next.push(card);
  state.cards = next.toSorted((left, right) => left.position - right.position);
}

function isFailedSessionStatus(status: GatewaySessionRow["status"]): boolean {
  return status === "failed" || status === "killed" || status === "timeout";
}

export function getWorkboardLifecycle(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
): WorkboardLifecycle {
  const session = findWorkboardSession(card, sessions);
  if (!card.sessionKey) {
    return { session: null, state: "unlinked" };
  }
  if (!session) {
    return { session: null, state: "missing" };
  }
  if (session.hasActiveRun === true || session.status === "running") {
    return { session, state: "running", targetStatus: "running" };
  }
  if (session.abortedLastRun || isFailedSessionStatus(session.status)) {
    return { session, state: "failed", targetStatus: "blocked" };
  }
  if (session.status === "done") {
    return { session, state: "succeeded", targetStatus: "review" };
  }
  return { session, state: "idle" };
}

function shouldSyncCardStatus(card: WorkboardCard, targetStatus: WorkboardStatus | undefined) {
  if (!targetStatus || card.status === targetStatus) {
    return false;
  }
  if (targetStatus === "running") {
    return card.status === "backlog" || card.status === "todo";
  }
  if (targetStatus === "blocked" || targetStatus === "review") {
    return card.status === "running" || card.status === "todo";
  }
  return false;
}

function lifecycleSyncKey(card: WorkboardCard, lifecycle: WorkboardLifecycle): string {
  const session = lifecycle.session;
  return [
    card.id,
    card.status,
    card.updatedAt,
    lifecycle.targetStatus ?? "",
    session?.status ?? "",
    session?.hasActiveRun === true ? "active" : "idle",
    session?.updatedAt ?? "",
  ].join(":");
}

const lifecycleSyncKeys = new WeakMap<WorkboardHost, Map<string, string>>();

function getLifecycleSyncKeys(host: WorkboardHost): Map<string, string> {
  let keys = lifecycleSyncKeys.get(host);
  if (!keys) {
    keys = new Map();
    lifecycleSyncKeys.set(host, keys);
  }
  return keys;
}

export async function syncWorkboardLifecycle(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  sessions: readonly GatewaySessionRow[];
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (!params.client || !state.loaded) {
    return;
  }
  const syncKeys = getLifecycleSyncKeys(params.host);
  for (const card of state.cards) {
    const lifecycle = getWorkboardLifecycle(card, params.sessions);
    if (!shouldSyncCardStatus(card, lifecycle.targetStatus)) {
      continue;
    }
    const key = lifecycleSyncKey(card, lifecycle);
    if (syncKeys.get(card.id) === key || state.syncingCardIds.has(card.id)) {
      continue;
    }
    state.syncingCardIds.add(card.id);
    params.requestUpdate?.();
    try {
      const payload = await params.client.request("workboard.cards.update", {
        id: card.id,
        patch: { status: lifecycle.targetStatus },
      });
      replaceCard(state, normalizeCardPayload(payload));
      syncKeys.set(card.id, key);
    } catch (error) {
      state.error = formatError(error);
      syncKeys.set(card.id, key);
    } finally {
      state.syncingCardIds.delete(card.id);
      params.requestUpdate?.();
    }
  }
}

export async function createWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (!params.client || !state.draftTitle.trim()) {
    return;
  }
  state.loading = true;
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.create", {
      title: state.draftTitle,
      notes: state.draftNotes,
      priority: state.draftPriority,
      agentId: state.draftAgentId,
      sessionKey: state.draftSessionKey,
    });
    replaceCard(state, normalizeCardPayload(payload));
    state.draftOpen = false;
    state.draftTitle = "";
    state.draftNotes = "";
    state.draftPriority = "normal";
    state.draftAgentId = "";
    state.draftSessionKey = "";
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.loading = false;
    params.requestUpdate?.();
  }
}

export async function moveWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  status: WorkboardStatus;
  position: number;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (!params.client) {
    return;
  }
  state.busyCardId = params.cardId;
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.move", {
      id: params.cardId,
      status: params.status,
      position: params.position,
    });
    replaceCard(state, normalizeCardPayload(payload));
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardId = null;
    state.draggedCardId = null;
    params.requestUpdate?.();
  }
}

export async function deleteWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (!params.client) {
    return;
  }
  state.busyCardId = params.cardId;
  state.error = null;
  params.requestUpdate?.();
  try {
    await params.client.request("workboard.cards.delete", { id: params.cardId });
    state.cards = state.cards.filter((card) => card.id !== params.cardId);
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardId = null;
    params.requestUpdate?.();
  }
}

function buildCardPrompt(card: WorkboardCard): string {
  const lines = [`Work on this OpenClaw Workboard card: ${card.title}`];
  if (card.notes?.trim()) {
    lines.push("", card.notes.trim());
  }
  if (card.labels.length > 0) {
    lines.push("", `Labels: ${card.labels.join(", ")}`);
  }
  lines.push("", "When done, summarize what changed and what remains.");
  return lines.join("\n");
}

export async function startWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  card: WorkboardCard;
  requestUpdate?: () => void;
}): Promise<string | null> {
  const state = getWorkboardState(params.host);
  if (!params.client) {
    return null;
  }
  state.busyCardId = params.card.id;
  state.error = null;
  params.requestUpdate?.();
  try {
    const created = await params.client.request("sessions.create", {
      ...(params.card.agentId ? { agentId: params.card.agentId } : {}),
      label: params.card.title,
      message: buildCardPrompt(params.card),
    });
    const sessionKey =
      isRecord(created) && typeof created.key === "string" && created.key.trim()
        ? created.key.trim()
        : null;
    const runId =
      isRecord(created) && typeof created.runId === "string" && created.runId.trim()
        ? created.runId.trim()
        : undefined;
    const payload = await params.client.request("workboard.cards.update", {
      id: params.card.id,
      patch: {
        status: "running",
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
      },
    });
    replaceCard(state, normalizeCardPayload(payload));
    return sessionKey;
  } catch (error) {
    state.error = formatError(error);
    return null;
  } finally {
    state.busyCardId = null;
    params.requestUpdate?.();
  }
}

export async function stopWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  card: WorkboardCard;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (!params.client || !params.card.sessionKey) {
    return;
  }
  state.busyCardId = params.card.id;
  state.error = null;
  params.requestUpdate?.();
  try {
    const abortResult = await params.client.request("chat.abort", {
      sessionKey: params.card.sessionKey,
    });
    const aborted =
      isRecord(abortResult) &&
      (abortResult.aborted === true ||
        (Array.isArray(abortResult.runIds) && abortResult.runIds.length > 0));
    if (!aborted) {
      return;
    }
    const payload = await params.client.request("workboard.cards.update", {
      id: params.card.id,
      patch: { status: "blocked" },
    });
    replaceCard(state, normalizeCardPayload(payload));
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardId = null;
    params.requestUpdate?.();
  }
}

export function findWorkboardSession(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
): GatewaySessionRow | null {
  if (!card.sessionKey) {
    return null;
  }
  return sessions.find((session) => session.key === card.sessionKey) ?? null;
}
