import { html, render, type TemplateResult } from "lit";
import { GatewayBrowserClient, type GatewayBrowserClientOptions } from "../../api/gateway.ts";

export type TeamsPortalRoute = "login" | "invite";
export type TeamsPortalMode = "read" | "request" | "write";

type TeamsPrincipal = {
  issuer: string;
  subject: string;
  kind: "human";
};

export type TeamsPortalSession =
  | { authenticated: false }
  | {
      authenticated: true;
      principal: TeamsPrincipal;
      domainId: string;
      expiresAt: number;
    };

export type TeamsPortalWidget = {
  id: string;
  kind: string;
  title?: string;
};

export type TeamsInvitePreset = "read" | "request" | "write";

export type TeamsOwnerInvite = {
  id: string;
  preset: TeamsInvitePreset;
  tabId: string;
  state: "active" | "redeemed" | "revoked";
  createdAt: number;
  expiresAt: number;
  recipientLabel?: string;
};

export type TeamsShareTab = {
  id: string;
  revision: number;
  slug: string;
  title: string;
};

export type TeamsPendingChangeRequest = {
  id: string;
  requester: string;
  proposedTitle: string;
};

export type TeamsPortalTab = {
  id: string;
  revision: number;
  slug: string;
  title: string;
  hidden: boolean;
  widgets: TeamsPortalWidget[];
};

type TeamsPortalTabResult = {
  workspaceId: string;
  capabilityMode: TeamsPortalMode;
  tab: TeamsPortalTab;
};

export type TeamsPortalGateway = {
  request: (method?: string, params?: unknown) => Promise<unknown>;
  stop?: unknown;
  start?: () => void;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type TeamsPortalStoreOptions = {
  fetcher?: Fetcher;
  gatewayFactory?: (options: GatewayBrowserClientOptions) => GatewayBrowserClient;
  gatewayUrl?: string;
  portalLocation?: Pick<Location, "origin" | "pathname">;
};

export type TeamsPortalSnapshot = {
  status: "idle" | "loading" | "ready" | "signed-out" | "error";
  route: TeamsPortalRoute;
  session: TeamsPortalSession | null;
  tab: TeamsPortalTab | null;
  workspaceId: string | null;
  tabId: string | null;
  mode: TeamsPortalMode | null;
  draftTitle: string;
  error: string | null;
  invitePending?: boolean;
  ownerSharing?: boolean;
  invitePresets?: TeamsInvitePreset[];
  ownerInvites?: TeamsOwnerInvite[];
  oneTimeInviteLink?: string | null;
  oneTimeInviteTabId?: string | null;
  oneTimeInviteId?: string | null;
  shareTabs?: TeamsShareTab[];
  selectedShareTabId?: string | null;
  pendingChangeRequests?: TeamsPendingChangeRequest[];
};

type StartParams = {
  route: TeamsPortalRoute;
  workspaceId?: string | null;
  tabId?: string | null;
  inviteCode?: string | null;
};

type LoginParams = {
  loginLabel: string;
  password: string;
  domainId: string;
};

type InviteParams = {
  code?: string;
  loginLabel: string;
  password: string;
};

function defaultGatewayUrl(): string {
  const url = new URL(window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function responseSession(payload: unknown): TeamsPortalSession {
  const value =
    payload && typeof payload === "object" && "session" in payload
      ? (payload as { session: unknown }).session
      : payload;
  if (
    !value ||
    typeof value !== "object" ||
    (value as { authenticated?: unknown }).authenticated !== true
  ) {
    return { authenticated: false };
  }
  const session = value as Partial<{
    authenticated: true;
    principal: TeamsPrincipal;
    domainId: string;
    expiresAt: number;
  }>;
  if (
    !session.principal ||
    typeof session.principal.issuer !== "string" ||
    typeof session.principal.subject !== "string" ||
    session.principal.kind !== "human" ||
    typeof session.domainId !== "string" ||
    !session.domainId.trim() ||
    typeof session.expiresAt !== "number" ||
    !Number.isFinite(session.expiresAt) ||
    session.expiresAt <= Date.now()
  ) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    principal: {
      issuer: session.principal.issuer,
      subject: session.principal.subject,
      kind: "human",
    },
    domainId: session.domainId,
    expiresAt: session.expiresAt,
  };
}

function responseError(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const message = (payload as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return "Unable to complete the Teams request.";
}

function requestParam(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function isInvitePreset(value: unknown): value is TeamsInvitePreset {
  return value === "read" || value === "request" || value === "write";
}

function isInviteState(value: unknown): value is TeamsOwnerInvite["state"] {
  return value === "active" || value === "redeemed" || value === "revoked";
}

function isPortalMode(value: unknown): value is TeamsPortalMode {
  return value === "read" || value === "request" || value === "write";
}

function readPortalWidget(value: unknown): TeamsPortalWidget | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const widget = value as { id?: unknown; kind?: unknown; title?: unknown };
  if (typeof widget.id !== "string" || typeof widget.kind !== "string") {
    return undefined;
  }
  return {
    id: widget.id,
    kind: widget.kind,
    ...(typeof widget.title === "string" ? { title: widget.title } : {}),
  };
}

function readPortalTab(value: unknown): TeamsPortalTab | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const tab = value as Partial<TeamsPortalTab>;
  if (
    typeof tab.id !== "string" ||
    !Number.isSafeInteger(tab.revision) ||
    (tab.revision ?? 0) < 1 ||
    typeof tab.slug !== "string" ||
    typeof tab.title !== "string" ||
    typeof tab.hidden !== "boolean" ||
    !Array.isArray(tab.widgets)
  ) {
    return undefined;
  }
  const widgets = tab.widgets.map(readPortalWidget);
  if (widgets.some((widget) => !widget)) {
    return undefined;
  }
  return {
    id: tab.id,
    revision: tab.revision!,
    slug: tab.slug,
    title: tab.title,
    hidden: tab.hidden,
    widgets: widgets as TeamsPortalWidget[],
  };
}

function readPortalTabResult(
  payload: unknown,
  expected: { workspaceId: string; tabId: string },
): TeamsPortalTabResult {
  const result =
    payload && typeof payload === "object" ? (payload as Partial<TeamsPortalTabResult>) : {};
  const tab = readPortalTab(result.tab);
  if (
    result.workspaceId !== expected.workspaceId ||
    !isPortalMode(result.capabilityMode) ||
    !tab ||
    tab.id !== expected.tabId
  ) {
    throw new Error("The requested Teams tab is unavailable.");
  }
  return { workspaceId: expected.workspaceId, capabilityMode: result.capabilityMode, tab };
}

function readPortalTabUpdateResult(
  payload: unknown,
  expected: { workspaceId: string; tabId: string },
): TeamsPortalTab {
  const result =
    payload && typeof payload === "object"
      ? (payload as { workspaceId?: unknown; tab?: unknown })
      : {};
  const tab = readPortalTab(result.tab);
  if (result.workspaceId !== expected.workspaceId || !tab || tab.id !== expected.tabId) {
    throw new Error("The updated Teams tab is unavailable.");
  }
  return tab;
}

function readInviteDestination(
  payload: unknown,
): { workspaceId: string; tabId: string } | undefined {
  const destination =
    payload && typeof payload === "object"
      ? (payload as { destination?: unknown }).destination
      : undefined;
  if (!destination || typeof destination !== "object") {
    return undefined;
  }
  const value = destination as { workspaceId?: unknown; tabId?: unknown };
  return typeof value.workspaceId === "string" &&
    value.workspaceId.trim() &&
    typeof value.tabId === "string" &&
    value.tabId.trim()
    ? { workspaceId: value.workspaceId, tabId: value.tabId }
    : undefined;
}

function readInvitePresets(payload: unknown): TeamsInvitePreset[] {
  const source = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { presets?: unknown }).presets)
      ? (payload as { presets: unknown[] }).presets
      : [];
  return source
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? ((entry as { preset?: unknown; id?: unknown }).preset ?? (entry as { id?: unknown }).id)
          : undefined,
    )
    .filter(isInvitePreset);
}

