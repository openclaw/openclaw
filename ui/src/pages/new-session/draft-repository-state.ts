import {
  GatewayProtocolRequestError,
  readMissingScopeError,
} from "@openclaw/gateway-client/browser";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  AgentSummary,
  ProjectRecord,
  ProjectsCheckoutOptionsResult,
  WorktreesBranchesResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { DraftRepositoryState } from "./discovery.ts";
import type { SubmittedWorktreePreference } from "./draft-preference-state.ts";
import type { NewSessionPreference } from "./preferences.ts";
import type { DraftRemoteProject } from "./project-chip.ts";

type DraftRepositorySnapshot = Readonly<{
  agentId: string;
  agents: readonly AgentSummary[];
  remotePlacement: boolean;
  selectedProject: ProjectRecord | undefined;
  remoteProject: DraftRemoteProject | null;
  folder: string;
  workspace: string;
  workspaceGit: boolean;
  gateway: ApplicationContext["gateway"]["snapshot"] | undefined;
}>;

type DraftRepositoryCallbacks = {
  changed: () => void;
  persistPreference: (patch: NewSessionPreference) => void;
  capturePreferenceConsumption: (
    owner: Readonly<{ agentId: string; workspace: string }>,
    expected: SubmittedWorktreePreference,
  ) => ((consume: () => void) => void | Promise<void>) | undefined;
};

type ResolvedRepository = Exclude<DraftRepositoryState, { kind: "checking" }>;

function initialRepositoryState(snapshot: DraftRepositorySnapshot): DraftRepositoryState {
  if (snapshot.remoteProject) {
    return { kind: "pending-clone", cloneUrl: snapshot.remoteProject.cloneUrl };
  }
  if (snapshot.selectedProject && !snapshot.selectedProject.repoRoot) {
    // Path-redacted registered projects use creation-time validation by project ID.
    return snapshot.selectedProject.source === "workspace"
      ? { kind: "idle" }
      : { kind: "pending-project", projectId: snapshot.selectedProject.id };
  }
  const repoRoot =
    snapshot.selectedProject?.repoRoot ?? (snapshot.folder.trim() || snapshot.workspace);
  if (!repoRoot) {
    return { kind: "idle" };
  }
  return !snapshot.selectedProject && repoRoot === snapshot.workspace && !snapshot.workspaceGit
    ? { kind: "direct", repoRoot }
    : { kind: "checking", repoRoot };
}

/** Owns synchronous checkout intent and pending discovery across draft handoffs. */
export class DraftRepositoryStateOwner {
  private worktreeValue = false;
  private readonly details: { baseRef?: string; worktreeName: string } = { worktreeName: "" };
  private repositoryValue: DraftRepositoryState = { kind: "idle" };
  private requestToken = 0;
  private checkoutScope: { project: ProjectRecord; agentId: string } | undefined;
  private checkoutOptions: ProjectsCheckoutOptionsResult | "loading" | "error" | undefined;

  private selectionRevision = 0;
  private preferredWorktreeRestore = false;
  private worktreeSelectedByUser = false;
  private readonly selectedDetails = new Set<"baseRef" | "worktreeName">();

  constructor(
    private readonly read: () => DraftRepositorySnapshot,
    private readonly callbacks: DraftRepositoryCallbacks,
  ) {}

  private matchesProjectCheckout(): boolean {
    const { selectedProject, agentId, remotePlacement } = this.read();
    return remotePlacement || !selectedProject
      ? !this.checkoutScope
      : this.checkoutScope?.project === selectedProject && this.checkoutScope.agentId === agentId;
  }

  get currentCheckoutUnavailable(): "checking" | "unavailable" | "worktree" | undefined {
    const snapshot = this.read();
    if (!snapshot.selectedProject || snapshot.remotePlacement) {
      return undefined;
    }
    const options = this.checkoutOptions;
    if (!this.matchesProjectCheckout() || !options || options === "loading") {
      return "checking";
    }
    if (options === "error") {
      return "unavailable";
    }
    return options.current ? undefined : options.worktree ? "worktree" : "unavailable";
  }

