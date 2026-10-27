import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  FsListDirResult,
  ProjectRecord,
  ProjectRecent,
  ProjectsRegisterResult,
  ProjectsSearchRemoteResult,
  WorktreesBranchesResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { projectsForGateway, type ProjectCatalog } from "../../lib/projects.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { isAbsolutePath, isKnownWorkspacePath } from "./path.ts";
import { PICKER_INPUT_DEBOUNCE_MS, PlaceBrowserState } from "./place-browser-state.ts";
import { projectCloneInput, type DraftRemoteProject } from "./project-chip.ts";

type ProjectSearchOutcome = { result: ProjectsSearchRemoteResult } | { error: unknown } | null;

type ProjectSearchRead = Readonly<{
  query: string;
  completed: Promise<ProjectSearchOutcome>;
}>;

export type BrowserProjectRegistration = Readonly<{
  retired: Promise<void>;
  isCurrent: () => boolean;
}>;

type DraftPickerKind = "where" | "project" | "checkout";
export type ProjectBrowserFocus = Partial<Record<"browse" | "path", HTMLElement>>;

type DraftPlaceBrowserSnapshot = Readonly<{
  context: ApplicationContext | undefined;
  isAdmin: boolean;
}>;

type DraftProjectSelection =
  | { kind: "local"; id: string }
  | { kind: "remote"; project: DraftRemoteProject }
  | null;

type DraftPlaceBrowserCallbacks = {
  changed: () => void;
  updateComplete: () => Promise<unknown>;
  onProjectMissing: () => void;
  onSelectProject: (projectId: string) => void;
  onApprovedListing: (listing: FsListDirResult) => void;
  activeElement: () => Element | null;
};

export class DraftPlaceBrowser {
  readonly projectFocus: ProjectBrowserFocus = {};
  private projectCatalog: ProjectCatalog | undefined;
  private projectCatalogCleanup: (() => void) | undefined;
  private projectCatalogGateway: ApplicationContext["gateway"] | undefined;
  private lastProjectResult: ProjectCatalog["snapshot"]["result"] = null;
  private projectSelection: DraftProjectSelection = null;
  private selectedProjectRecord: ProjectRecord | undefined;
  private projectQueryValue = "";
  private environmentQueryValue = "";
  private debouncedProjectQuery = "";
  private browserOpenValue = false;
  // Empty lists the Gateway host; otherwise the paired device whose folders are listed.
  private browserNodeIdValue = "";
  private browserProjectPathValue: string | null = null;
  private browserRegistration: {
    retire: () => void;
    client: GatewayBrowserClient;
    epoch: number;
  } | null = null;
  private openPopoverValue: DraftPickerKind | null = null;
  private focusRequestId = 0;
  private projectSearchTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  readonly browser: PlaceBrowserState;

  private projectSearchArgs: readonly unknown[] = [];
  private projectSearchReadValue: ProjectSearchRead | null = null;
  private finishProjectSearch: ((outcome: ProjectSearchOutcome) => void) | undefined;
  private readonly projectSearchRequest = createPageRequest(() => this.callbacks.changed(), {
    task: ([client, query]: readonly [GatewayBrowserClient, string], { signal }) =>
      client.request<ProjectsSearchRemoteResult>("projects.searchRemote", { query }, { signal }),
    onComplete: (result) => {
      this.finishProjectSearch?.({ result });
      this.finishProjectSearch = undefined;
    },
    onError: (error) => {
      this.finishProjectSearch?.({ error });
      this.finishProjectSearch = undefined;
    },
  });

  constructor(
    private readonly gateway: DraftGatewayState,
    private readonly read: () => DraftPlaceBrowserSnapshot,
    private readonly callbacks: DraftPlaceBrowserCallbacks,
  ) {
    this.browser = new PlaceBrowserState(
      (path) => {
        const snapshot = this.read().context?.gateway.snapshot;
        if (snapshot?.phase !== "connected" || !snapshot.client || !this.browserOpenValue) {
          return Promise.reject(new Error("Folder browser is unavailable"));
        }
        return snapshot.client.request<FsListDirResult>("fs.listDir", {
          ...(this.browserNodeIdValue ? { nodeId: this.browserNodeIdValue } : {}),
          ...(path ? { path } : {}),
        });
      },
      this.callbacks.changed,
      (listing) => {
        this.browserProjectPathValue = null;
        if (this.browserNodeIdValue) {
          // Gateway folder approval and project registration apply only to Gateway paths.
          return;
        }
        this.callbacks.onApprovedListing(listing);
        const snapshot = this.read();
        const client = snapshot.context?.gateway.snapshot.client;
        if (!snapshot.isAdmin || !client) {
          return;
        }
        void client
          .request<WorktreesBranchesResult>("worktrees.branches", {
            repoRoot: listing.path,
            includeRepositoryStatus: true,
          })
          .then((branches) => {
            // Typing keeps this listing valid; replacement or reset retires its probe.
            if (this.browser.listing === listing && branches.repositoryStatus === "git") {
              this.browserProjectPathValue = listing.path;
              this.callbacks.changed();
            }
          })
          .catch(() => undefined);
      },
    );
  }

