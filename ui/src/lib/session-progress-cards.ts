import type {
  ProgressCard,
  ProgressCardGetParams,
  ProgressCardGetResult,
  ProgressCardPutResult,
  ProgressCardRefreshParams,
  ProgressCardRefreshResult,
  ProgressCardStep,
} from "@openclaw/gateway-protocol";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../api/gateway.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createGatewayConnectionLifecycle } from "./gateway-connection-lifecycle.ts";
import { readSessionChangedEvent } from "./sessions/reconcile.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConversationIdentity,
  scopedSessionArtifactKey,
  uiSessionEventMatches,
  type UiSessionDefaultsHost,
} from "./sessions/session-key.ts";
import { generateUUID } from "./uuid.ts";

const PROGRESS_CARD_GET_METHOD = "progressCard.get";
const PROGRESS_CARD_PUT_METHOD = "progressCard.put";
const PROGRESS_CARD_CHANGED_EVENT = "progressCard.changed";
const CACHE_LIMIT = 100;
const REFRESH_TIMEOUT_MS = 120_000;

export type SessionProgressCardRefreshState = "pending" | "failed" | "timeout" | "updated";

type ProgressCardRefresh = {
  state: SessionProgressCardRefreshState;
  idempotencyKey: string;
  baseline: number;
  accepted: boolean;
  retryNewIntent?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

type ProgressCardEntry = {
  target: ProgressCardGetParams;
  wireKey: string;
  generation: number;
  dirty: boolean;
  card?: ProgressCard | null;
  error?: SessionProgressCardLoadError;
  load?: Promise<ProgressCard | null>;
  refresh?: ProgressCardRefresh;
};

type SessionProgressCardLoadError = "access-denied" | "unavailable";

type ProgressCardWatchOptions = {
  /** Gates automatic reads only; inactive watches still retain and invalidate their cache. */
  admitAutomaticRead?: () => boolean;
};

export type SessionProgressCardStore = {
  watch: (
    owner: object,
    targets: readonly ProgressCardGetParams[],
    options?: ProgressCardWatchOptions,
  ) => void;
  unwatch: (owner: object) => void;
  load: (target: ProgressCardGetParams) => Promise<ProgressCard | null>;
  dismiss: (target: ProgressCardGetParams, card: ProgressCard) => Promise<boolean>;
  refresh: (target: ProgressCardGetParams, card: ProgressCard) => void;
  getRefreshState: (target: ProgressCardGetParams) => SessionProgressCardRefreshState | undefined;
  get: (target: ProgressCardGetParams) => ProgressCard | null | undefined;
  getLifetime: (target: ProgressCardGetParams) => object | undefined;
  getError: (target: ProgressCardGetParams) => SessionProgressCardLoadError | undefined;
  subscribe: (listener: () => void) => () => void;
};

const stores = new WeakMap<ApplicationGateway, SessionProgressCardStore>();

function parseProgressCardStep(value: unknown): ProgressCardStep | null {
  if (!isRecord(value) || typeof value.step !== "string") {
    return null;
  }
  if (
    value.status !== "pending" &&
    value.status !== "in_progress" &&
    value.status !== "completed"
  ) {
    return null;
  }
  return { status: value.status, step: value.step };
}

function parseProgressCard(value: unknown, sessionKey: string): ProgressCard | null {
  if (!isRecord(value)) {
    throw new Error("Progress card response was invalid");
  }
  const card = value.card;
  if (card === null) {
    return null;
  }
  if (!isRecord(card)) {
    throw new Error("Progress card response was invalid");
  }
  const markdown = card.markdown;
  const revision = card.revision;
  const updatedAt = asDateTimestampMs(card.updatedAt);
  const rawSteps = card.steps;
  if (
    card.sessionKey !== sessionKey ||
    (markdown !== undefined && typeof markdown !== "string") ||
    (rawSteps !== undefined && !Array.isArray(rawSteps)) ||
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    updatedAt === undefined ||
    !Number.isInteger(updatedAt)
  ) {
    throw new Error("Progress card response did not match the requested session");
  }
  const steps = Array.isArray(rawSteps) ? rawSteps.map(parseProgressCardStep) : undefined;
  if (steps?.some((step) => step === null)) {
    throw new Error("Progress card response contained invalid steps");
  }
  const parsedSteps = steps?.filter((step) => step !== null);
  if (markdown === undefined && (!parsedSteps || parsedSteps.length === 0)) {
    throw new Error("Progress card response contained no content");
  }
  return {
    sessionKey,
    revision,
    updatedAt,
    ...(markdown !== undefined ? { markdown } : {}),
    ...(parsedSteps && parsedSteps.length > 0 ? { steps: parsedSteps } : {}),
  };
}

// Progress follows store routing: sentinels stay bare; other keys use the captured
// owner, which generic UI identity otherwise drops for ordinary bare keys.
export function resolveSessionProgressCardTarget(
  host: UiSessionDefaultsHost,
  target: ProgressCardGetParams,
): ProgressCardGetParams {
  const agentId = target.agentId?.trim() ? normalizeAgentId(target.agentId) : undefined;
  const key = target.sessionKey.trim();
  const sentinel = key.toLowerCase();
  return {
    ...(agentId ? { agentId } : {}),
    ...resolveUiConversationIdentity(
      host,
      sentinel === "global" || sentinel === "unknown"
        ? sentinel
        : scopedSessionArtifactKey(key, agentId),
      agentId,
    ),
  };
}

function progressCardRequestTarget(target: ProgressCardGetParams): ProgressCardGetParams {
  // Qualified keys already own their session. Explicit agentId additionally requires
  // a configured agent, so retain the current key-only request contract for those rows.
  return parseAgentSessionKey(target.sessionKey) ? { sessionKey: target.sessionKey } : target;
}

function createStore(gateway: ApplicationGateway): SessionProgressCardStore {
  const watchedByOwner = new Map<
    object,
    ProgressCardWatchOptions & { targets: readonly ProgressCardGetParams[] }
  >();
  const entries = new Map<string, ProgressCardEntry>();
  // Presentation outlives evictable snapshots and idle watches. Only confirmed
  // absence ends a card; revisions and temporary loss of access do not.
  const lifetimes = new Map<string, { target: ProgressCardGetParams; token: object }>();
  let presentationScope = gatewayPresentationScope(gateway);
  const syncLifetimeScope = () => {
    const scope = gatewayPresentationScope(gateway);
    if (scope !== presentationScope) {
      presentationScope = scope;
      lifetimes.clear();
    }
  };
  const acceptLifetime = (
    key: string,
    target: ProgressCardGetParams,
    card: ProgressCard | null,
  ) => {
    syncLifetimeScope();
    if (!card) {
      lifetimes.delete(key);
    } else if (!lifetimes.has(key)) {
      lifetimes.set(key, { target, token: {} });
    }
  };
  const listeners = new Set<() => void>();
  const connection = createGatewayConnectionLifecycle(gateway.snapshot);
  let knownClient = gateway.snapshot.client;
  let knownAvailable = false;
  let stopGatewaySnapshots: (() => void) | null = null;
  let stopGatewayEvents: (() => void) | null = null;

  const resolveTarget = (target: ProgressCardGetParams) => {
    const canonical = resolveSessionProgressCardTarget(gateway.snapshot, target);
    return {
      target: canonical,
      key: JSON.stringify([canonical.agentId ?? null, canonical.sessionKey]),
      wireKey: scopedSessionArtifactKey(canonical.sessionKey, canonical.agentId),
    };
  };
  const watchedTargets = (admittedOnly = false) =>
    new Map(
      Array.from(watchedByOwner.values())
        .filter((registration) => !admittedOnly || registration.admitAutomaticRead?.() !== false)
        .flatMap(({ targets }) =>
          targets.map((target) => {
            const resolved = resolveTarget(target);
            return [resolved.key, resolved.target] as const;
          }),
        ),
    );
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const retireRefresh = (entry: ProgressCardEntry) => {
    clearTimeout(entry.refresh?.timer);
    delete entry.refresh;
  };
  const reconcileRefresh = (entry: ProgressCardEntry) => {
    const refresh = entry.refresh;
    if (refresh?.accepted && entry.card && entry.card.revision > refresh.baseline) {
      clearTimeout(refresh.timer);
      refresh.state = "updated";
    }
  };
  const recordRequestError = (entry: ProgressCardEntry, error: unknown) => {
    const accessDenied =
      error instanceof GatewayRequestError &&
      isRecord(error.details) &&
      error.details.code === "SESSION_PARTICIPATION_REQUIRED";
    entry.error = accessDenied ? "access-denied" : "unavailable";
    entry.dirty = true;
    if (accessDenied) {
      entry.card = null;
    }
    notify();
  };
  const remember = (key: string, entry: ProgressCardEntry) => {
    entries.delete(key);
    entries.set(key, entry);
    const watched = watchedTargets();
    while (entries.size > CACHE_LIMIT) {
      const oldest = [...entries].find(
        ([candidate, value]) =>
          !watched.has(candidate) && !value.load && value.refresh?.state !== "pending",
      );
      if (!oldest) {
        break;
      }
      retireRefresh(oldest[1]);
      entries.delete(oldest[0]);
    }
  };
  const available = () =>
    gateway.snapshot.phase === "connected" && gateway.snapshot.client !== null;

  const load = async (target: ProgressCardGetParams): Promise<ProgressCard | null> => {
    const resolved = resolveTarget(target);
    if (!resolved.target.sessionKey || !available()) {
      return null;
    }
    const entry: ProgressCardEntry = entries.get(resolved.key) ?? {
      target: resolved.target,
      wireKey: resolved.wireKey,
      generation: 0,
      dirty: true,
    };
    remember(resolved.key, entry);
    if (!entry.dirty && entry.card !== undefined) {
      return entry.card;
    }
    if (entry.load) {
      return entry.load;
    }
    connection.transition(gateway.snapshot);
    const scope = connection.capture();
    if (!scope) {
      return null;
    }
    const generation = entry.generation;
    const current = () =>
      entries.get(resolved.key) === entry &&
      entry.generation === generation &&
      connection.isCurrent(scope) &&
      gateway.snapshot.client === scope.client;
    const request = scope.client
      .request<ProgressCardGetResult>(
        PROGRESS_CARD_GET_METHOD,
        progressCardRequestTarget(entry.target),
      )
      .then((response) => {
        const card = parseProgressCard(response, entry.wireKey);
        if (!current()) {
          return null;
        }
        entry.card = card;
        acceptLifetime(resolved.key, entry.target, card);
        entry.dirty = false;
        delete entry.error;
        reconcileRefresh(entry);
        notify();
        return card;
      })
      .catch((error: unknown) => {
        if (current()) {
          recordRequestError(entry, error);
        }
        throw error;
      })
      .finally(() => {
        if (entry.load === request) {
          delete entry.load;
          if (entries.get(resolved.key) === entry) {
            remember(resolved.key, entry);
            // Invalidations survive a hidden watch that resumes before this read settles.
            if (entry.generation !== generation && watchedTargets(true).has(resolved.key)) {
              void load(entry.target).catch(() => undefined);
            }
          }
        }
      });
    entry.load = request;
    remember(resolved.key, entry);
    return request;
  };
  const refreshWatched = () => {
    for (const target of watchedTargets(true).values()) {
      void load(target).catch(() => undefined);
    }
  };
  const handleGatewaySnapshot = (snapshot: ApplicationGateway["snapshot"]) => {
    if (connection.transition(snapshot)) {
      for (const entry of entries.values()) {
        retireRefresh(entry);
      }
      notify();
    }
    const clientChanged = snapshot.client !== knownClient;
    const nextAvailable = available();
    const becameAvailable = nextAvailable && !knownAvailable;
    if (!nextAvailable && knownAvailable) {
      // Automatic reconnect reuses the client. Retire its reads, but retain presentation.
      for (const entry of entries.values()) {
        entry.dirty = true;
        delete entry.load;
      }
    }
    knownAvailable = nextAvailable;
    if (!clientChanged && !becameAvailable) {
      return;
    }
    if (clientChanged) {
      knownClient = snapshot.client;
      entries.clear();
      lifetimes.clear();
      notify();
    }
    refreshWatched();
  };
  const handleGatewayEvent: Parameters<ApplicationGateway["subscribeEvents"]>[0] = (event) => {
    if (event.event === "sessions.changed" && isRecord(event.payload)) {
      if (event.payload.reason !== "reset" && event.payload.reason !== "delete") {
        return;
      }
      const changed = readSessionChangedEvent(event.payload);
      if (!changed) {
        return;
      }
      for (const [key, { target }] of lifetimes) {
        if (
          uiSessionEventMatches(
            {
              hello: gateway.snapshot.hello,
              assistantAgentId: target.agentId,
              sessionKey: target.sessionKey,
            },
            changed.key,
            changed.agentId,
          )
        ) {
          lifetimes.delete(key);
        }
      }
      let removed = false;
      for (const [key, entry] of entries) {
        if (
          uiSessionEventMatches(
            {
              hello: gateway.snapshot.hello,
              assistantAgentId: entry.target.agentId,
              sessionKey: entry.target.sessionKey,
            },
            changed.key,
            changed.agentId,
          )
        ) {
          retireRefresh(entry);
          entries.delete(key);
          removed = true;
        }
      }
      if (removed) {
        notify();
      }
      refreshWatched();
      return;
    }
    if (event.event !== PROGRESS_CARD_CHANGED_EVENT || !isRecord(event.payload)) {
      return;
    }
    const { sessionKey, revision } = event.payload;
    if (
      typeof sessionKey !== "string" ||
      (revision !== null && (typeof revision !== "number" || !Number.isInteger(revision)))
    ) {
      return;
    }
    const watched = watchedTargets(true);
    // Loading rewrites LRU order, so capture the matching entries before starting requests.
    const matching = [...entries].filter(([, entry]) => entry.wireKey === sessionKey);
    for (const [key, entry] of matching) {
      // Distinct canonical rows can share a wire key. Even a null revision is
      // only a refresh hint; the captured owner request alone may clear a card.
      entry.generation += 1;
      entry.dirty = true;
      delete entry.error;
      if (!entry.load && watched.has(key)) {
        void load(entry.target).catch(() => undefined);
      }
    }
  };
  const attach = () => {
    if (stopGatewaySnapshots || stopGatewayEvents) {
      return;
    }
    connection.transition(gateway.snapshot);
    if (gateway.snapshot.client !== knownClient) {
      knownClient = gateway.snapshot.client;
      entries.clear();
      lifetimes.clear();
    }
    knownAvailable = available();
    stopGatewaySnapshots = gateway.subscribe(handleGatewaySnapshot);
    stopGatewayEvents = gateway.subscribeEvents(handleGatewayEvent);
  };
  const detachIfIdle = () => {
    if (watchedByOwner.size > 0 || listeners.size > 0) {
      return;
    }
    stopGatewaySnapshots?.();
    stopGatewayEvents?.();
    stopGatewaySnapshots = null;
    stopGatewayEvents = null;
    // Without event/client subscriptions these snapshots cannot remain fresh.
    for (const entry of entries.values()) {
      retireRefresh(entry);
    }
    entries.clear();
  };
  const watch: SessionProgressCardStore["watch"] = (owner, targets, options) => {
    // Retain aliases so a replacement Gateway can resolve its new routing facts.
    const retained = targets
      .filter((target) => target.sessionKey.trim())
      .map(({ sessionKey, agentId }) => ({ sessionKey, agentId }));
    if (retained.length === 0) {
      watchedByOwner.delete(owner);
      detachIfIdle();
      return;
    }
    watchedByOwner.set(owner, { targets: retained, ...options });
    attach();
    for (const target of retained) {
      if (options?.admitAutomaticRead?.() !== false) {
        void load(target).catch(() => undefined);
      }
    }
  };
  return {
    watch,
    unwatch: (owner) => watch(owner, []),
    load,
    refresh: (target, card) => {
      connection.transition(gateway.snapshot);
      const scope = connection.capture();
      const resolved = resolveTarget(target);
      const entry = entries.get(resolved.key);
      if (!scope || !entry || entry.card !== card || entry.refresh?.state === "pending") {
        return;
      }
      const retry = entry.refresh?.state === "failed" || entry.refresh?.state === "timeout";
      // A timed-out request may still be running. Retry the same intent rather
      // than starting duplicate agent work after an uncertain outcome.
      const refresh: ProgressCardRefresh = {
        state: "pending",
        idempotencyKey:
          entry.refresh && entry.refresh.state !== "updated" && !entry.refresh.retryNewIntent
            ? entry.refresh.idempotencyKey
            : generateUUID(),
        baseline:
          entry.refresh && entry.refresh.state !== "updated" && !entry.refresh.retryNewIntent
            ? entry.refresh.baseline
            : card.revision,
        accepted: false,
      };
      retireRefresh(entry);
      entry.refresh = refresh;
      const current = () =>
        entries.get(resolved.key) === entry &&
        entry.refresh === refresh &&
        connection.isCurrent(scope) &&
        gateway.snapshot.client === scope.client;
      refresh.timer = setTimeout(() => {
        if (current() && refresh.state === "pending") {
          refresh.state = "timeout";
          notify();
        }
      }, REFRESH_TIMEOUT_MS);
      const params: ProgressCardRefreshParams = {
        ...progressCardRequestTarget(entry.target),
        idempotencyKey: refresh.idempotencyKey,
      };
      notify();
      void scope.client
        .request<ProgressCardRefreshResult>("progressCard.refresh", params)
        .then((result) => {
          if (!current()) {
            return;
          }
          if (
            result.status !== "accepted" ||
            typeof result.runId !== "string" ||
            !result.runId ||
            !Number.isInteger(result.revision) ||
            result.revision < 1
          ) {
            throw new Error("Progress refresh response was invalid");
          }
          refresh.baseline = Math.max(refresh.baseline, result.revision);
          refresh.accepted = true;
          // The changed event and its authoritative read may beat acceptance.
          reconcileRefresh(entry);
          notify();
        })
        .catch((error: unknown) => {
          if (current()) {
            clearTimeout(refresh.timer);
            refresh.retryNewIntent =
              error instanceof GatewayRequestError &&
              isRecord(error.details) &&
              error.details.code === "PROGRESS_CARD_REFRESH_TERMINAL";
            refresh.state = "failed";
            notify();
          }
        });
      if (retry && current()) {
        // Replayed admission does not replay a missed event or its failed read.
        // Use the shared loader to coalesce reads and retain its ownership guards.
        entry.dirty = true;
        void load(entry.target).catch(() => undefined);
      }
    },
    getRefreshState: (target) => entries.get(resolveTarget(target).key)?.refresh?.state,
    dismiss: async (target, card) => {
      connection.transition(gateway.snapshot);
      const scope = connection.capture();
      if (!scope) {
        return false;
      }
      const resolved = resolveTarget(target);
      const entry = entries.get(resolved.key);
      if (!entry || entry.card !== card) {
        return false;
      }
      const generation = entry.generation;
      const current = () =>
        entries.get(resolved.key) === entry &&
        connection.isCurrent(scope) &&
        gateway.snapshot.client === scope.client;
      const result = await scope.client
        .request<ProgressCardPutResult>(PROGRESS_CARD_PUT_METHOD, {
          ...progressCardRequestTarget(entry.target),
          expectedRevision: card.revision,
        })
        .catch((error: unknown) => {
          if (current() && entry.generation === generation) {
            recordRequestError(entry, error);
          }
          throw error;
        });
      const resultCard = parseProgressCard(result, entry.wireKey);
      if (!current()) {
        return false;
      }
      const dismissed = resultCard === null;
      // Its own invalidation may precede the reply; a clear still owns the captured revision.
      if (resultCard ? entry.generation === generation : entry.card?.revision === card.revision) {
        entry.card = resultCard;
        acceptLifetime(resolved.key, entry.target, resultCard);
        entry.dirty = false;
        delete entry.error;
        remember(resolved.key, entry);
        notify();
      }
      return dismissed;
    },
    get: (target) => entries.get(resolveTarget(target).key)?.card,
    getLifetime: (target) => {
      syncLifetimeScope();
      return lifetimes.get(resolveTarget(target).key)?.token;
    },
    getError: (target) => entries.get(resolveTarget(target).key)?.error,
    subscribe: (listener) => {
      listeners.add(listener);
      attach();
      return () => {
        listeners.delete(listener);
        detachIfIdle();
      };
    },
  };
}

export function sessionProgressCardsForGateway(
  gateway: ApplicationGateway,
): SessionProgressCardStore {
  const existing = stores.get(gateway);
  if (existing) {
    return existing;
  }
  const store = createStore(gateway);
  stores.set(gateway, store);
  return store;
}