  get checkoutSubmissionBlocked(): boolean {
    if (!this.read().selectedProject || this.read().remotePlacement) {
      return false;
    }
    const options = this.checkoutOptions;
    return (
      !this.matchesProjectCheckout() ||
      !options ||
      typeof options === "string" ||
      !(this.worktreeValue ? options.worktree : options.current)
    );
  }

  synchronizeProjectCheckout() {
    if (!this.matchesProjectCheckout()) {
      this.load();
    }
  }

  get worktree(): boolean {
    return this.worktreeValue;
  }

  get preferenceWorktree(): boolean {
    return this.worktreeValue || this.preferredWorktreeRestore;
  }

  get worktreeName(): string {
    return this.details.worktreeName;
  }

  get baseRef(): string {
    // An omitted ref lets the Gateway fetch its default; discovery is only a suggestion.
    return this.details.baseRef ?? "";
  }

  get remoteRepository(): SessionCreateParams["repository"] {
    const { remotePlacement, remoteProject } = this.read();
    if (!remotePlacement || !remoteProject) {
      return undefined;
    }
    const ref = this.baseRef.trim();
    return { url: remoteProject.cloneUrl, ...(ref ? { ref } : {}) };
  }

  get repository(): DraftRepositoryState {
    return this.repositoryValue;
  }

  get preferenceReady(): boolean {
    return !this.preferredWorktreeRestore;
  }

  get hasUserSelection(): boolean {
    return this.worktreeSelectedByUser || this.selectedDetails.size > 0;
  }

  adoptPreference(preference: NewSessionPreference | null) {
    if (!this.worktreeSelectedByUser) {
      this.worktreeValue = false;
      // Remote worktree flags describe placement isolation, not a local checkout choice.
      this.preferredWorktreeRestore =
        preference?.worktree === true && (!preference.where || preference.where.kind === "local");
    }
    if (!this.selectedDetails.has("baseRef")) {
      const baseRef = preference?.baseRef || undefined;
      if (this.details.baseRef !== baseRef) {
        this.selectionRevision += 1;
      }
      this.details.baseRef = baseRef;
    }
    if (!this.selectedDetails.has("worktreeName")) {
      const worktreeName = preference?.worktreeName ?? "";
      if (this.details.worktreeName !== worktreeName) {
        this.selectionRevision += 1;
      }
      this.details.worktreeName = worktreeName;
    }
    if (!this.matchesCurrentRepo()) {
      // Retire the old folder's RPC before it can consume the new preference.
      this.invalidate();
    } else if (this.repositoryValue.kind !== "checking") {
      this.adoptResolvedRepository(this.repositoryValue);
    }
  }

  reset() {
    this.invalidate();
    this.worktreeValue = false;
    this.clearDetails();
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = false;
  }

  clearDetails(persist = false) {
    this.selectionRevision += 1;
    this.details.baseRef = undefined;
    this.details.worktreeName = "";
    this.selectedDetails.clear();
    if (persist) {
      this.callbacks.persistPreference({ baseRef: "", worktreeName: "" });
    }
  }

  invalidate() {
    this.requestToken += 1;
    this.repositoryValue = { kind: "idle" };
    this.checkoutScope = undefined;
    this.checkoutOptions = undefined;
  }

  selectWorktree(value: boolean, clearName = true) {
    this.selectionRevision += 1;
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = true;
    this.worktreeValue = value;
    if (clearName) {
      this.clearDetails(true);
    }
  }

  rejectPreferredWorktree() {
    this.preferredWorktreeRestore = false;
    this.worktreeValue = false;
    this.clearDetails(true);
  }

