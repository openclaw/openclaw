import type { CronCompactJob } from "../../api/types.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import { canCallGatewayMethod, canPresentGatewayMethod } from "../gateway-methods.ts";
import { listen } from "../reactive/listener.ts";
import { resolveUiConversationIdentity } from "../sessions/session-key.ts";
import { loadCompactCronJobsPage, retireCronJobsRequest } from "./jobs.ts";
import { createInitialCronState } from "./state.ts";

export type SessionAutomationPresentation = {
  /** Current binding, connected host, presented pane, and document visibility. */
  isVisible: () => boolean;
  document: Document;
};

function createInventory(source: ApplicationGateway, key: string, release: () => void) {
  let cron = createInitialCronState<CronCompactJob>();
  let readable = false;
  let error = false;
  let dirty = true;
  let presentationScope = 0;
  let stop: (() => void) | undefined;
  const observers = new Map<() => void, SessionAutomationPresentation>();
  const visible = () => Array.from(observers.values()).some((view) => view.isVisible());
  const publish = () => {
    for (const notify of observers.keys()) {
      notify();
    }
  };
  const canPresent = () =>
    canPresentGatewayMethod(source.snapshot, "cron.list", "operator.read", {
      requireAdvertisement: false,
    });
  const identity = () => JSON.stringify(resolveUiConversationIdentity(source.snapshot, key));

  function reset(retain = false) {
    retireCronJobsRequest(cron);
    readable = canPresent();
    const next = createInitialCronState<CronCompactJob>({
      client: source.snapshot.client,
      connected: source.snapshot.phase === "connected",
    });
    const resolved = resolveUiConversationIdentity(source.snapshot, key);
    next.cronSessionFilter =
      resolved.sessionKey && resolved.agentId
        ? { sessionKey: resolved.sessionKey, sessionAgentId: resolved.agentId }
        : undefined;
    next.cronJobsSortBy = "name";
    next.canRefresh = () =>
      cron === next &&
      visible() &&
      Boolean(next.cronSessionFilter) &&
      canCallGatewayMethod(source.snapshot, "cron.list", "operator.read", {
        requireAdvertisement: false,
      });
    const scope = gatewayPresentationScope(source).key;
    if (retain && readable && scope === presentationScope) {
      next.cronJobs = cron.cronJobs;
      next.cronJobsSnapshotRevision = cron.cronJobsSnapshotRevision;
      next.cronJobsTotal = cron.cronJobsTotal;
      next.cronJobsHasMore = cron.cronJobsHasMore;
      next.cronJobsNextOffset = cron.cronJobsNextOffset;
    }
    presentationScope = scope;
    cron = next;
    error = false;
    dirty = true;
    publish();
  }

  async function load({ append = false, event }: { append?: boolean; event?: unknown } = {}) {
    const current = cron;
    if (
      !readable ||
      !visible() ||
      !current.connected ||
      !current.cronSessionFilter ||
      ((current.cronLoading || current.cronJobsLoadingMore) && !dirty)
    ) {
      return;
    }
    dirty = false;
    const pending = loadCompactCronJobsPage(current, { append, event });
    publish();
    await pending;
    if (cron !== current || observers.size === 0) {
      return;
    }
    // Hidden trailing reads are paused by canRefresh; reveal admits one catch-up.
    dirty ||= !visible();
    error = current.cronJobsError !== null;
    publish();
  }

  const activate = () => {
    if (dirty) {
      void load();
    }
  };
  reset();
  return {
    read: () => ({ cron, readable, error }),
    load,
    activate,
    park: () => {
      if (!visible()) {
        dirty = true;
      }
    },
    observe(notify: () => void, presentation: SessionAutomationPresentation) {
      observers.set(notify, presentation);
      if (observers.size === 1) {
        const lifecycle = createGatewayConnectionLifecycle(source.snapshot);
        let resolvedIdentity = identity();
        const unsubscribe = source.subscribe((snapshot) => {
          const nextIdentity = identity();
          const changed = lifecycle.transition(snapshot);
          const scopeChanged = gatewayPresentationScope(source).key !== presentationScope;
          const nextReadable = canPresent();
          if (
            changed ||
            scopeChanged ||
            resolvedIdentity !== nextIdentity ||
            readable !== nextReadable
          ) {
            reset(
              resolvedIdentity === nextIdentity &&
                readable === nextReadable &&
                snapshot.phase !== "connected",
            );
            resolvedIdentity = nextIdentity;
          }
          activate();
        });
        const unsubscribeEvents = source.subscribeEvents((event) => {
          if (event.event === "cron") {
            dirty = true;
            void load({ event: event.payload });
          }
        });
        const document = presentation.document;
        const window = document.defaultView;
        const stopVisibility = listen(document, "visibilitychange", activate);
        const stopFocus = window ? listen(window, "focus", activate) : undefined;
        stop = () => {
          unsubscribe();
          unsubscribeEvents();
          lifecycle.dispose();
          stopVisibility();
          stopFocus?.();
        };
      }
      activate();
      return () => {
        observers.delete(notify);
        if (observers.size === 0) {
          stop?.();
          stop = undefined;
          retireCronJobsRequest(cron);
          release();
        }
      };
    },
  };
}

export type SessionAutomationInventory = ReturnType<typeof createInventory>;
const inventories = new WeakMap<ApplicationGateway, Map<string, SessionAutomationInventory>>();

/** One live inventory per Gateway/session; the last presentation retires its requests. */
export function sessionAutomationInventory(source: ApplicationGateway, sessionKey: string) {
  let sessions = inventories.get(source);
  if (!sessions) {
    sessions = new Map();
    inventories.set(source, sessions);
  }
  let inventory = sessions.get(sessionKey);
  if (!inventory) {
    const ownedSessions = sessions;
    inventory = createInventory(source, sessionKey, () => ownedSessions.delete(sessionKey));
    sessions.set(sessionKey, inventory);
  }
  return inventory;
}