function readOwnerInvites(payload: unknown): TeamsOwnerInvite[] {
  const source = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { invites?: unknown }).invites)
      ? (payload as { invites: unknown[] }).invites
      : payload && typeof payload === "object"
        ? [payload]
        : [];
  return source.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const invite = entry as {
      id?: unknown;
      preset?: unknown;
      tabId?: unknown;
      state?: unknown;
      createdAt?: unknown;
      expiresAt?: unknown;
      recipientLabel?: unknown;
    };
    if (
      typeof invite.id !== "string" ||
      !isInvitePreset(invite.preset) ||
      typeof invite.tabId !== "string" ||
      !isInviteState(invite.state) ||
      typeof invite.createdAt !== "number" ||
      !Number.isFinite(invite.createdAt) ||
      typeof invite.expiresAt !== "number" ||
      !Number.isFinite(invite.expiresAt)
    ) {
      return [];
    }
    return [
      {
        id: invite.id,
        preset: invite.preset,
        tabId: invite.tabId,
        state: invite.state,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        ...(typeof invite.recipientLabel === "string" && invite.recipientLabel.trim()
          ? { recipientLabel: invite.recipientLabel }
          : {}),
      },
    ];
  });
}

function readShareTabs(payload: unknown): TeamsShareTab[] {
  const source =
    payload && typeof payload === "object" && Array.isArray((payload as { tabs?: unknown }).tabs)
      ? (payload as { tabs: unknown[] }).tabs
      : [];
  return source.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const tab = entry as Partial<TeamsShareTab>;
    if (
      typeof tab.id !== "string" ||
      typeof tab.revision !== "number" ||
      typeof tab.slug !== "string" ||
      typeof tab.title !== "string"
    ) {
      return [];
    }
    return [{ id: tab.id, revision: tab.revision, slug: tab.slug, title: tab.title }];
  });
}

