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
  dirty: boolean;
  hydratedScope?: object;
  refreshPending?: boolean;
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
  hydrate: (target: ProgressCardGetParams, card: ProgressCard | null) => void;
  invalidate: (target: ProgressCardGetParams) => void;
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

function parseProgressCardStep(value: unknown): ProgressCardStep {
  if (
    !isRecord(value) ||
    typeof value.step !== "string" ||
    (value.status !== "pending" && value.status !== "in_progress" && value.status !== "completed")
  ) {
    throw new Error("Progress card response contained invalid steps");
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
  if (markdown === undefined && (!steps || steps.length === 0)) {
    throw new Error("Progress card response contained no content");
  }
  return {
    sessionKey,
    revision,
    updatedAt,
    ...(markdown !== undefined ? { markdown } : {}),
    ...(steps && steps.length > 0 ? { steps } : {}),
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

export function sessionProgressCardsForGateway(
  gateway: ApplicationGateway,
): SessionProgressCardStore {
  const existing = stores.get(gateway);
  if (existing) {
    return existing;
  }
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
      entries.forEach(retireRefresh);
      entries.clear();
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
  const notify = () => listeners.forEach((listener) => listener());
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
      dirty: true,
    };
    remember(resolved.key, entry);
    if (!entry.dirty && entry.card !== undefined) {
      return entry.card;
    }
    if (entry.load) {
      return entry.load;
    }
    const client = gateway.snapshot.client;
    if (!client) {
      return null;
    }
    const current = () => entries.get(resolved.key) === entry && gateway.snapshot.client === client;
    const request = client
      .request<ProgressCardGetResult>("progressCard.get", progressCardRequestTarget(entry.target))
      .then((response) => {
        const card = parseProgressCard(response, entry.wireKey);
        if (!current() || entry.load !== request) {
          return null;
        }
        entry.card = card;
        delete entry.hydratedScope;
        acceptLifetime(resolved.key, entry.target, card);
        entry.dirty = entry.refreshPending === true;
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
            const needsRefresh = entry.refreshPending;
            delete entry.refreshPending;
            if (needsRefresh && watchedTargets(true).has(resolved.key)) {
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
  const retireClientEntries = () => {
    const scope = gatewayPresentationScope(gateway);
    for (const [key, entry] of entries) {
      if (entry.hydratedScope !== scope) {
        retireRefresh(entry);
        entries.delete(key);
        lifetimes.delete(key);
      }
    }
  };
  const handleGatewaySnapshot = (snapshot: ApplicationGateway["snapshot"]) => {
    syncLifetimeScope();
    const clientChanged = snapshot.client !== knownClient;
    const nextAvailable = available();
    const becameAvailable = nextAvailable && !knownAvailable;
    if (!nextAvailable && knownAvailable) {
      // Automatic reconnect reuses the client. Retire its reads, but retain presentation.
      for (const entry of entries.values()) {
        entry.dirty = true;
        delete entry.load;
        delete entry.refreshPending;
      }
    }
    knownAvailable = nextAvailable;
    if (!clientChanged && !becameAvailable) {
      return;
    }
    if (clientChanged) {
      knownClient = snapshot.client;
      retireClientEntries();
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
      const matchesTarget = (target: ProgressCardGetParams) =>
        uiSessionEventMatches(
          {
            hello: gateway.snapshot.hello,
            assistantAgentId: target.agentId,
            sessionKey: target.sessionKey,
          },
          changed.key,
          changed.agentId,
        );
      for (const [key, { target }] of lifetimes) {
        if (matchesTarget(target)) {
          lifetimes.delete(key);
        }
      }
      let removed = false;
      for (const [key, entry] of entries) {
        if (matchesTarget(entry.target)) {
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
    if (event.event !== "progressCard.changed" || !isRecord(event.payload)) {
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
      // Distinct canonical rows can share a wire key. A numbered event that is
      // already represented by the cache is redundant; a null revision remains
      // an unconditional refresh hint.
      if (
        !entry.load &&
        !entry.dirty &&
        revision !== null &&
        entry.card &&
        entry.card.revision >= revision
      ) {
        continue;
      }
      entry.dirty = true;
      delete entry.error;
      if (entry.load) {
        entry.refreshPending = true;
        continue;
      }
      if (watched.has(key)) {
        void load(entry.target).catch(() => undefined);
      }
    }
  };
  const attach = () => {
    if (stopGatewaySnapshots || stopGatewayEvents) {
      return;
    }
    syncLifetimeScope();
    if (gateway.snapshot.client !== knownClient) {
      knownClient = gateway.snapshot.client;
      retireClientEntries();
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
    entries.forEach(retireRefresh);
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
  const store: SessionProgressCardStore = {
    invalidate: (target) => {
      const { key } = resolveTarget(target);
      const entry = entries.get(key);
      if (entry) {
        retireRefresh(entry);
        entries.delete(key);
      }
      lifetimes.delete(key);
      notify();
    },
    hydrate: (target, card) => {
      syncLifetimeScope();
      const resolved = resolveTarget(target);
      if (entries.has(resolved.key)) {
        return;
      }
      const parsed = parseProgressCard({ card }, resolved.wireKey);
      remember(resolved.key, {
        target: resolved.target,
        wireKey: resolved.wireKey,
        dirty: true,
        card: parsed,
        hydratedScope: gatewayPresentationScope(gateway),
      });
      acceptLifetime(resolved.key, resolved.target, parsed);
      notify();
    },
    watch,
    unwatch: (owner) => watch(owner, []),
    load,
    refresh: (target, card) => {
      const client = gateway.snapshot.client;
      const resolved = resolveTarget(target);
      const entry = entries.get(resolved.key);
      if (
        !available() ||
        !client ||
        !entry ||
        entry.card !== card ||
        entry.refresh?.state === "pending"
      ) {
        return;
      }
      const retry = entry.refresh?.state === "failed" || entry.refresh?.state === "timeout";
      // A timed-out request may still be running. Retry the same intent rather
      // than starting duplicate agent work after an uncertain outcome.
      const retained =
        entry.refresh && entry.refresh.state !== "updated" && !entry.refresh.retryNewIntent
          ? entry.refresh
          : undefined;
      const refresh: ProgressCardRefresh = {
        state: "pending",
        idempotencyKey: retained?.idempotencyKey ?? generateUUID(),
        baseline: retained?.baseline ?? card.revision,
        accepted: false,
      };
      retireRefresh(entry);
      entry.refresh = refresh;
      const current = () =>
        entries.get(resolved.key) === entry &&
        entry.refresh === refresh &&
        gateway.snapshot.client === client;
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
      void client
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
      const client = gateway.snapshot.client;
      if (!available() || !client) {
        return false;
      }
      const resolved = resolveTarget(target);
      const entry = entries.get(resolved.key);
      if (!entry || entry.card !== card) {
        return false;
      }
      const current = () =>
        entries.get(resolved.key) === entry && gateway.snapshot.client === client;
      const result = await client
        .request<ProgressCardPutResult>("progressCard.put", {
          ...progressCardRequestTarget(entry.target),
          expectedRevision: card.revision,
        })
        .catch((error: unknown) => {
          if (current()) {
            recordRequestError(entry, error);
          }
          throw error;
        });
      const resultCard = parseProgressCard(result, entry.wireKey);
      if (!current()) {
        return false;
      }
      const dismissed = resultCard === null;
      if ((entry.card?.revision ?? 0) <= (resultCard?.revision ?? card.revision)) {
        entry.card = resultCard;
        acceptLifetime(resolved.key, entry.target, resultCard);
        entry.dirty = false;
        delete entry.error;
        remember(resolved.key, entry);
        notify();
      }
      return dismissed;
    },
    get: (target) => {
      syncLifetimeScope();
      return entries.get(resolveTarget(target).key)?.card;
    },
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
  stores.set(gateway, store);
  return store;
}
