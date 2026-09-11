import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { isSessionRouteId, type RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import type {
  SessionCapability,
  SessionRowObservation,
  SessionRowTarget,
} from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeDefaultMainSessionAliasForUi,
  resolveUiConversationIdentity,
  resolveUiSessionNavigationParentKey,
  uiConversationMatches,
  type UiSessionDefaultsHost,
} from "../lib/sessions/session-key.ts";
import {
  collectKnownSessionRows,
  evictArchivedSessionLineage,
  fetchSessionLineage,
  publishActiveSessionLineage,
  publishActiveSessionRow,
  publishObservedSessionLineage,
  publishObservedSessionRow,
  retainActiveSessionRow,
} from "./app-sidebar-child-session-data.ts";

type LineageOwner = {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly isSessionDataHostConnected: boolean;
  sessionsResult: SessionsListResult | null;
  activeSessionLineageRoot: GatewaySessionRow | null;
  activeSessionLineageSelectedRow: GatewaySessionRow | null;
  childSessionRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>;
  requestSessionDataUpdate(): void;
};

type LineageScope = {
  key: string;
  selectedAgentId: string | null;
  gateway: ApplicationContext<RouteId>["gateway"];
  client: GatewayBrowserClient;
  sessions: SessionCapability;
  connectionRevision: number;
};

type DescriptorBinding = LineageScope & {
  target: SessionRowTarget;
  observation?: SessionRowObservation;
};

type LineageRequest = {
  identity: ReturnType<typeof resolveUiConversationIdentity>;
  sourceRevision: number;
  publishingSelected: boolean;
  promise: Promise<void>;
};

type LineageNavigation = Pick<LineageScope, "key" | "selectedAgentId" | "gateway" | "sessions"> & {
  identity: ReturnType<typeof resolveUiConversationIdentity>;
};

type ChildRowAdmission =
  | { status: "not-selected" }
  | { status: "selected"; row: GatewaySessionRow | null };

export function sessionLineageIdentityHost(
  context: ApplicationContext<RouteId> | undefined,
): UiSessionDefaultsHost {
  return {
    assistantAgentId:
      context?.agentSelection.state.selectedId ?? context?.gateway.snapshot.assistantAgentId,
    agentsList: context?.agents.state.agentsList,
    hello: context?.gateway.snapshot.hello,
  };
}

/** Owns routed ancestry requests and the selected descriptor's observation lease. */
export class SessionLineageController {
  routeKey: string | null = null;
  private loaded: ReturnType<typeof resolveUiConversationIdentity> | null = null;
  private request: LineageRequest | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private binding: DescriptorBinding | null = null;
  private navigation: LineageNavigation | null = null;

  constructor(
    private readonly owner: LineageOwner,
    private readonly route: () => { routeId: string | undefined; key: string },
    private readonly childGeneration: () => number,
  ) {}

  private selectedAgentId(): string | null {
    const selected = this.owner.context?.agentSelection.state.selectedId?.trim();
    return selected ? normalizeAgentId(selected) : null;
  }

  private identity(key: string) {
    return resolveUiConversationIdentity(sessionLineageIdentityHost(this.owner.context), key);
  }

  private scopeIsCurrent(scope: LineageScope): boolean {
    const context = this.owner.context;
    const route = this.route();
    return (
      this.owner.isSessionDataHostConnected &&
      isSessionRouteId(route.routeId) &&
      route.key.trim() === scope.key &&
      this.routeKey === scope.key &&
      this.selectedAgentId() === scope.selectedAgentId &&
      context?.sessions === scope.sessions &&
      context.gateway === scope.gateway &&
      scope.sessions.captureConnectionScope() !== null &&
      scope.gateway.snapshot.phase === "connected" &&
      scope.gateway.snapshot.client === scope.client &&
      scope.gateway.connectionRevision === scope.connectionRevision
    );
  }