function readPendingChangeRequests(payload: unknown): TeamsPendingChangeRequest[] {
  const source =
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { requests?: unknown }).requests)
      ? (payload as { requests: unknown[] }).requests
      : [];
  return source.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const request = entry as {
      id?: unknown;
      requester?: { principalId?: unknown };
      proposal?: { title?: unknown };
    };
    if (
      typeof request.id !== "string" ||
      typeof request.requester?.principalId !== "string" ||
      typeof request.proposal?.title !== "string"
    ) {
      return [];
    }
    return [
      {
        id: request.id,
        requester: request.requester.principalId,
        proposedTitle: request.proposal.title,
      },
    ];
  });
}

function portalBasePath(pathname: string): string {
  const marker = "/teams";
  const index = pathname.lastIndexOf(marker);
  return index >= 0 ? pathname.slice(0, index) : "";
}

export function buildTeamsInviteLink(params: {
  location: Pick<Location, "origin" | "pathname">;
  workspaceId: string;
  tabId: string;
  code: string;
}): string {
  const search = new URLSearchParams({ workspaceId: params.workspaceId, tabId: params.tabId });
  return `${params.location.origin}${portalBasePath(params.location.pathname)}/teams/invite?${search.toString()}#${encodeURIComponent(params.code)}`;
}

export function isTeamsPortalPath(pathname: string): TeamsPortalRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments.at(-1);
  if (last === "teams") {
    return "login";
  }
  if (last === "invite" && segments.at(-2) === "teams") {
    return "invite";
  }
  return null;
}

export function consumeInviteCodeFromFragment(
  location: Pick<Location, "pathname" | "search" | "hash">,
  history: Pick<History, "replaceState">,
): string | null {
  if (!location.hash.startsWith("#") || location.hash.length <= 1) {
    return null;
  }
  let code: string;
  try {
    code = decodeURIComponent(location.hash.slice(1));
  } catch {
    return null;
  }
  if (!code) {
    return null;
  }
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return code;
}

export class TeamsPortalStore {
  private readonly fetcher: Fetcher;
  private readonly gatewayFactory: (options: GatewayBrowserClientOptions) => GatewayBrowserClient;
  private readonly gatewayUrl: string;
  private readonly portalLocation: Pick<Location, "origin" | "pathname">;
  private gateway: TeamsPortalGateway | null = null;
  private expiryTimer: number | null = null;
  private listeners = new Set<(snapshot: TeamsPortalSnapshot) => void>();
  private inviteCode: string | null = null;
  private lifecycleGeneration = 0;
  private snapshotValue: TeamsPortalSnapshot = {
    status: "idle",
    route: "login",
    session: null,
    tab: null,
    workspaceId: null,
    tabId: null,
    mode: null,
    draftTitle: "",
    error: null,
    invitePending: false,
    ownerSharing: false,
    invitePresets: [],
    ownerInvites: [],
    oneTimeInviteLink: null,
    oneTimeInviteTabId: null,
    oneTimeInviteId: null,
    shareTabs: [],
    selectedShareTabId: null,
    pendingChangeRequests: [],
  };

  constructor(options: TeamsPortalStoreOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.gatewayFactory =
      options.gatewayFactory ?? ((clientOptions) => new GatewayBrowserClient(clientOptions));
    this.gatewayUrl = options.gatewayUrl ?? defaultGatewayUrl();
    this.portalLocation = options.portalLocation ?? window.location;
  }

  get snapshot(): TeamsPortalSnapshot {
    return this.snapshotValue;
  }