  synchronize() {
    const registration = this.browserRegistration;
    if (
      registration &&
      (!this.gateway.connected ||
        registration.client !== this.gateway.client ||
        registration.epoch !== this.gateway.connectionEpoch)
    ) {
      this.retireRegistration();
    }
    this.bindProjectCatalog();
    const args = this.projectSearchInput();
    if (!args.every((arg, index) => Object.is(arg, this.projectSearchArgs[index]))) {
      this.searchProjects(args);
    }
  }

  private projectSearchInput() {
    return [
      this.read().context && this.gateway.connected ? this.gateway.client : null,
      canCallGatewayMethod(
        this.read().context?.gateway.snapshot,
        "projects.searchRemote",
        "operator.read",
      ),
      this.debouncedProjectQuery,
      this.gateway.connectionEpoch,
    ] as const;
  }

  private searchProjects(args = this.projectSearchInput()) {
    this.projectSearchArgs = args;
    this.projectSearchRequest.cancel();
    // A cancelled transport may never settle; retire its presentation immediately.
    this.finishProjectSearch?.(null);
    this.finishProjectSearch = undefined;
    this.projectSearchReadValue = null;
    const [client, advertised, query] = args;
    if (!client || !advertised || query.length < 2 || projectCloneInput(query)) {
      return;
    }
    const completion = Promise.withResolvers<ProjectSearchOutcome>();
    this.projectSearchReadValue = { query, completed: completion.promise };
    this.finishProjectSearch = completion.resolve;
    void this.projectSearchRequest.run([client, query]);
  }

  get projects(): readonly ProjectRecord[] {
    return this.projectCatalog?.snapshot.result?.projects ?? [];
  }

  get projectsReady(): boolean {
    return this.projectCatalog?.snapshot.ready ?? false;
  }

  get projectsLoading(): boolean {
    return this.projectCatalog?.loading ?? false;
  }

  get projectRead(): Promise<void> | null {
    return this.projectCatalog?.pendingRead ?? null;
  }

  get projectRecents(): readonly ProjectRecent[] | undefined {
    return this.projectCatalog?.snapshot.result?.recents;
  }

  get githubHost(): string | undefined {
    return this.projectCatalog?.snapshot.result?.githubHost;
  }

  get defaultRemoteProject(): DraftRemoteProject | null {
    const configured = this.projectCatalog?.snapshot.result?.defaultRepository;
    return configured
      ? {
          identity: configured.identity,
          cloneUrl: configured.url,
          ...(configured.ref ? { defaultBranch: configured.ref } : {}),
        }
      : null;
  }

  get defaultRemoteProjectProfileId(): string {
    return this.projectCatalog?.snapshot.result?.defaultRepository?.profileId ?? "";
  }

  get projectId(): string {
    return this.projectSelection?.kind === "local" ? this.projectSelection.id : "";
  }

  get remoteProject(): DraftRemoteProject | null {
    return this.projectSelection?.kind === "remote" ? this.projectSelection.project : null;
  }

  get projectQuery(): string {
    return this.projectQueryValue;
  }

  get environmentQuery(): string {
    return this.environmentQueryValue;
  }

  changeEnvironmentQuery(query: string) {
    this.environmentQueryValue = query;
    this.callbacks.changed();
  }

  get projectSearchRead(): ProjectSearchRead | null {
    return this.projectSearchReadValue?.query === this.projectQueryValue.trim()
      ? this.projectSearchReadValue
      : null;
  }

  get browserOpen(): boolean {
    return this.browserOpenValue;
  }

  get browserNodeId(): string {
    return this.browserNodeIdValue;
  }

  get browserProjectPath(): string | null {
    // The register affordance and fence follow the draft's directory, not just loading state.
    // A shown error (failed navigate or failed registration) leaves the loaded folder valid,
    // so the action stays available for a retry.
    return this.browser.loading || !this.browser.draftInLoadedDirectory()
      ? null
      : this.browserProjectPathValue;
  }

  get browserRegistering(): boolean {
    return this.browserRegistration !== null;
  }

  popoverOpen(kind: DraftPickerKind): boolean {
    return this.openPopoverValue === kind;
  }

  popoverCallbacks(kind: DraftPickerKind) {
    return {
      popoverOpen: this.popoverOpen(kind),
      onPopoverShow: () => this.transitionPopover(kind, true),
      onPopoverHide: () => this.transitionPopover(kind, false),
      onPopoverAfterHide: this.callbacks.changed,
    };
  }