  select(value: boolean): boolean {
    if (
      this.worktreeValue === value ||
      this.read().remotePlacement ||
      (value ? !this.available() : Boolean(this.currentCheckoutUnavailable))
    ) {
      return false;
    }
    this.selectWorktree(value, false);
    this.callbacks.persistPreference({
      folder: this.read().folder.trim() || this.read().workspace,
      worktree: this.worktreeValue,
    });
    this.callbacks.changed();
    return true;
  }

  setDetail(key: "baseRef" | "worktreeName", value: string, submitting: boolean) {
    if (submitting) {
      return;
    }
    this.selectionRevision += 1;
    this.details[key] = value;
    this.selectedDetails.add(key);
    this.callbacks.persistPreference({ [key]: value });
    this.callbacks.changed();
  }

  captureSubmittedName(
    params: Pick<
      SessionCreateParams,
      "worktree" | "worktreeName" | "worktreeBaseRef" | "cwd" | "projectId"
    >,
    submission: Readonly<{ agentId: string; recovered?: boolean }>,
  ) {
    const name = params.worktreeName?.trim();
    if (!params.worktree || !name) {
      return undefined;
    }
    const revision = this.selectionRevision;
    const snapshot = this.read();
    const agentId = normalizeAgentId(submission.agentId);
    const agent = snapshot.agents.find((candidate) => normalizeAgentId(candidate.id) === agentId);
    const owner = { agentId, workspace: normalizeOptionalString(agent?.workspace) ?? "" };
    const currentAgent = owner.agentId === snapshot.agentId;
    const persist = this.callbacks.capturePreferenceConsumption(owner, {
      worktreeName: name,
      ...(!submission.recovered ? { selectedBaseRef: this.details.baseRef?.trim() ?? "" } : {}),
      folder:
        params.cwd ?? (currentAgent ? snapshot.folder.trim() || owner.workspace : owner.workspace),
      baseRef: params.worktreeBaseRef ?? (currentAgent ? this.baseRef : undefined),
      projectId: params.projectId ?? (currentAgent ? snapshot.selectedProject?.id : undefined),
    });
    return (
      persist &&
      (() =>
        persist(() => {
          if (
            owner.agentId !== this.read().agentId ||
            revision !== this.selectionRevision ||
            name !== this.details.worktreeName.trim()
          ) {
            return;
          }
          // A custom name belongs to one accepted draft; keep the checkout defaults.
          this.selectionRevision += 1;
          this.details.worktreeName = "";
          this.selectedDetails.add("worktreeName");
          this.callbacks.changed();
        }))
    );
  }

  available(): boolean {
    const snapshot = this.read();
    if (snapshot.selectedProject && !snapshot.remotePlacement) {
      const checkout = this.checkoutOptions;
      return (
        this.matchesProjectCheckout() &&
        checkout !== undefined &&
        typeof checkout !== "string" &&
        checkout.worktree
      );
    }
    const state = this.repositoryValue;
    return (
      state.kind === "git" || state.kind === "pending-clone" || state.kind === "pending-project"
    );
  }

  matchesCurrentRepo(): boolean {
    const snapshot = this.read();
    const state = this.repositoryValue;
    if (!this.matchesProjectCheckout()) {
      return false;
    }
    if (state.kind === "pending-project") {
      return (
        !snapshot.remoteProject &&
        !snapshot.selectedProject?.repoRoot &&
        snapshot.selectedProject?.id === state.projectId
      );
    }
    if (state.kind === "pending-clone") {
      return snapshot.remoteProject?.cloneUrl === state.cloneUrl;
    }
    if (state.kind === "idle" || snapshot.remoteProject) {
      return false;
    }
    const repoRoot =
      snapshot.selectedProject?.repoRoot ?? (snapshot.folder.trim() || snapshot.workspace);
    return state.repoRoot === repoRoot;
  }