  subscribe(listener: (snapshot: TeamsPortalSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(params: StartParams): Promise<void> {
    const generation = this.beginLifecycle();
    this.inviteCode = params.inviteCode ?? null;
    this.update({
      status: "loading",
      route: params.route,
      workspaceId: requestParam(params.workspaceId),
      tabId: requestParam(params.tabId),
      invitePending: Boolean(this.inviteCode),
    });
    try {
      const session = await this.getSession();
      if (!this.isCurrent(generation)) {
        return;
      }
      if (!session.authenticated) {
        this.update({ status: "signed-out", session, invitePending: Boolean(this.inviteCode) });
        return;
      }
      await this.useSession(session, generation);
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.clearPortalState();
        this.update({ status: "error", error: errorMessage(error) });
      }
    }
  }

  async login(params: LoginParams): Promise<void> {
    await this.authenticate("/api/teams/login", params);
  }

  async acceptInvite(params: InviteParams): Promise<void> {
    const code = params.code ?? this.inviteCode;
    this.inviteCode = null;
    this.update({ invitePending: false });
    if (!code) {
      this.update({ status: "error", error: "An invite link is required." });
      return;
    }
    await this.authenticate("/api/teams/invites/accept", {
      code,
      loginLabel: params.loginLabel,
      password: params.password,
    });
  }

  setDraftTitle(title: string): void {
    if (!this.snapshotValue.tab || this.snapshotValue.mode === "read") {
      return;
    }
    this.update({ draftTitle: title });
  }

  async submitDraft(): Promise<void> {
    const generation = this.lifecycleGeneration;
    const gateway = this.gateway;
    const { mode, tab, workspaceId, draftTitle } = this.snapshotValue;
    if (!gateway || !mode || !tab || !workspaceId || mode === "read") {
      return;
    }
    try {
      if (mode === "request") {
        await gateway.request("workspaces.changeRequest.create", {
          workspaceId,
          tabId: tab.id,
          baseRevision: tab.revision,
          idempotencyKey: `portal-${crypto.randomUUID()}`,
          proposal: { title: draftTitle },
        });
      } else {
        const payload = await gateway.request("workspaces.tab.update", {
          workspaceId,
          id: tab.id,
          ifRevision: tab.revision,
          patch: { title: draftTitle },
        });
        const updated = readPortalTabUpdateResult(payload, { workspaceId, tabId: tab.id });
        if (!this.isCurrent(generation) || this.gateway !== gateway) {
          return;
        }
        this.update({ tab: updated, draftTitle: updated.title });
      }
      if (this.isCurrent(generation) && this.gateway === gateway) {
        this.update({ error: null });
      }
    } catch (error) {
      if (this.isCurrent(generation) && this.gateway === gateway) {
        this.update({ error: errorMessage(error) });
      }
    }
  }

  async createOwnerInvite(params: {
    preset: TeamsInvitePreset;
    recipientLabel?: string;
    tabId?: string;
  }): Promise<void> {
    const { ownerSharing, workspaceId } = this.snapshotValue;
    const tabId = params.tabId ?? this.snapshotValue.selectedShareTabId;
    if (!ownerSharing || !workspaceId || !tabId) {
      return;
    }
    const recipientLabel = params.recipientLabel?.trim();
    const generation = this.lifecycleGeneration;
    try {
      const payload = await this.requestJson("/api/teams/invites", "POST", {
        workspaceId,
        tabId,
        preset: params.preset,
        ...(recipientLabel ? { recipientLabel } : {}),
      });
      const code =
        payload && typeof payload === "object" ? (payload as { code?: unknown }).code : undefined;
      if (typeof code !== "string" || !code.trim()) {
        throw new Error("The invite could not be created.");
      }
      const created = readOwnerInvites(
        payload && typeof payload === "object"
          ? (payload as { invite?: unknown }).invite
          : undefined,
      )[0];
      if (
        !this.isCurrent(generation) ||
        !created ||
        created.tabId !== tabId ||
        created.state !== "active"
      ) {
        if (this.isCurrent(generation)) {
          throw new Error("The invite could not be created.");
        }
        return;
      }
      this.update({
        oneTimeInviteLink: buildTeamsInviteLink({
          location: this.portalLocation,
          workspaceId,
          tabId,
          code,
        }),
        oneTimeInviteTabId: tabId,
        oneTimeInviteId: created.id,
        ownerInvites: [...(this.snapshotValue.ownerInvites ?? []), created],
        error: null,
      });
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.update({ error: errorMessage(error) });
      }
    }
  }

  setSelectedShareTabId(tabId: string): void {
    if ((this.snapshotValue.shareTabs ?? []).some((tab) => tab.id === tabId)) {
      this.update({ selectedShareTabId: tabId });
      void this.refreshPendingChangeRequests(tabId, this.lifecycleGeneration);
    }
  }

  async decideOwnerChangeRequest(params: {
    requestId: string;
    decision: "approved" | "rejected";
  }): Promise<void> {
    const gateway = this.gateway;
    const { ownerSharing, workspaceId, selectedShareTabId } = this.snapshotValue;
    const generation = this.lifecycleGeneration;
    if (
      !gateway ||
      !ownerSharing ||
      !workspaceId ||
      !selectedShareTabId ||
      !params.requestId.trim()
    ) {
      return;
    }
    try {
      const payload = await gateway.request("workspaces.changeRequest.decide", {
        workspaceId,
        tabId: selectedShareTabId,
        requestId: params.requestId,
        decision: params.decision,
      });
      if (!this.isCurrent(generation) || this.gateway !== gateway) {
        return;
      }
      if (
        params.decision === "approved" &&
        payload &&
        typeof payload === "object" &&
        (payload as { applied?: unknown }).applied === true
      ) {
        const updated = readPortalTabUpdateResult(payload, {
          workspaceId,
          tabId: selectedShareTabId,
        });
        this.update({
          ...(this.snapshotValue.tab?.id === selectedShareTabId
            ? { tab: updated, draftTitle: updated.title }
            : {}),
          shareTabs: (this.snapshotValue.shareTabs ?? []).map((tab) =>
            tab.id === updated.id
              ? {
                  id: updated.id,
                  revision: updated.revision,
                  slug: updated.slug,
                  title: updated.title,
                }
              : tab,
          ),
        });
      }
      await this.refreshPendingChangeRequests(selectedShareTabId, generation);
      if (this.isCurrent(generation) && this.gateway === gateway) {
        this.update({ error: null });
      }
    } catch (error) {
      if (this.isCurrent(generation) && this.gateway === gateway) {
        this.update({ error: errorMessage(error) });
      }
    }
  }