  private bindProjectCatalog() {
    const gateway = this.gateway.connected ? this.read().context?.gateway : undefined;
    if (gateway === this.projectCatalogGateway) {
      return;
    }
    this.projectCatalogCleanup?.();
    this.projectCatalogGateway = gateway;
    this.projectCatalog = gateway ? projectsForGateway(gateway) : undefined;
    this.lastProjectResult = null;
    const update = () => {
      const result = this.projectCatalog?.snapshot.result ?? null;
      if (result && result !== this.lastProjectResult) {
        this.lastProjectResult = result;
        if (this.projectId && !result.projects.some((project) => project.id === this.projectId)) {
          this.callbacks.onProjectMissing();
        }
      }
      this.callbacks.changed();
    };
    // Catalog receipts clear vanished project selections before the next draft read.
    this.projectCatalogCleanup = this.projectCatalog?.subscribe(update);
    update();
  }

  async refreshProjects(invalidate = false): Promise<void> {
    this.bindProjectCatalog();
    await this.projectCatalog?.refresh(invalidate);
  }

  selectedProject(): ProjectRecord | undefined {
    return (
      this.projects.find((project) => project.id === this.projectId) ??
      (this.gateway.connected ? undefined : this.selectedProjectRecord)
    );
  }

  selectProject(selection: Exclude<DraftProjectSelection, null>) {
    this.projectSelection = selection;
    this.selectedProjectRecord = this.projects.find((project) => project.id === this.projectId);
  }

  recordRemoteProjectId(cloneUrl: string, projectId: string) {
    const project = this.remoteProject;
    if (project?.cloneUrl === cloneUrl) {
      this.projectSelection = { kind: "remote", project: { ...project, projectId } };
    }
  }

  clearProjectSelection() {
    this.projectSelection = null;
    this.selectedProjectRecord = undefined;
  }

  resolveProjectRecents(params: {
    sessions: readonly {
      execCwd?: unknown;
      execNode?: unknown;
      worktree?: { repoRoot?: unknown } | null;
    }[];
    workspace: string;
    workspaceRoots: readonly string[];
    isAdmin: boolean;
  }): ProjectRecent[] {
    const allowGatewayFolder = (folder: string) =>
      params.isAdmin || isKnownWorkspacePath(params.workspaceRoots, folder);
    const serverRecents = this.projectRecents?.filter((recent) =>
      recent.kind === "project"
        ? this.projects.some((project) => project.id === recent.projectId)
        : recent.kind === "repository" || (!recent.execNode && allowGatewayFolder(recent.folder)),
    );
    if (serverRecents !== undefined) {
      return serverRecents;
    }
    const folders = new Set<string>();
    for (const row of params.sessions) {
      const folder =
        normalizeOptionalString(row.execCwd) ?? normalizeOptionalString(row.worktree?.repoRoot);
      const execNode = normalizeOptionalString(row.execNode);
      if (!folder || execNode || folder === params.workspace || !allowGatewayFolder(folder)) {
        continue;
      }
      folders.add(folder);
      if (folders.size >= 4) {
        break;
      }
    }
    return Array.from(folders, (folder): ProjectRecent => ({
      kind: "folder",
      folder,
      displayName: pathDisplayName(folder),
    }));
  }

  changeProjectQuery(query: string) {
    this.projectQueryValue = query;
    this.clearProjectSearchTimer();
    this.debouncedProjectQuery = "";
    this.searchProjects([null, false, "", this.gateway.connectionEpoch]);
    const normalized = query.trim();
    const context = this.read().context;
    if (
      normalized.length < 2 ||
      projectCloneInput(normalized) ||
      !this.gateway.connected ||
      !this.gateway.client ||
      !context ||
      !canCallGatewayMethod(context.gateway.snapshot, "projects.searchRemote", "operator.read")
    ) {
      this.callbacks.changed();
      return;
    }
    const client = this.gateway.client;
    const connectionEpoch = this.gateway.connectionEpoch;
    this.projectSearchTimer = globalThis.setTimeout(() => {
      this.projectSearchTimer = undefined;
      if (client !== this.gateway.client || connectionEpoch !== this.gateway.connectionEpoch) {
        return;
      }
      this.debouncedProjectQuery = normalized;
      this.searchProjects([client, true, normalized, connectionEpoch]);
      this.callbacks.changed();
    }, PICKER_INPUT_DEBOUNCE_MS);
    this.callbacks.changed();
  }

  resetProjectSearch() {
    this.clearProjectSearchTimer();
    this.projectQueryValue = "";
    this.debouncedProjectQuery = "";
    this.callbacks.changed();
  }