  private bindingIsCurrent(binding: DescriptorBinding): boolean {
    const identity = this.identity(binding.key);
    return (
      this.binding === binding &&
      this.scopeIsCurrent(binding) &&
      identity.sessionKey === binding.target.key &&
      (identity.agentId ?? binding.selectedAgentId) === binding.target.agentId &&
      (binding.observation?.isCurrent() ?? true)
    );
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      globalThis.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private retireWalk(): void {
    this.request = null;
    this.loaded = null;
    this.clearRetry();
  }

  private retire(): void {
    const binding = this.binding;
    this.binding = null;
    binding?.observation?.dispose();
    this.retireWalk();
  }

  private clearPresentation(): void {
    this.owner.activeSessionLineageRoot = null;
    this.owner.activeSessionLineageSelectedRow = null;
  }

  private evictPreviousLineage(): void {
    if (this.routeKey && this.identity(this.routeKey).sessionKey !== "global") {
      evictArchivedSessionLineage(this.owner, this.routeKey);
    }
  }

  synchronize(): void {
    const route = this.route();
    const context = this.owner.context;
    const key = isSessionRouteId(route.routeId) ? route.key.trim() : "";
    const identity = key ? this.identity(key) : null;
    const selectedAgentId = this.selectedAgentId();
    const previous = this.navigation;
    if (!key || !identity || !context) {
      this.navigation = null;
    } else if (
      previous?.key !== key ||
      previous.identity.sessionKey !== identity.sessionKey ||
      previous.identity.agentId !== identity.agentId ||
      previous.selectedAgentId !== selectedAgentId ||
      previous.sessions !== context.sessions ||
      previous.gateway !== context.gateway
    ) {
      // Navigation owns this token even while describes fail or a SID lease retires.
      this.navigation = {
        key,
        identity,
        selectedAgentId,
        sessions: context.sessions,
        gateway: context.gateway,
      };
    }
    if (
      this.routeKey !== null &&
      (!isSessionRouteId(route.routeId) || route.key.trim() !== this.routeKey)
    ) {
      this.evictPreviousLineage();
      this.retire();
      this.routeKey = null;
      this.clearPresentation();
      this.owner.requestSessionDataUpdate();
    } else if (
      previous !== this.navigation ||
      (this.binding && !this.bindingIsCurrent(this.binding))
    ) {
      this.retire();
      this.clearPresentation();
      this.owner.requestSessionDataUpdate();
    }
  }

  reset(preserveOperatorContext: boolean): void {
    // A list/filter generation does not retire a still-owned descriptor read.
    // The capability's ledger, route and connection decide that lease's lifetime.
    if (
      this.binding &&
      this.bindingIsCurrent(this.binding) &&
      (this.binding.target.key === "global" || preserveOperatorContext)
    ) {
      if (this.binding.target.key === "global") {
        this.publish(this.binding, this.binding.observation?.row ?? null);
      } else {
        this.retireWalk();
      }
      return;
    }
    this.retire();
    if (!preserveOperatorContext) {
      this.routeKey = null;
      this.clearPresentation();
    }
  }

  disconnect(): void {
    this.navigation = null;
    this.retire();
  }

  private publish(binding: DescriptorBinding, row: GatewaySessionRow | null): void {
    if (!this.bindingIsCurrent(binding)) {
      return;
    }
    const previous = this.selectedRow();
    if (row) {
      if (binding.target.key === "global") {
        publishObservedSessionRow(this.owner, row, binding.sessions.inheritRow);
      } else {
        retainActiveSessionRow(this.owner, row, previous, binding.sessions.inheritRow);
      }
    } else {
      this.clearPresentation();
    }
    if (binding.target.key !== "global" && !this.request?.publishingSelected) {
      this.retireChangedLineage(previous, row);
    }
  }

  private observe(scope: LineageScope, target: SessionRowTarget): DescriptorBinding {
    const binding: DescriptorBinding = { ...scope, target };
    // Registration may synchronously deliver a held live row.
    this.binding = binding;
    binding.observation = scope.sessions.observeRow(target, (row) => {
      if (this.binding !== binding) {
        return;
      }
      if (!this.bindingIsCurrent(binding)) {
        this.synchronize();
        return;
      }
      this.publish(binding, row);
      if (!row && this.request === null) {
        this.loaded = null;
      }
      this.owner.requestSessionDataUpdate();
    });
    this.synchronize();
    if (!this.bindingIsCurrent(binding)) {
      binding.observation.dispose();
      return binding;
    }
    this.publish(binding, binding.observation.row);
    return binding;
  }

  private selectedRow(): GatewaySessionRow | undefined {
    return (
      this.owner.activeSessionLineageSelectedRow ??
      this.owner.sessionsResult?.sessions.find((row) =>
        areUiSessionKeysEquivalent(row.key, this.routeKey),
      )
    );
  }

  private retireChangedLineage(
    previous: GatewaySessionRow | undefined,
    current: GatewaySessionRow | null,
  ): void {
    if (
      previous &&
      current &&
      ((previous.sessionId && current.sessionId && previous.sessionId !== current.sessionId) ||
        normalizeDefaultMainSessionAliasForUi(resolveUiSessionNavigationParentKey(previous)) !==
          normalizeDefaultMainSessionAliasForUi(resolveUiSessionNavigationParentKey(current)))
    ) {
      // Pending ancestry belongs to the previous row as much as a completed walk does.
      this.retireWalk();
    }
  }

  captureChildRead(): {
    isCurrent: () => boolean;
    reconcile: (row: GatewaySessionRow) => ChildRowAdmission;
  } {
    this.synchronize();
    const navigation = this.navigation;
    const key = navigation?.key;
    const sessions = this.owner.context?.sessions;
    const gateway = this.owner.context?.gateway;
    const connection = sessions?.captureConnectionScope();
    const identityHost = sessionLineageIdentityHost(this.owner.context);
    const global = navigation?.identity.sessionKey === "global";
    const binding = global ? this.binding : null;
    const observed = binding?.observation?.captureReconcile();
    const reconcile = !global ? sessions?.captureReconcile() : undefined;
    const isCurrent = () =>
      this.owner.isSessionDataHostConnected &&
      sessions === this.owner.context?.sessions &&
      gateway === this.owner.context?.gateway &&
      Boolean(connection && sessions?.isConnectionScopeCurrent(connection));
    const isSelected = () => {
      this.synchronize();
      return isCurrent() && navigation !== null && navigation === this.navigation;
    };
    return {
      isCurrent,
      reconcile: (row) => {
        const matches = global
          ? uiConversationMatches(identityHost, key, row.key, row.agentId)
          : areUiSessionKeysEquivalent(row.key, key);
        if (!matches || !isSelected()) {
          return { status: "not-selected" };
        }
        if (!global) {
          const accepted =
            reconcile && sessions
              ? publishActiveSessionRow(this.owner, row, reconcile, sessions.inheritRow, isSelected)
              : null;
          if (!isSelected()) {
            return { status: "not-selected" };
          }
          return { status: "selected", row: accepted };
        }
        // A retired incarnation is an admission rejection, not a navigation change.
        if (!binding || !observed || !this.bindingIsCurrent(binding)) {
          return { status: "selected", row: null };
        }
        const outcome = observed(row);
        if (!isSelected()) {
          return { status: "not-selected" };
        }
        if (outcome.status === "current") {
          this.publish(binding, outcome.row);
          return { status: "selected", row: outcome.row };
        }
        if (outcome.status === "invalidated") {
          this.loaded = null;
          this.owner.requestSessionDataUpdate();
          return { status: "selected", row: binding.observation?.row ?? null };
        }
        this.synchronize();
        return { status: "selected", row: null };
      },
    };
  }

  load(sessionKey: string): Promise<void> {
    this.synchronize();
    const key = sessionKey.trim();
    if (key !== this.routeKey) {
      this.evictPreviousLineage();
      this.retire();
      this.routeKey = key;
      this.clearPresentation();
      this.owner.requestSessionDataUpdate();
    }
    if (this.request) {
      return this.request.promise;
    }
    const { gateway, sessions } = this.owner.context ?? {};
    const client = gateway?.snapshot.client;
    if (!key || this.loaded || this.retryTimer !== null || !gateway || !sessions || !client) {
      return Promise.resolve();
    }
    const scope: LineageScope = {
      key,
      gateway,
      sessions,
      client,
      selectedAgentId: this.selectedAgentId(),
      connectionRevision: gateway.connectionRevision,
    };
    if (!this.scopeIsCurrent(scope)) {
      return Promise.resolve();
    }
    const identity = this.identity(key);
    if (identity.sessionKey === "global" && !identity.agentId) {
      return Promise.resolve();
    }
    const agentId = identity.agentId ?? scope.selectedAgentId;
    const binding = agentId
      ? (this.binding ?? this.observe(scope, { key: identity.sessionKey, agentId }))
      : null;
    if (binding && !this.bindingIsCurrent(binding)) {
      return Promise.resolve();
    }
    const globalBinding = identity.sessionKey === "global" ? binding : null;
    const generation = this.childGeneration();
    const request: LineageRequest = {
      identity,
      sourceRevision: sessions.canonicalListRevision,
      publishingSelected: false,
      promise: Promise.resolve(),
    };
    this.request = request;
    // Defer execution until the one public completion promise is installed.
    request.promise = Promise.resolve().then(async () => {
      const isCurrent = () =>
        request === this.request &&
        this.scopeIsCurrent(scope) &&
        this.identity(key).sessionKey === identity.sessionKey &&
        this.identity(key).agentId === identity.agentId &&
        (globalBinding
          ? this.bindingIsCurrent(globalBinding)
          : generation === this.childGeneration());
      const lineage = await fetchSessionLineage({
        client,
        sessionKey: key,
        captureReconcile: sessions.captureReconcile,
        knownRows: collectKnownSessionRows(
          this.owner.sessionsResult?.sessions ?? [],
          this.owner.childSessionRowsByParent,
        ),
        isCurrent,
        ...(globalBinding
          ? { readSelected: () => this.readDescriptor(globalBinding, isCurrent) }
          : {
              publishSelected: (row, reconcile) => {
                // This walk follows the admitted parent after synchronous observation delivery.
                request.publishingSelected = true;
                try {
                  return publishActiveSessionRow(
                    this.owner,
                    row,
                    reconcile,
                    sessions.inheritRow,
                    isCurrent,
                  );
                } finally {
                  request.publishingSelected = false;
                }
              },
            }),
      });
      if (!lineage || !isCurrent()) {
        if (request === this.request) {
          this.request = null;
          this.synchronize();
        }
        return;
      }
      if (globalBinding) {
        const row = globalBinding.observation?.row;
        if (row) {
          publishObservedSessionLineage(this.owner, lineage, row, sessions.inheritRow);
        } else {
          this.clearPresentation();
        }
      } else {
        publishActiveSessionLineage(
          this.owner,
          key,
          lineage,
          request.sourceRevision,
          sessions.inheritRow,
          isCurrent,
        );
      }
      if (!isCurrent()) {
        return;
      }
      this.request = null;
      if (lineage.lookupFailed) {
        this.retryTimer = globalThis.setTimeout(() => {
          this.retryTimer = null;
          if (this.routeKey === key) {
            this.owner.requestSessionDataUpdate();
          }
        }, 5_000);
      } else {
        this.loaded = identity;
      }
      this.owner.requestSessionDataUpdate();
    });
    return request.promise;
  }

  private async readDescriptor(
    binding: DescriptorBinding,
    isCurrent: () => boolean,
  ): Promise<GatewaySessionRow | undefined> {
    const observation = binding.observation;
    if (!observation || !isCurrent()) {
      return undefined;
    }
    if (observation.row) {
      return observation.row;
    }
    // Only an invalidated empty-lease receipt reissues within this request.
    // Failures leave through fetchSessionLineage's existing retry policy.
    while (isCurrent()) {
      const reconcile = observation.captureReconcile();
      const described = await binding.client.request<{ session?: GatewaySessionRow | null }>(
        "sessions.describe",
        {
          key: binding.key,
          ...(isUiGlobalSessionKey(binding.key) ? { agentId: binding.target.agentId } : {}),
        },
      );
      if (!isCurrent()) {
        return undefined;
      }
      const outcome = reconcile(
        described?.session ? { ...described.session, runtimeSampledAt: Date.now() } : undefined,
      );
      if (outcome.status === "invalidated") {
        continue;
      }
      if (outcome.status === "retired") {
        this.synchronize();
        return undefined;
      }
      this.publish(binding, outcome.row);
      return outcome.row ?? undefined;
    }
    return undefined;
  }
}