  async revokeOwnerInvite(id: string): Promise<void> {
    if (!this.snapshotValue.ownerSharing || !id.trim()) {
      return;
    }
    const generation = this.lifecycleGeneration;
    try {
      await this.requestJson(`/api/teams/invites/${encodeURIComponent(id)}`, "DELETE", {});
      if (!this.isCurrent(generation)) {
        return;
      }
      this.update({
        ownerInvites: (this.snapshotValue.ownerInvites ?? []).filter((invite) => invite.id !== id),
        ...(this.snapshotValue.oneTimeInviteId === id
          ? { oneTimeInviteLink: null, oneTimeInviteTabId: null, oneTimeInviteId: null }
          : {}),
        error: null,
      });
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.update({ error: errorMessage(error) });
      }
    }
  }

  async logout(): Promise<void> {
    this.invalidateLifecycle();
    this.update({ status: "signed-out", session: { authenticated: false } });
    try {
      await this.post("/api/teams/logout", {});
    } catch {
      // Local authority is cleared immediately; logout remains best effort.
    }
  }

  expireSession(): void {
    this.invalidateLifecycle();
    this.update({ status: "signed-out", session: { authenticated: false } });
  }

  dispose(): void {
    this.invalidateLifecycle();
    this.listeners.clear();
  }

  clearOneTimeInviteLink(): void {
    if (this.snapshotValue.oneTimeInviteLink) {
      this.update({ oneTimeInviteLink: null, oneTimeInviteTabId: null, oneTimeInviteId: null });
    }
  }

  private async authenticate(path: "/api/teams/login" | "/api/teams/invites/accept", body: object) {
    const generation = this.beginLifecycle();
    this.update({ status: "loading", error: null });
    try {
      const payload = await this.post(path, body);
      if (!this.isCurrent(generation)) {
        return;
      }
      if (path === "/api/teams/invites/accept") {
        const destination = readInviteDestination(payload);
        if (!destination) {
          throw new Error("The invite destination is unavailable.");
        }
        this.update({ workspaceId: destination.workspaceId, tabId: destination.tabId });
      }
      const session = responseSession(payload);
      if (!session.authenticated) {
        this.update({ status: "signed-out", session, error: "Authentication was not accepted." });
        return;
      }
      await this.useSession(session, generation);
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.clearPortalState();
        this.update({ status: "error", error: errorMessage(error) });
      }
    }
  }

  private async getSession(): Promise<TeamsPortalSession> {
    const response = await this.fetcher("/api/teams/session", { credentials: "include" });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(responseError(payload));
    }
    return responseSession(payload);
  }

  private async post(path: string, body: object): Promise<unknown> {
    return await this.requestJson(path, "POST", body);
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.fetcher(path, { credentials: "include" });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(responseError(payload));
    }
    return payload;
  }

  private async requestJson(
    path: string,
    method: "POST" | "DELETE",
    body: object,
  ): Promise<unknown> {
    const response = await this.fetcher(path, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(responseError(payload));
    }
    return payload;
  }

  private async refreshOwnerSharing(generation: number): Promise<void> {
    try {
      const [presets, invites] = await Promise.all([
        this.get("/api/teams/invite-presets"),
        this.get("/api/teams/invites"),
      ]);
      if (!this.isCurrent(generation)) {
        return;
      }
      this.update({
        ownerSharing: true,
        invitePresets: readInvitePresets(presets),
        ownerInvites: readOwnerInvites(invites),
      });
    } catch {
      // Owner-only endpoints intentionally fail generically for members. Their
      // shared tab remains available; only the owner controls disappear.
      if (this.isCurrent(generation)) {
        this.update({
          ownerSharing: false,
          invitePresets: [],
          ownerInvites: [],
          oneTimeInviteLink: null,
          oneTimeInviteTabId: null,
          oneTimeInviteId: null,
        });
      }
    }
  }

  private async refreshPendingChangeRequests(tabId: string, generation: number): Promise<void> {
    const gateway = this.gateway;
    const workspaceId = this.snapshotValue.workspaceId;
    if (!gateway || !workspaceId) {
      return;
    }
    try {
      const payload = await gateway.request("workspaces.changeRequest.list", {
        workspaceId,
        tabId,
        state: "pending",
      });
      if (
        this.isCurrent(generation) &&
        this.gateway === gateway &&
        this.snapshotValue.selectedShareTabId === tabId
      ) {
        this.update({ pendingChangeRequests: readPendingChangeRequests(payload) });
      }
    } catch {
      if (
        this.isCurrent(generation) &&
        this.gateway === gateway &&
        this.snapshotValue.selectedShareTabId === tabId
      ) {
        this.update({ pendingChangeRequests: [] });
      }
    }
  }

  private async useSession(
    session: Extract<TeamsPortalSession, { authenticated: true }>,
    generation: number,
  ): Promise<void> {
    this.update({ session, status: "loading", error: null });
    this.armExpiry(session.expiresAt);
    const workspaceId = this.snapshotValue.workspaceId;
    const tabId = this.snapshotValue.tabId;
    if (!workspaceId || !tabId) {
      this.update({ status: "ready" });
      return;
    }
    let resolveHello: (() => void) | undefined;
    let rejectHello: ((error: Error) => void) | undefined;
    let helloComplete = false;
    let helloBeforeAssignment = false;
    let closeBeforeAssignment = false;
    let gateway: TeamsPortalGateway | null = null;
    const hello = new Promise<void>((resolve, reject) => {
      resolveHello = resolve;
      rejectHello = reject;
    });
    const previousGateway = this.gateway;
    this.gateway = null;
    if (typeof previousGateway?.stop === "function") {
      previousGateway.stop();
    }
    const createdGateway = this.gatewayFactory({
      url: this.gatewayUrl,
      role: "member",
      scopes: [],
      caps: [],
      onHello: () => {
        if (!helloComplete && this.isCurrent(generation)) {
          helloComplete = true;
          if (gateway && this.gateway === gateway) {
            resolveHello?.();
          } else {
            helloBeforeAssignment = true;
          }
        }
      },
      onClose: () => {
        if (!gateway) {
          closeBeforeAssignment = true;
          return;
        }
        if (!this.isCurrent(generation) || this.gateway !== gateway) {
          return;
        }
        if (!helloComplete) {
          helloComplete = true;
          rejectHello?.(new Error("The Teams connection could not be established."));
          return;
        }
        this.invalidateLifecycle();
        this.update({ status: "error", error: "The Teams connection was lost." });
      },
    }) as TeamsPortalGateway;
    gateway = createdGateway;
    this.gateway = gateway;
    if (closeBeforeAssignment && !helloComplete) {
      helloComplete = true;
      rejectHello?.(new Error("The Teams connection could not be established."));
    } else if (helloBeforeAssignment) {
      resolveHello?.();
    }
    gateway.start?.();
    await hello;
    if (
      !this.isCurrent(generation) ||
      this.gateway !== gateway ||
      !this.snapshotValue.session?.authenticated
    ) {
      return;
    }
    // Canonical owners register tabs before inviting people to them. A member
    // can still load its exact shared tab when the owner-only sync is denied.
    const sharingSync = await gateway
      .request("workspaces.sharing.sync", { workspaceId })
      .catch(() => null);
    const result = readPortalTabResult(
      await gateway.request("workspaces.tab.get", {
        workspaceId,
        id: tabId,
      }),
      { workspaceId, tabId },
    );
    if (!this.isCurrent(generation) || this.gateway !== gateway) {
      return;
    }
    this.update({
      status: "ready",
      tab: result.tab,
      mode: result.capabilityMode,
      draftTitle: result.tab.title,
      error: null,
      shareTabs: readShareTabs(sharingSync),
      selectedShareTabId: tabId,
    });
    await this.refreshOwnerSharing(generation);
    if (sharingSync !== null) {
      await this.refreshPendingChangeRequests(tabId, generation);
    }
  }

  private armExpiry(expiresAt: number): void {
    this.clearExpiryTimer();
    if (!Number.isFinite(expiresAt)) {
      return;
    }
    this.expiryTimer = window.setTimeout(
      () => this.expireSession(),
      Math.max(0, expiresAt - Date.now()),
    );
  }

  private clearPortalState(): void {
    this.clearExpiryTimer();
    const gateway = this.gateway;
    this.gateway = null;
    if (typeof gateway?.stop === "function") {
      gateway.stop();
    }
    this.inviteCode = null;
    this.snapshotValue = {
      ...this.snapshotValue,
      session: null,
      tab: null,
      mode: null,
      draftTitle: "",
      error: null,
      invitePending: false,
      ownerSharing: false,
      invitePresets: [],
      ownerInvites: [],
      oneTimeInviteLink: null,
      oneTimeInviteTabId: null,
      oneTimeInviteId: null,
      shareTabs: [],
      selectedShareTabId: null,
      pendingChangeRequests: [],
    };
  }

  private beginLifecycle(): number {
    this.lifecycleGeneration += 1;
    this.clearPortalState();
    return this.lifecycleGeneration;
  }

  private invalidateLifecycle(): void {
    this.lifecycleGeneration += 1;
    this.clearPortalState();
  }

  private isCurrent(generation: number): boolean {
    return generation === this.lifecycleGeneration;
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== null) {
      window.clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private update(patch: Partial<TeamsPortalSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    for (const listener of this.listeners) {
      listener(this.snapshotValue);
    }
  }
}

