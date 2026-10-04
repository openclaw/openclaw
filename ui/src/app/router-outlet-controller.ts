import type { RouteMatch, Router, RouterState } from "@openclaw/uirouter";
import {
  isAgentDatabaseInspectionPendingError,
  resolveGatewayReadRetryDelayMs,
} from "../lib/gateway-availability.ts";

const DEFAULT_PENDING_DELAY_MS = 1_000;

type RouterOutletStateSlice<
  TRouteId extends string = string,
  TModule = unknown,
  TData = unknown,
> = {
  status: RouterState<TRouteId, TModule, TData>["status"];
  active: RouteMatch<TRouteId, TModule, TData> | undefined;
  pending: RouteMatch<TRouteId, TModule, TData> | undefined;
};

export type RouterOutletSnapshot<
  TRouteId extends string = string,
  TModule = unknown,
  TData = unknown,
> = RouterOutletStateSlice<TRouteId, TModule, TData> & {
  settled: RouteMatch<TRouteId, TModule, TData> | undefined;
  showPending: boolean;
  startupPending?: boolean;
};

export type RouterOutletInputs<TRouteId extends string, TLoadContext, TModule, TData> = {
  router?: Router<TRouteId, TLoadContext, TModule, TData>;
  onNotFound?: () => boolean | void;
  notFoundRecoveryReady?: boolean;
  retryContext?: TLoadContext;
  retryEnabled?: boolean;
};

type RouterOutletControllerOptions = {
  pendingDelayMs?: number;
};

export function selectRenderedRouteMatch<TRouteId extends string, TModule, TData>(
  active: RouteMatch<TRouteId, TModule, TData> | undefined,
  pending: RouteMatch<TRouteId, TModule, TData> | undefined,
): RouteMatch<TRouteId, TModule, TData> | undefined {
  const coldPending =
    pending?.status === "pending" && pending.module === undefined && pending.error === undefined;
  return coldPending && active ? active : (pending ?? active);
}

function selectRouterOutletState<TRouteId extends string, TModule, TData>(
  state: RouterState<TRouteId, TModule, TData>,
): RouterOutletStateSlice<TRouteId, TModule, TData> {
  return {
    status: state.status,
    active: state.matches[0],
    pending: state.pendingMatches[0],
  };
}

function idleSnapshot<TRouteId extends string, TModule, TData>(): RouterOutletSnapshot<
  TRouteId,
  TModule,
  TData
> {
  return {
    status: "idle",
    active: undefined,
    pending: undefined,
    settled: undefined,
    showPending: false,
  };
}

/**
 * Owns route-presentation timing and effects without depending on a renderer.
 * Render adapters provide invalidation and bind the controller to their own
 * connection lifecycle.
 */
export class RouterOutletController<
  TRouteId extends string = string,
  TLoadContext = unknown,
  TModule = unknown,
  TData = unknown,
