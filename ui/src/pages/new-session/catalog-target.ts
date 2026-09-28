import { html, nothing } from "lit";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { ChatModelPickerTargetGroup } from "../chat/components/chat-model-picker-options.ts";
import type { NewSessionRouteData } from "./location.ts";
import { newSessionModelLocationFromSearch } from "./model-location.ts";

registerNewSessionSetupEnglish();

function draftRouteKey(
  requestedAgentId: string,
  catalogId: string,
  group: string,
  model?: string,
): string {
  return JSON.stringify([requestedAgentId, catalogId, group, ...(model ? [model] : [])]);
}

/**
 * Which draft a new-session route has open. This keys on the requested agent,
 * not the resolved one: a catalog route resolves its agent through the Gateway
 * and reports it empty until the roster arrives, so keying on the resolved id
 * would make that fill-in look like a navigation and discard the draft.
 */
export function routeKey(data?: NewSessionRouteData): string {
  return draftRouteKey(
    data?.requestedAgentId ?? "",
    data?.catalogId ?? "",
    data?.group ?? "",
    data?.requestedModel,
  );
}

export function routeKeyFromSearch(search: string): string {
  const location = newSessionModelLocationFromSearch(search);
  return draftRouteKey(
    location.agentId,
    location.catalogId,
    location.group ?? "",
    location.requestedModel,
  );
}

export function requestedModelForAgent(
  data: NewSessionRouteData | undefined,
  agentId: string,
): string | undefined {
  return !data?.requestedAgentId ||
    normalizeAgentId(data.requestedAgentId) === normalizeAgentId(agentId)
    ? data?.requestedModel
    : undefined;
}

export function isTarget(data?: NewSessionRouteData): boolean {
  return Boolean(data?.catalogId);
}

function isResolvedTarget(data?: NewSessionRouteData): boolean {
  return Boolean(data?.catalogId && data.startTerminal && data.catalogLabel);
}

function isPendingRouteTarget(data?: NewSessionRouteData): boolean {
  return (
    (isTarget(data) && !isResolvedTarget(data)) ||
    Boolean(data?.group && data.groupStatus !== "resolved")
  );
}

export function groupDefaultsKey(data?: NewSessionRouteData): string {
  return JSON.stringify([
    data?.groupStatus ?? "",
    data?.groupCwd ?? "",
    data?.groupWorktree === true,
    data?.groupCatalogGeneration ?? -1,
    data?.groupDefaultsStatus ?? "idle",
  ]);
}

function groupRouteNeedsRevalidation(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability,
): boolean {
  const groupName = data?.group?.trim();
  if (!groupName) {
    return false;
  }
  const generation = sessions.groupsGeneration();
  const status = sessions.groupsStatus();
  if (data?.groupCatalogGeneration !== generation || data.groupDefaultsStatus !== status) {
    return true;
  }
  if (status !== "ready") {
    return false;
  }
  const current = sessions.state.groupSettings.find((group) => group.name === groupName);
  return current
    ? data.groupStatus !== "resolved" ||
        (data.groupCwd ?? "") !== (current.cwd ?? "") ||
        data.groupWorktree !== (current.worktree === true)
    : data.groupStatus === "resolved";
}

function groupRouteCatalogKey(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability,
): string {
  const current = sessions.state.groupSettings.find((group) => group.name === data?.group);
  return JSON.stringify([
    data?.group ?? "",
    sessions.groupsGeneration(),
    sessions.groupsStatus(),
    Boolean(current),
    current?.cwd ?? "",
    current?.worktree === true,
  ]);
}

export function isGroupRoutePending(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability | undefined,
): boolean {
  return Boolean(data?.group && (!sessions || groupRouteNeedsRevalidation(data, sessions)));
}

export function isRoutePending(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability | undefined,
): boolean {
  return isPendingRouteTarget(data) || isGroupRoutePending(data, sessions);
}