type TeamsPortalActions = {
  onLogin?: (params: LoginParams) => void;
  onAcceptInvite?: (params: Omit<InviteParams, "code">) => void;
  onDraftTitle?: (title: string) => void;
  onSubmitDraft?: () => void;
  onLogout?: () => void;
  onCreateOwnerInvite?: (params: { preset: TeamsInvitePreset; recipientLabel?: string }) => void;
  onRevokeOwnerInvite?: (id: string) => void;
  onSelectShareTab?: (tabId: string) => void;
  onDecideChangeRequest?: (params: {
    requestId: string;
    decision: "approved" | "rejected";
  }) => void;
};

function formValues(event: SubmitEvent): {
  loginLabel: string;
  password: string;
  domainId: string;
} {
  const values = new FormData(event.currentTarget as HTMLFormElement);
  return {
    loginLabel: String(values.get("loginLabel") ?? ""),
    password: String(values.get("password") ?? ""),
    domainId: String(values.get("domainId") ?? ""),
  };
}

function renderWidget(widget: TeamsPortalWidget): TemplateResult {
  if (!["builtin:markdown", "builtin:stat-card", "builtin:table"].includes(widget.kind)) {
    return html`<li data-teams-widget="restricted">Restricted content</li>`;
  }
  return html`<li data-teams-widget=${widget.kind}>${widget.title ?? "Untitled widget"}</li>`;
}