  load() {
    const requestId = ++this.requestToken;
    const snapshot = this.read();
    this.checkoutScope =
      snapshot.selectedProject && !snapshot.remotePlacement
        ? { project: snapshot.selectedProject, agentId: snapshot.agentId }
        : undefined;
    this.checkoutOptions = this.checkoutScope ? "loading" : undefined;
    if (this.checkoutScope && snapshot.gateway?.phase === "connected" && snapshot.gateway.client) {
      void snapshot.gateway.client
        .request<ProjectsCheckoutOptionsResult>("projects.checkoutOptions", {
          projectId: this.checkoutScope.project.id,
          agentId: this.checkoutScope.agentId,
        })
        .then((options) => {
          if (requestId !== this.requestToken || !this.matchesProjectCheckout()) {
            return;
          }
          this.checkoutOptions = options;
          this.reconcileCheckoutChoice();
          this.callbacks.changed();
        })
        .catch(() => {
          if (requestId === this.requestToken) {
            this.checkoutOptions = "error";
            this.callbacks.changed();
          }
        });
    }
    const discovery = initialRepositoryState(snapshot);
    if (discovery.kind !== "checking") {
      return this.adoptResolvedRepository(discovery);
    }
    const client = snapshot.gateway?.client;
    if (snapshot.gateway?.phase !== "connected" || !client) {
      return this.adoptResolvedRepository({ kind: "idle" });
    }
    const { repoRoot } = discovery;
    this.repositoryValue = discovery;
    void client
      .request<WorktreesBranchesResult>("worktrees.branches", {
        repoRoot,
        includeRepositoryStatus: true,
      })
      .then((result) => {
        if (requestId !== this.requestToken) {
          return;
        }
        this.adoptResolvedRepository(
          result?.repositoryStatus === "git"
            ? {
                kind: "git",
                repoRoot,
                branches: result.branches,
                ...(result.defaultBranch ? { defaultBranch: result.defaultBranch } : {}),
                ...(result.headBranch ? { headBranch: result.headBranch } : {}),
                ...(result.branchesUnavailable ? { branchesUnavailable: true } : {}),
              }
            : { kind: result?.repositoryStatus === "not_git" ? "direct" : "unavailable", repoRoot },
        );
      })
      .catch((error: unknown) => {
        if (requestId !== this.requestToken) {
          return;
        }
        const missing = readMissingScopeError(error);
        this.adoptResolvedRepository(
          missing ||
            (error instanceof GatewayProtocolRequestError && error.gatewayCode === "FORBIDDEN")
            ? {
                kind: "forbidden",
                repoRoot,
                ...(missing ? { missingScope: missing.missingScope } : {}),
              }
            : { kind: "unavailable", repoRoot },
        );
      });
  }

  synchronize() {
    if (!this.matchesCurrentRepo()) {
      this.load();
    }
  }

  private reconcileCheckoutChoice() {
    const options = this.checkoutOptions;
    if (
      !this.matchesProjectCheckout() ||
      !options ||
      typeof options === "string" ||
      this.read().remotePlacement
    ) {
      return;
    }
    const selectedAvailable = this.worktreeValue ? options.worktree : options.current;
    if (!selectedAvailable && (options.current || options.worktree)) {
      this.worktreeValue = options.worktree;
      this.preferredWorktreeRestore = false;
      this.callbacks.persistPreference({ worktree: this.worktreeValue });
    }
  }

  private adoptResolvedRepository(state: ResolvedRepository) {
    // Worktree preferences can arrive while discovery is pending.
    this.repositoryValue = state;
    if (state.kind === "direct" && (!this.read().selectedProject || this.read().remotePlacement)) {
      const rejectedWorktree = this.worktreeValue || this.preferredWorktreeRestore;
      this.worktreeValue = false;
      if (rejectedWorktree && !this.read().remotePlacement) {
        this.callbacks.persistPreference({ worktree: false });
      }
    } else if (this.preferredWorktreeRestore && !this.worktreeSelectedByUser) {
      // Failed discovery cannot revoke isolation intent; the submit gate checks availability.
      this.worktreeValue = true;
    }
    this.preferredWorktreeRestore = false;
    this.reconcileCheckoutChoice();
    this.callbacks.changed();
  }
}