export function resolvedGroupName(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability | undefined,
): string | undefined {
  return data?.groupStatus === "resolved" && !isGroupRoutePending(data, sessions)
    ? data.group
    : undefined;
}

export class GroupRouteRevalidation {
  private pending: Promise<unknown> | null = null;
  private lastKey = "";

  constructor(
    private readonly readData: () => NewSessionRouteData | undefined,
    private readonly revalidate: () => Promise<unknown> | undefined,
  ) {}

  synchronize(sessions: SessionCapability) {
    if (this.pending) {
      return;
    }
    const data = this.readData();
    const key = groupRouteCatalogKey(data, sessions);
    if (this.lastKey === key || !groupRouteNeedsRevalidation(data, sessions)) {
      return;
    }
    const pending = this.revalidate();
    if (!pending) {
      return;
    }
    this.lastKey = key;
    this.pending = pending;
    void pending
      .catch(() => undefined)
      .finally(() => {
        if (this.pending === pending) {
          this.pending = null;
          this.synchronize(sessions);
        }
      });
  }
}

export function resolveAgentId(
  data: Pick<NewSessionRouteData, "agentId" | "catalogId"> | undefined,
  availableAgents: readonly { id: string }[],
  fallback: string,
): string {
  const rawRequested = data?.agentId?.trim();
  if (!rawRequested) {
    return fallback && normalizeAgentId(fallback);
  }
  const requested = normalizeAgentId(rawRequested);
  return availableAgents.some((candidate) => normalizeAgentId(candidate.id) === requested)
    ? requested
    : fallback && normalizeAgentId(fallback);
}

export function allowsSelectedAgent(
  data: NewSessionRouteData | undefined,
  selectedAgent: unknown,
): boolean {
  return !isTarget(data) || (isResolvedTarget(data) && Boolean(selectedAgent));
}

export async function resolveCreateTarget(
  client: GatewayBrowserClient,
  catalogId: string,
  agentId?: string,
): Promise<
  | Pick<NewSessionRouteData, "model" | "catalogLabel" | "startTerminal" | "terminalHosts">
  | undefined