function presetLabel(preset: TeamsInvitePreset): string {
  return preset === "read" ? "Read" : preset === "request" ? "Request changes" : "Write";
}

export function renderTeamsPortal(
  snapshot: TeamsPortalSnapshot,
  actions: TeamsPortalActions = {},
): TemplateResult {
  const editable = snapshot.mode === "request" || snapshot.mode === "write";
  const submitLabel = snapshot.mode === "request" ? "Request change" : "Save change";
  const visibleInvites = (snapshot.ownerInvites ?? []).filter(
    (invite) => invite.tabId === snapshot.selectedShareTabId,
  );
  const visibleOneTimeInviteLink =
    snapshot.oneTimeInviteTabId === snapshot.selectedShareTabId ? snapshot.oneTimeInviteLink : null;
  return html`
    <main class="teams-portal" aria-live="polite">
      <header>
        <h1>Teams</h1>
        ${snapshot.session?.authenticated
          ? html`<button @click=${actions.onLogout}>Log out</button>`
          : ""}
      </header>
      ${snapshot.error ? html`<p role="alert">${snapshot.error}</p>` : ""}
      ${snapshot.status === "loading" ? html`<p>Loading…</p>` : ""}
      ${snapshot.status === "signed-out" && snapshot.route === "invite" && snapshot.invitePending
        ? html`<form
            @submit=${(event: SubmitEvent) => {
              event.preventDefault();
              const values = formValues(event);
              actions.onAcceptInvite?.({
                loginLabel: values.loginLabel,
                password: values.password,
              });
            }}
          >
            <label>Email <input name="loginLabel" autocomplete="username" required /></label>
            <label
              >Password <input name="password" type="password" autocomplete="new-password" required
            /></label>
            <button type="submit">Accept invite</button>
          </form>`
        : ""}
      ${snapshot.status === "signed-out" && (!snapshot.invitePending || snapshot.route === "login")
        ? html`<form
            @submit=${(event: SubmitEvent) => {
              event.preventDefault();
              const values = formValues(event);
              actions.onLogin?.(values);
            }}
          >
            <label>Email <input name="loginLabel" autocomplete="username" required /></label>
            <label
              >Password
              <input name="password" type="password" autocomplete="current-password" required
            /></label>
            <label>Domain <input name="domainId" required /></label>
            <button type="submit">Log in</button>
          </form>`
        : ""}
      ${snapshot.tab
        ? html`<section>
            <h2>${snapshot.tab.title}</h2>
            <ul>
              ${snapshot.tab.widgets.map(renderWidget)}
            </ul>
            ${editable
              ? html`<label
                    >Title
                    <input
                      data-teams-draft
                      .value=${snapshot.draftTitle}
                      @input=${(event: InputEvent) =>
                        actions.onDraftTitle?.((event.target as HTMLInputElement).value)}
                    />
                  </label>
                  <button data-action="submit-draft" @click=${actions.onSubmitDraft}>
                    ${submitLabel}
                  </button>`
              : ""}
            ${snapshot.ownerSharing
              ? html`<section data-teams-owner-sharing aria-label="Share this tab">
                  <h3>Share this tab</h3>
                  <form
                    @submit=${(event: SubmitEvent) => {
                      event.preventDefault();
                      const values = new FormData(event.currentTarget as HTMLFormElement);
                      const preset = values.get("preset");
                      if (!isInvitePreset(preset)) {
                        return;
                      }
                      const recipientLabel = String(values.get("recipientLabel") ?? "").trim();
                      actions.onCreateOwnerInvite?.({
                        preset,
                        ...(recipientLabel ? { recipientLabel } : {}),
                      });
                    }}
                  >
                    <label
                      >Access
                      <select name="preset" required>
                        ${(snapshot.invitePresets ?? []).map(
                          (preset) => html`<option value=${preset}>${presetLabel(preset)}</option>`,
                        )}
                      </select>
                    </label>
                    <label
                      >Tab
                      <select
                        data-teams-share-tab
                        .value=${snapshot.selectedShareTabId ?? ""}
                        @change=${(event: Event) =>
                          actions.onSelectShareTab?.((event.target as HTMLSelectElement).value)}
                      >
                        ${(snapshot.shareTabs ?? []).map(
                          (tab) => html`<option value=${tab.id}>${tab.title}</option>`,
                        )}
                      </select>
                    </label>
                    <label
                      >Recipient (optional) <input name="recipientLabel" autocomplete="off"
                    /></label>
                    <button type="submit">Create invite</button>
                  </form>
                  ${visibleOneTimeInviteLink
                    ? html`<label
                        >One-time invite link
                        <input
                          readonly
                          .value=${visibleOneTimeInviteLink}
                          aria-label="One-time invite link"
                        />
                      </label>`
                    : ""}
                  <ul>
                    ${visibleInvites.map(
                      (invite) => html`<li>
                        ${`${presetLabel(invite.preset)} ${invite.state}`}${invite.recipientLabel
                          ? ` for ${invite.recipientLabel}`
                          : ""}
                        ${invite.state === "active"
                          ? html`<button @click=${() => actions.onRevokeOwnerInvite?.(invite.id)}>
                              Revoke
                            </button>`
                          : ""}
                      </li>`,
                    )}
                  </ul>
                  ${(snapshot.pendingChangeRequests ?? []).length
                    ? html`<h4>Pending changes</h4>
                        <ul>
                          ${(snapshot.pendingChangeRequests ?? []).map(
                            (request) => html`<li>
                              ${request.requester} requested “${request.proposedTitle}”
                              <button
                                @click=${() =>
                                  actions.onDecideChangeRequest?.({
                                    requestId: request.id,
                                    decision: "approved",
                                  })}
                              >
                                Approve
                              </button>
                              <button
                                @click=${() =>
                                  actions.onDecideChangeRequest?.({
                                    requestId: request.id,
                                    decision: "rejected",
                                  })}
                              >
                                Reject
                              </button>
                            </li>`,
                          )}
                        </ul>`
                    : ""}
                </section>`
              : ""}
          </section>`
        : ""}
    </main>
  `;
}