> {
  private router?: Router<TRouteId, TLoadContext, TModule, TData>;
  private onNotFound?: () => boolean | void;
  private connected = false;
  private unsubscribe?: () => void;
  private selection: RouterOutletStateSlice<TRouteId, TModule, TData> = idleSnapshot();
  private snapshotValue: RouterOutletSnapshot<TRouteId, TModule, TData> = idleSnapshot();
  private settled?: RouteMatch<TRouteId, TModule, TData>;
  private pendingMatchId?: string;
  private pendingTimer?: ReturnType<typeof globalThis.setTimeout>;
  private showPending = false;
  private notFoundActive = false;
  private notFoundDeclined = false;
  private notFoundQueued = false;
  private notFoundGeneration = 0;
  private notFoundRecoveryReady = true;
  private readonly pendingDelayMs: number;
  private retryContext?: TLoadContext;
  private retryEnabled = true;
  private startupMatchId?: string;
  private startupAttempt = 0;
  private startupTimer?: ReturnType<typeof globalThis.setTimeout>;

  constructor(
    private readonly invalidate: () => void,
    options: RouterOutletControllerOptions = {},
  ) {
    this.pendingDelayMs = options.pendingDelayMs ?? DEFAULT_PENDING_DELAY_MS;
  }

  get snapshot(): RouterOutletSnapshot<TRouteId, TModule, TData> {
    return this.snapshotValue;
  }

  setInputs(inputs: RouterOutletInputs<TRouteId, TLoadContext, TModule, TData>): void {
    if (
      this.retryContext !== inputs.retryContext ||
      this.retryEnabled !== (inputs.retryEnabled ?? true)
    ) {
      this.clearStartupRetry();
    }
    this.retryContext = inputs.retryContext;
    this.retryEnabled = inputs.retryEnabled ?? true;
    this.onNotFound = inputs.onNotFound;
    const nextNotFoundRecoveryReady = inputs.notFoundRecoveryReady ?? true;
    const recoveryBecameReady =
      !this.notFoundRecoveryReady && nextNotFoundRecoveryReady && this.notFoundDeclined;
    this.notFoundRecoveryReady = nextNotFoundRecoveryReady;
    if (this.router === inputs.router) {
      this.updateStartupRetry();
      if (recoveryBecameReady && this.selection.status === "notFound") {
        this.cancelNotFoundEffect();
        this.updateNotFoundEffect(this.selection.status);
      }
      return;
    }

    this.detachSource();
    this.router = inputs.router;
    this.settled = undefined;
    if (this.connected) {
      this.attachSource();
      return;
    }
    const selection = inputs.router
      ? selectRouterOutletState(inputs.router.getState())
      : idleSnapshot<TRouteId, TModule, TData>();
    this.applySelection(selection);
  }

  connect(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.attachSource(false);
    // A disconnected host may have retained DOM for an older snapshot. Always
    // reconcile once on reconnect, even when the router state stayed stable.
    this.invalidate();
  }

  disconnect(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.detachSource();
  }

  private attachSource(notify = true): void {
    const router = this.router;
    if (this.unsubscribe) {
      return;
    }
    if (!router) {
      this.applySelection(idleSnapshot<TRouteId, TModule, TData>(), notify);
      return;
    }
    this.applySelection(selectRouterOutletState(router.getState()), notify);
    // An earlier subscriber can navigate during this notification. Read the
    // current route so its superseded not-found snapshot cannot trigger recovery.
    this.unsubscribe = router.subscribe(() =>
      this.applySelection(selectRouterOutletState(router.getState())),
    );
  }

  private detachSource(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearPendingTimer();
    this.pendingMatchId = undefined;
    this.showPending = false;
    this.cancelNotFoundEffect();
    this.clearStartupRetry();
  }

  private applySelection(
    selection: RouterOutletStateSlice<TRouteId, TModule, TData>,
    notify = true,
  ): void {
    this.selection = selection;
    if (selection.status === "idle" || selection.status === "notFound") {
      this.settled = undefined;
    } else {
      const rendered = selectRenderedRouteMatch(selection.active, selection.pending);
      if (rendered?.status === "success") {
        this.settled = rendered;
      } else if (
        rendered?.status === "error" ||
        rendered?.status === "notFound" ||
        rendered?.status === "redirected"
      ) {
        // Terminal destinations replace the previous page. A later retry must
        // not recreate its disposed draft from a historical successful match.
        this.settled = undefined;
      }
    }
    const pending = selection.pending;
    const coldPending =
      pending?.status === "pending" && pending.module === undefined && pending.error === undefined;
    const needsPendingFallback = coldPending && !selection.active;
    if (!needsPendingFallback) {
      this.clearPendingTimer();
      this.pendingMatchId = undefined;
      this.showPending = false;
    } else if (this.pendingMatchId !== pending.id) {
      this.clearPendingTimer();
      this.pendingMatchId = pending.id;
      this.showPending = false;
      this.schedulePendingFallback(pending.id);
    } else if (this.connected && !this.showPending && this.pendingTimer === undefined) {
      this.schedulePendingFallback(pending.id);
    }

    this.updateStartupRetry();
    this.publish(
      {
        ...selection,
        settled: this.settled,
        showPending: this.showPending,
        startupPending: this.startupMatchId !== undefined,
      },
      notify,
    );
    this.updateNotFoundEffect(selection.status);
  }

  private schedulePendingFallback(matchId: string): void {
    if (!this.connected) {
      return;
    }
    this.pendingTimer = globalThis.setTimeout(() => {
      this.pendingTimer = undefined;
      const pending = this.selection.pending;
      const stillCold =
        pending?.id === matchId &&
        pending.status === "pending" &&
        pending.module === undefined &&
        pending.error === undefined &&
        !this.selection.active;
      if (!this.connected || this.pendingMatchId !== matchId || !stillCold) {
        return;
      }
      this.showPending = true;
      this.publish({ ...this.selection, settled: this.settled, showPending: true });
    }, this.pendingDelayMs);
  }

  private updateStartupRetry(): void {
    // A new destination cancels the old retry even while its module is still loading.
    const match = this.selection.pending ?? this.selection.active;
    if (match?.id !== this.startupMatchId) {
      this.clearStartupRetry();
    }
    if (!this.connected || !this.retryEnabled || this.retryContext === undefined || !match) {
      this.clearStartupRetry();
      return;
    }
    if (match.status === "pending" || match.isFetching) {
      globalThis.clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
      return;
    }
    if (!isAgentDatabaseInspectionPendingError(match.error)) {
      this.clearStartupRetry();
      return;
    }
    this.startupMatchId = match.id;
    if (this.startupTimer !== undefined) {
      return;
    }
    this.startupTimer = globalThis.setTimeout(
      () => {
        this.startupTimer = undefined;
        const current = this.selection.pending ?? this.selection.active;
        if (
          !this.connected ||
          !this.retryEnabled ||
          current?.id !== match.id ||
          !isAgentDatabaseInspectionPendingError(current.error) ||
          this.retryContext === undefined
        ) {
          return;
        }
        void this.router?.revalidate(this.retryContext, match.routeId).catch(() => undefined);
      },
      resolveGatewayReadRetryDelayMs(match.error, this.startupAttempt++),
    );
  }

  private clearStartupRetry(): void {
    globalThis.clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    this.startupMatchId = undefined;
    this.startupAttempt = 0;
  }

  private updateNotFoundEffect(status: RouterOutletStateSlice["status"]): void {
    if (status !== "notFound") {
      if (this.notFoundActive || this.notFoundQueued) {
        this.cancelNotFoundEffect();
      }
      return;
    }
    if (!this.connected || this.notFoundActive) {
      return;
    }

    this.notFoundActive = true;
    this.notFoundQueued = true;
    const generation = ++this.notFoundGeneration;
    queueMicrotask(() => {
      if (
        !this.connected ||
        generation !== this.notFoundGeneration ||
        this.selection.status !== "notFound"
      ) {
        return;
      }
      this.notFoundQueued = false;
      // A disconnected shell declines transiently. Keep the latch until its
      // readiness input changes so unrelated renders cannot spin retries.
      if (this.onNotFound?.() === false) {
        this.notFoundDeclined = true;
      }
    });
  }

  private cancelNotFoundEffect(): void {
    this.notFoundGeneration += 1;
    this.notFoundActive = false;
    this.notFoundDeclined = false;
    this.notFoundQueued = false;
  }

  private publish(snapshot: RouterOutletSnapshot<TRouteId, TModule, TData>, notify = true): void {
    const previous = this.snapshotValue;
    if (
      previous.status === snapshot.status &&
      previous.active === snapshot.active &&
      previous.pending === snapshot.pending &&
      previous.settled === snapshot.settled &&
      previous.showPending === snapshot.showPending &&
      previous.startupPending === snapshot.startupPending
    ) {
      return;
    }
    this.snapshotValue = snapshot;
    if (notify && this.connected) {
      this.invalidate();
    }
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer !== undefined) {
      globalThis.clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
  }
}