  resetProjects(resetSelection = true) {
    // The shared catalog retires connection/principal results at its owner.
    if (this.projectCatalog) {
      void this.refreshProjects(true);
    }
    if (!resetSelection) {
      return;
    }
    this.clearProjectSelection();
    this.resetProjectSearch();
  }

  close() {
    this.resetBrowser(true);
  }

  showRoot() {
    const wasBrowsing = this.browserOpenValue;
    this.resetBrowser(false);
    if (wasBrowsing) {
      this.focusProjectView("browse");
    }
  }

  selectGatewayBrowser(path?: string) {
    this.openBrowser("", path);
  }

  selectDeviceBrowser(nodeId: string, path?: string) {
    this.openBrowser(nodeId, path);
  }

  private openBrowser(nodeId: string, path?: string) {
    this.browserOpenValue = true;
    this.browserNodeIdValue = nodeId;
    this.browserProjectPathValue = null;
    void this.browser.navigate(path && isAbsolutePath(path) ? path : undefined, "initial");
    this.focusProjectView("path");
  }

  async registerBrowserProject(
    path: string,
    onStarted?: (registration: BrowserProjectRegistration) => void,
  ) {
    const snapshot = this.read();
    const gatewaySnapshot = snapshot.context?.gateway.snapshot;
    const client = gatewaySnapshot?.client;
    if (
      gatewaySnapshot?.phase !== "connected" ||
      !client ||
      !snapshot.isAdmin ||
      this.browserProjectPath !== path ||
      this.browserRegistering
    ) {
      return;
    }
    const listing = this.browser.listing;
    const retirement = Promise.withResolvers<void>();
    const epoch = this.gateway.connectionEpoch;
    const operation = { retire: retirement.resolve, client, epoch };
    this.browserRegistration = operation;
    const isCurrentBrowser = () =>
      this.gateway.connected &&
      this.browser.listing === listing &&
      this.browserProjectPath === path &&
      client === this.gateway.client &&
      epoch === this.gateway.connectionEpoch;
    const isCurrentRegistration = () =>
      this.browserRegistration === operation && isCurrentBrowser();
    this.browser.error = null;
    // Retire the preceding directory error without hiding reads started during registration.
    this.browser.readCompletion = null;
    this.callbacks.changed();
    onStarted?.({ retired: retirement.promise, isCurrent: isCurrentBrowser });
    try {
      const project = await client.request<ProjectsRegisterResult>("projects.register", { path });
      if (!isCurrentRegistration()) {
        return;
      }
      await this.refreshProjects(true);
      if (!isCurrentRegistration()) {
        return;
      }
      this.callbacks.onSelectProject(project.id);
      this.close();
    } catch (error) {
      if (isCurrentRegistration()) {
        this.browser.error = formatUiError(error);
      }
    } finally {
      if (this.browserRegistration === operation) {
        this.browserRegistration = null;
        this.callbacks.changed();
      }
    }
  }

  private transitionPopover(kind: DraftPickerKind, showing: boolean) {
    if (showing) {
      this.openPopoverValue = kind;
      if (kind === "where") {
        this.environmentQueryValue = "";
      }
    } else if (this.openPopoverValue === kind) {
      this.openPopoverValue = null;
    }
    if (kind === "project") {
      this.showRoot();
    } else {
      this.callbacks.changed();
    }
  }

  disconnect() {
    this.focusRequestId += 1;
    this.environmentQueryValue = "";
    this.browser.reset();
    this.retireRegistration();
    this.clearProjectSearchTimer();
    this.projectCatalogCleanup?.();
    this.projectCatalogCleanup = undefined;
    this.projectCatalogGateway = undefined;
    this.projectCatalog = undefined;
    this.searchProjects([null, false, "", -1]);
  }

  private resetBrowser(closePopover: boolean) {
    this.focusRequestId += 1;
    this.browser.reset();
    this.browserOpenValue = false;
    this.browserNodeIdValue = "";
    this.browserProjectPathValue = null;
    this.retireRegistration();
    if (closePopover) {
      this.openPopoverValue = null;
    }
    this.callbacks.changed();
  }

  private retireRegistration() {
    this.browserRegistration?.retire();
    this.browserRegistration = null;
  }

  private clearProjectSearchTimer() {
    globalThis.clearTimeout(this.projectSearchTimer);
    this.projectSearchTimer = undefined;
  }

  private focusProjectView(kind: keyof ProjectBrowserFocus) {
    const requestId = ++this.focusRequestId;
    const origin = this.callbacks.activeElement();
    void this.callbacks.updateComplete().then(() => {
      if (requestId !== this.focusRequestId || this.openPopoverValue !== "project") {
        return;
      }
      const active = this.callbacks.activeElement();
      const target = this.projectFocus[kind];
      if (
        target?.isConnected &&
        (!active || active === origin || active === active.ownerDocument.body)
      ) {
        target.focus({ preventScroll: true });
      }
    });
  }
}