export function mountTeamsPortal(params: {
  host: HTMLElement;
  route: TeamsPortalRoute;
  location?: Pick<Location, "pathname" | "search" | "hash">;
  history?: Pick<History, "replaceState">;
}): () => void {
  const location = params.location ?? window.location;
  const history = params.history ?? window.history;
  const search = new URLSearchParams(location.search);
  const store = new TeamsPortalStore();
  const redraw = () => {
    render(
      renderTeamsPortal(store.snapshot, {
        onLogin: (input) => void store.login(input),
        onAcceptInvite: (input) => void store.acceptInvite(input),
        onDraftTitle: (title) => store.setDraftTitle(title),
        onSubmitDraft: () => void store.submitDraft(),
        onLogout: () => void store.logout(),
        onCreateOwnerInvite: (input) => void store.createOwnerInvite(input),
        onRevokeOwnerInvite: (id) => void store.revokeOwnerInvite(id),
        onSelectShareTab: (tabId) => store.setSelectedShareTabId(tabId),
        onDecideChangeRequest: (input) => void store.decideOwnerChangeRequest(input),
      }),
      params.host,
    );
  };
  const unsubscribe = store.subscribe(redraw);
  redraw();
  const inviteCode =
    params.route === "invite" ? consumeInviteCodeFromFragment(location, history) : null;
  void store.start({
    route: params.route,
    workspaceId: search.get("workspaceId"),
    tabId: search.get("tabId"),
    inviteCode,
  });
  const clearOneTimeInviteLink = () => store.clearOneTimeInviteLink();
  window.addEventListener("pagehide", clearOneTimeInviteLink);
  window.addEventListener("popstate", clearOneTimeInviteLink);
  return () => {
    unsubscribe();
    window.removeEventListener("pagehide", clearOneTimeInviteLink);
    window.removeEventListener("popstate", clearOneTimeInviteLink);
    store.dispose();
    render(null, params.host);
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Unable to load the Teams portal.";
}