> {
  try {
    const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      ...(agentId ? { agentId } : {}),
      catalogId,
      limitPerHost: 1,
    });
    const catalog = result.catalogs.find((candidate) => candidate.id === catalogId);
    const terminal = catalog?.capabilities.startTerminal;
    const terminalHosts = catalog?.hosts
      .filter((host) => host.canStartTerminal === true)
      .map(({ hostId, label }) => ({ hostId, label }));
    return catalog && terminal === true
      ? {
          model: "",
          catalogLabel: catalog.label,
          startTerminal: true,
          terminalHosts,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export type CatalogDraftOwnerSnapshot = {
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  isConnected?: boolean;
  submitting: boolean;
  pendingPlacementSessionKey: string;
  visibility?: "normal" | "incognito" | "draft";
};

type CatalogSelectionSnapshot = CatalogDraftOwnerSnapshot & {
  agentId: string;
  agentAvailable: boolean;
  remotePlacement: boolean;
};

export function pickerTarget(data?: NewSessionRouteData) {
  return data?.catalogId
    ? {
        groupId: "cliAgents",
        value: data.catalogId,
        label: data.catalogLabel || data.catalogId,
        description: t("newSession.nativeTerminalHint"),
      }
    : undefined;
}

export class CatalogTargetSelection {
  constructor(
    private readonly read: () => CatalogSelectionSnapshot,
    private readonly onTargetSelect:
      | ((data: NewSessionRouteData, isCurrent: () => boolean) => Promise<boolean>)
      | undefined,
    private readonly notify: () => void,
    private readonly onHostChange: () => void,
  ) {}

  terminalHostId = "gateway:local";
  private terminalHostInitialized = false;

  get terminalOnNode(): boolean {
    return this.terminalHostId.startsWith("node:");
  }

  selectTerminalHost(hostId: string) {
    if (this.read().submitting) {
      return;
    }
    this.terminalHostInitialized = true;
    if (hostId === this.terminalHostId) {
      return;
    }
    this.terminalHostId = hostId;
    this.onHostChange();
    this.notify();
  }

  synchronizeTerminalHosts() {
    const hosts = this.data?.terminalHosts;
    if (this.terminalHostInitialized || !hosts?.length) {
      return;
    }
    this.selectTerminalHost(
      hosts.find((host) => host.hostId === this.terminalHostId)?.hostId ?? hosts[0]!.hostId,
    );
  }

  reset() {
    this.clear();
    this.terminalHostId = "gateway:local";
    this.terminalHostInitialized = false;
  }

  // Only this explicit picker handoff may keep the draft across a changed route key.
  private targetSelection:
    | { sourceRouteKey: string; routeKey: string; data: NewSessionRouteData }
    | undefined;

  get data(): NewSessionRouteData | undefined {
    const data = this.read().data;
    const key = data ? routeKey(data) : routeKeyFromSearch(window.location.search);
    return this.targetSelection &&
      [this.targetSelection.sourceRouteKey, this.targetSelection.routeKey].includes(key)
      ? this.targetSelection.data
      : data;
  }

  get transitionPending(): boolean {
    return this.targetSelection !== undefined;
  }

  isTargetTransition(key: string): boolean {
    return this.targetSelection?.routeKey === key;
  }

  private captureTargetSelection(ownsSelection: () => boolean) {
    const source = this.read();
    const pathname = window.location.pathname;
    const sourceLocation = routeKeyFromSearch(window.location.search);
    const context = source.context;
    const gateway = context?.gateway;
    const snapshot = gateway?.snapshot;
    const client = snapshot?.client;
    const agentId = source.agentId;
    const sourceRouteKey = routeKey(source.data);
    const hello = snapshot?.hello;
    const identity = snapshot?.selfUser?.id;
    const connection = gateway?.connection;
    const connectionRevision = gateway?.connectionRevision;
    let destination = "";
    let finished = false;
    const isCurrent = () => {
      const now = this.read();
      const key = now.data ? routeKey(now.data) : routeKeyFromSearch(window.location.search);
      return (
        !finished &&
        ownsSelection() &&
        window.location.pathname === pathname &&
        [sourceLocation, destination].includes(routeKeyFromSearch(window.location.search)) &&
        now.context === context &&
        now.isConnected !== false &&
        !now.submitting &&
        !now.pendingPlacementSessionKey &&
        now.visibility === source.visibility &&
        now.remotePlacement === source.remotePlacement &&
        now.agentId === agentId &&
        [sourceRouteKey, destination].includes(key) &&
        context?.gateway === gateway &&
        gateway?.connection === connection &&
        gateway?.connectionRevision === connectionRevision &&
        gateway?.snapshot.phase === "connected" &&
        gateway.snapshot.client === client &&
        gateway.snapshot.hello === hello &&
        gateway.snapshot.selfUser?.id === identity
      );
    };
    return {
      source: source.data,
      sourceAgentAvailable: source.agentAvailable,
      nativeDisabledReason:
        source.visibility && source.visibility !== "normal"
          ? t("newSession.terminalVisibilityUnsupported")
          : source.remotePlacement
            ? t("newSession.terminalPlacementUnsupported")
            : undefined,
      agentId,
      client,
      isCurrent,
      commit: async (data: NewSessionRouteData) => {
        if (!isCurrent()) {
          return false;
        }
        destination = routeKey(data);
        this.targetSelection = { sourceRouteKey, routeKey: destination, data };
        this.notify();
        try {
          const accepted = await this.onTargetSelect?.(data, isCurrent);
          return accepted === true && isCurrent();
        } finally {
          finished = true;
          if (this.targetSelection?.data === data) {
            this.targetSelection = undefined;
          }
          this.notify();
        }
      },
    };
  }

  async selectCatalogTarget(catalogId: string, ownsSelection: () => boolean) {
    const owner = this.captureTargetSelection(ownsSelection);
    if (!owner.client || !owner.agentId || !owner.sourceAgentAvailable || !owner.isCurrent()) {
      return undefined;
    }
    if (owner.nativeDisabledReason) {
      return owner.nativeDisabledReason;
    }
    const target = await resolveCreateTarget(owner.client, catalogId, owner.agentId);
    if (!owner.isCurrent()) {
      return undefined;
    }
    if (!target) {
      return false;
    }
    if (!target.terminalHosts?.length) {
      return t("newSession.nativeHostsUnavailable");
    }
    const accepted = await owner.commit({
      ...owner.source,
      agentId: owner.agentId,
      requestedAgentId: owner.agentId,
      requestedModel: undefined,
      catalogId,
      ...target,
    });
    if (!accepted) {
      return undefined;
    }
    this.terminalHostInitialized = false;
    this.synchronizeTerminalHosts();
    return true;
  }

  async selectModelTarget(model: string, ownsSelection: () => boolean): Promise<boolean> {
    if (!isTarget(this.data)) {
      return false;
    }
    const owner = this.captureTargetSelection(ownsSelection);
    const accepted = await owner.commit({
      ...owner.source,
      agentId: owner.agentId,
      requestedAgentId: owner.agentId,
      requestedModel: model || undefined,
      catalogId: "",
      catalogLabel: "",
      startTerminal: false,
      model,
    });
    if (accepted && this.terminalOnNode) {
      this.selectTerminalHost("gateway:local");
    }
    return accepted;
  }

  clear() {
    this.targetSelection = undefined;
  }
}

type CatalogCreateTarget = Pick<SessionCatalog, "id" | "label">;
type CatalogTargetOwner = { agentId: string; client: GatewayBrowserClient };
type CatalogTargetDiscoveryState =
  | { status: "idle" }
  | {
      status: "loading";
      owner: CatalogTargetOwner;
      controller: AbortController;
      requestId: number;
    }
  | { status: "ready"; owner: CatalogTargetOwner; targets: CatalogCreateTarget[] }
  | { status: "error"; owner: CatalogTargetOwner };

export class CatalogTargetDiscovery {
  private selection: { catalogId: string; status: "loading" | "error"; error?: string } | undefined;

  clearSelection() {
    this.selection = undefined;
  }

  async select(
    catalogId: string,
    select: (id: string, isCurrent: () => boolean) => Promise<boolean | string | undefined>,
    isCurrent: () => boolean,
  ) {
    const selection = { catalogId, status: "loading" as const };
    const discovery = this.state;
    const ownsSelection = () => this.state === discovery && isCurrent();
    this.selection = selection;
    this.notify();
    const accepted = await select(catalogId, ownsSelection);
    if (!ownsSelection()) {
      if (this.selection === selection) {
        this.clearSelection();
        this.notify();
      }
      return false;
    }
    this.selection =
      accepted === false || typeof accepted === "string"
        ? {
            catalogId,
            status: "error",
            error: typeof accepted === "string" ? accepted : t("newSession.catalogUnavailable"),
          }
        : undefined;
    this.notify();
    return accepted === true;
  }

  private requestId = 0;
  private state: CatalogTargetDiscoveryState = { status: "idle" };

  constructor(private readonly notify: () => void) {}

  clear() {
    const previous = this.state;
    this.clearSelection();
    this.state = { status: "idle" };
    this.requestId += 1;
    if (previous.status === "loading") {
      previous.controller.abort();
    }
    if (previous.status !== "idle") {
      this.notify();
    }
  }

  private startRequest(owner: CatalogTargetOwner) {
    const controller = new AbortController();
    const requestId = ++this.requestId;
    this.state = { status: "loading", owner, controller, requestId };
    this.notify();
    void owner.client
      .request<SessionsCatalogListResult>(
        "sessions.catalog.list",
        { agentId: owner.agentId, metadataOnly: true },
        { signal: controller.signal },
      )
      .then(
        (result) => {
          const active = this.state;
          if (active.status !== "loading" || active.requestId !== requestId) {
            return;
          }
          this.state = {
            status: "ready",
            owner,
            targets: result.catalogs
              .filter((catalog) => catalog.capabilities.startTerminal === true)
              .map(({ id, label }) => ({ id, label })),
          };
          this.notify();
        },
        () => {
          const active = this.state;
          if (active.status !== "loading" || active.requestId !== requestId) {
            return;
          }
          this.state = { status: "error", owner };
          this.notify();
        },
      );
  }

  load(context: ApplicationContext | undefined, agentId: string, enabled: boolean) {
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const normalizedAgentId = agentId.trim() ? normalizeAgentId(agentId) : "";
    if (
      !enabled ||
      snapshot?.phase !== "connected" ||
      !client ||
      !normalizedAgentId ||
      isGatewayMethodAdvertised(snapshot, "sessions.catalog.list") !== true
    ) {
      this.clear();
      return;
    }
    const owner = { agentId: normalizedAgentId, client };
    const current = this.state;
    if (
      current.status !== "idle" &&
      current.owner.client === owner.client &&
      current.owner.agentId === owner.agentId
    ) {
      return;
    }

    this.clear();
    this.startRequest(owner);
  }

  retry(client: GatewayBrowserClient | undefined, agentId: string) {
    const targetDiscovery = this.state;
    if (
      targetDiscovery.status === "error" &&
      targetDiscovery.owner.client === client &&
      targetDiscovery.owner.agentId === agentId
    ) {
      this.startRequest(targetDiscovery.owner);
    }
  }

  groups(target?: NewSessionRouteData): readonly ChatModelPickerTargetGroup[] | undefined {
    const discovery = this.state;
    if (
      discovery.status === "idle" ||
      (discovery.status === "ready" && !discovery.targets.length)
    ) {
      return undefined;
    }
    return [
      {
        errorLabel: t("newSession.cliAgentsUnavailable"),
        id: "cliAgents",
        label: t("newSession.cliAgentsGroup"),
        options:
          discovery.status === "ready"
            ? discovery.targets.map(({ id, label }) => ({
                value: id,
                label,
                pending: this.selection?.catalogId === id && this.selection.status === "loading",
                error:
                  this.selection?.catalogId === id && this.selection.status === "error"
                    ? this.selection.error
                    : target?.catalogId === id &&
                        (!target.startTerminal || target.terminalHosts?.length === 0)
                      ? target.terminalHosts?.length === 0
                        ? t("newSession.nativeHostsUnavailable")
                        : t("newSession.catalogUnavailable")
                      : undefined,
              }))
            : [],
        status: discovery.status,
      },
    ];
  }
}

export function renderBar(params: {
  data?: NewSessionRouteData;
  agentSelect: unknown;
  placeSelect: unknown;
  retrying: boolean;
  onRetry: () => void;
  groupPending?: boolean;
}) {
  const pending =
    Boolean(params.data?.group && params.data.groupStatus !== "resolved") ||
    params.groupPending === true;
  return html`
    <div class="new-session-page__triggers">
      ${params.agentSelect} ${params.placeSelect}
      ${
        pending
          ? html`<span class="new-session-page__catalog-unavailable">
              ${t("newSession.catalogUnavailable")}
              <button
                class="btn btn--sm"
                type="button"
                ?disabled=${params.retrying}
                @click=${params.onRetry}
              >
                ${params.retrying ? t("common.loading") : t("lazyView.retry")}
              </button>
            </span>`
          : nothing
      }
    </div>
  `;
}
