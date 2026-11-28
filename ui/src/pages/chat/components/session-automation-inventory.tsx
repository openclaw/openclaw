import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import type { CronCompactJob } from "../../../api/types.ts";
import { gatewayPresentationScope } from "../../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { isCronInventoryInvalidation } from "../../../lib/cron/inventory-connection.ts";
import { loadCompactCronJobsPage, retireCronJobsRequest } from "../../../lib/cron/jobs.ts";
import { createCronReadState } from "../../../lib/cron/state.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod, canPresentGatewayMethod } from "../../../lib/gateway-methods.ts";
import { createGatewayRetryOwner } from "../../../lib/gateway-retry.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { resolveUiConversationIdentity } from "../../../lib/sessions/session-key.ts";
import type { ChatDetailsSnapshot } from "../session-details-snapshot-schema.ts";

export class AutomationReadError extends Error {
  constructor(
    message: string,
    readonly readDenied: boolean,
  ) {
    super(message);
  }
}

export type SessionAutomationInventoryProps = {
  gateway: ApplicationGateway | undefined;
  sessionKey: string;
  presented: boolean;
  observing?: boolean;
};

/** Create once in the session owner; desktop and mobile consume this same inventory. */
export function createSessionAutomationInventory(
  props: SessionAutomationInventoryProps,
  host: () => HTMLElement | undefined,
) {
  // Unrelated parent prop replacements must not reset inventory or presentation.
  const gateway = createMemo(() => props.gateway);
  const sessionKey = createMemo(() => props.sessionKey);
  const presented = createMemo(() => props.observing ?? props.presented);
  const binding = createMemo(() => ({ source: gateway(), key: sessionKey() }));
  let loadedBinding: ReturnType<typeof binding> | undefined;
  const [revision, setRevision] = createSignal(0);
  const publish = () => setRevision((value) => value + 1);
  // The loader owns synchronous request state; Solid only observes its revision.
  let cron = createCronReadState<CronCompactJob>();
  const [receipt, setReceipt] = createSignal<{
    state: typeof cron;
    result: Promise<void>;
  }>();
  let readAccess = false;
  let dirty = true;
  let retryPending = false;
  const retry = createGatewayRetryOwner();
  let active = true;
  let presentationScope = 0;
  const visible = (isPresented = presented()) =>
    active &&
    host()?.isConnected === true &&
    isPresented &&
    host()?.ownerDocument.visibilityState !== "hidden";
  const state = () => {
    revision();
    return cron;
  };
  const scope = createMemo(state);
  // Observe the admitted read, including its trailing refresh. Consumers never send an RPC.
  // Throw the settled failure in the readiness slot so pending probes can retain the retry UI.
  const read = createMemo<AutomationReadError | undefined>(() => {
    const current = scope();
    const admitted = receipt();
    return admitted?.state === current
      ? admitted.result.then(() => {
          if (current.cronJobsError) {
            return new AutomationReadError(
              current.cronJobsError,
              current.cronJobsReadDenied === true,
            );
          }
          return undefined;
        })
      : Promise.resolve(undefined);
  });

  const readable = () => {
    revision();
    return readAccess;
  };

  function reset(source: ApplicationGateway | undefined, key: string, retain = false) {
    loadedBinding = binding();
    retry.reset();
    retryPending = false;
    retireCronJobsRequest(cron);
    readAccess = canPresentGatewayMethod(source?.snapshot, "cron.list", "operator.read", {
      requireAdvertisement: false,
    });
    const next = createCronReadState<CronCompactJob>({
      client: source?.snapshot.client ?? null,
      connected: source?.snapshot.phase === "connected",
    });
    const identity = resolveUiConversationIdentity(source?.snapshot ?? {}, key);
    next.cronSessionFilter =
      identity.sessionKey && identity.agentId
        ? { sessionKey: identity.sessionKey, sessionAgentId: identity.agentId }
        : undefined;
    next.cronJobsSortBy = "name";
    next.canRefresh = () =>
      cron === next &&
      visible() &&
      Boolean(next.cronSessionFilter) &&
      canCallGatewayMethod(source?.snapshot, "cron.list", "operator.read", {
        requireAdvertisement: false,
      });
    const nextPresentationScope = source ? gatewayPresentationScope(source).key : 0;
    if (
      retain &&
      readAccess &&
      nextPresentationScope !== 0 &&
      nextPresentationScope === presentationScope
    ) {
      next.cronJobs = cron.cronJobs;
      next.cronJobsSnapshotRevision = cron.cronJobsSnapshotRevision;
      next.cronJobsTotal = cron.cronJobsTotal;
      next.cronJobsHasMore = cron.cronJobsHasMore;
      next.cronJobsNextOffset = cron.cronJobsNextOffset;
    }
    presentationScope = nextPresentationScope;
    cron = next;
    dirty = true;
    publish();
  }

  async function load({
    append = false,
    isPresented = presented(),
    event,
    refresh = false,
  }: {
    append?: boolean;
    isPresented?: boolean;
    event?: unknown;
    refresh?: boolean;
  } = {}) {
    const current = cron;
    if (
      !readAccess ||
      !visible(isPresented) ||
      !current.connected ||
      !current.cronSessionFilter ||
      ((current.cronLoading || current.cronJobsLoadingMore) && !dirty)
    ) {
      return;
    }
    retry.cancel();
    retryPending = false;
    dirty = false;
    const alreadyLoading = current.cronLoading || current.cronJobsLoadingMore;
    const pending = loadCompactCronJobsPage(current, { append, event, refresh });
    // Coalesced events return early; retain the active read's completion receipt.
    if (!alreadyLoading && (current.cronLoading || current.cronJobsLoadingMore)) {
      setReceipt({ state: current, result: pending });
    }
    publish();
    await pending;
    if (cron !== current || !active || !host()?.isConnected) {
      return;
    }
    // The loader pauses trailing reads while hidden; retain one visible catch-up.
    const failed = current.cronJobsError !== null;
    dirty ||= !visible() || failed;
    if (failed && visible() && !current.cronJobsReadDenied) {
      retryPending = true;
      retry.schedule(() => {
        retryPending = false;
        if (cron === current) {
          void load();
        }
      });
    } else if (!failed || current.cronJobsReadDenied) {
      retry.reset();
    }
    publish();
  }

  // Mount this outlet once in the session owner; consumers share its retained inventory.
  const lifecycle = (
    <Show when={binding()} keyed>
      {({ source, key }) => {
        onSettled(() => {
          reset(source, key);
          if (!source) {
            return undefined;
          }
          const connection = createGatewayConnectionLifecycle(source.snapshot);
          let identity = JSON.stringify(resolveUiConversationIdentity(source.snapshot, key));
          // Reject obsolete event delivery before queued binding cleanup runs. Callbacks run
          // untracked, so read the owned memos: a caller's prop getter may build a node with no
          // committed value while an async frame holds the write, and reading it here throws.
          const current = () => gateway() === source && sessionKey() === key;
          // Connection publications retire request scopes before the next cron event is delivered.
          const unsubscribe = source.subscribe((snapshot) => {
            if (!current()) {
              return;
            }
            const nextIdentity = JSON.stringify(resolveUiConversationIdentity(snapshot, key));
            const changed = connection.transition(snapshot);
            const nextReadAccess = canPresentGatewayMethod(snapshot, "cron.list", "operator.read", {
              requireAdvertisement: false,
            });
            if (changed || identity !== nextIdentity || readAccess !== nextReadAccess) {
              reset(source, key, identity === nextIdentity && readAccess === nextReadAccess);
              identity = nextIdentity;
            }
            if (dirty && !retryPending && !cron.cronJobsReadDenied) {
              void load();
            }
          });
          const unsubscribeEvents = source.subscribeEvents((event) => {
            if (current() && (event.event === "cron" || isCronInventoryInvalidation(event))) {
              dirty = true;
              void load({ event: event.event === "cron" ? event.payload : undefined });
            }
          });
          void load();
          return () => {
            unsubscribe();
            unsubscribeEvents();
            connection.dispose();
            retry.reset();
            retryPending = false;
            retireCronJobsRequest(cron);
          };
        });
        return (
          <For each={[presented()]}>
            {(shown) => {
              onSettled(() => {
                if (shown && !cron.cronJobsReadDenied) {
                  void load({ isPresented: true });
                }
                return () => {
                  retry.cancel();
                  retryPending = false;
                  dirty = true;
                };
              });
              return null;
            }}
          </For>
        );
      }}
    </Show>
  );
  onSettled(() => {
    const activate = () => {
      if (!visible()) {
        retry.cancel();
        retryPending = false;
      } else if (dirty && !cron.cronJobsReadDenied) {
        void load();
      }
    };
    const stopVisibility = listen(host()!.ownerDocument, "visibilitychange", activate);
    const stopFocus = listen(globalThis, "focus", activate);
    activate();
    return () => {
      active = false;
      retry.reset();
      stopVisibility();
      stopFocus();
    };
  });

  return {
    lifecycle,
    jobs: (): readonly CronCompactJob[] => state().cronJobs,
    total: () => state().cronJobsTotal,
    hasMore: () => state().cronJobsHasMore,
    loading: () => state().cronLoading || state().cronJobsLoadingMore,
    loaded: () => state().cronJobsSnapshotRevision !== null && binding() === loadedBinding,
    connected: () => scope().connected,
    available: () => readable() && Boolean(state().cronSessionFilter),
    readable,
    denied: () => state().cronJobsReadDenied === true,
    error: () => state().cronJobsError !== null,
    read,
    refresh: () => load({ refresh: true }),
    loadMore: () => load({ append: true }),
  };
}

export type SessionAutomationInventory = ReturnType<typeof createSessionAutomationInventory>;

/** Offline rows are display evidence only until the current inventory settles. */
export function readCachedSessionAutomations(
  inventory: SessionAutomationInventory,
  gateway: ApplicationGateway | undefined,
  cached: ChatDetailsSnapshot["automations"],
) {
  return !inventory.loaded() &&
    !inventory.denied() &&
    (!gateway?.snapshot.hello || inventory.readable())
    ? cached
    : undefined;
}
