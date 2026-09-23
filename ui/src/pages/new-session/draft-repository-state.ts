import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  AgentSummary,
  ProjectRecord,
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
  requestUpdate: () => void;
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
  const repoRoot =
    snapshot.selectedProject?.repoRoot ?? (snapshot.folder.trim() || snapshot.workspace);
  if (!repoRoot || (snapshot.selectedProject && !snapshot.selectedProject.repoRoot)) {
    return { kind: "idle" };
  }
  return !snapshot.selectedProject && repoRoot === snapshot.workspace && !snapshot.workspaceGit
    ? { kind: "direct", repoRoot }
    : { kind: "checking", repoRoot };
}

export class DraftRepositoryController {
  private worktreeValue = false;
  private worktreeNameValue = "";
  private baseRefOverride: string | undefined;
  private repositoryValue: DraftRepositoryState = { kind: "idle" };
  private requestToken = 0;
  private selectionRevision = 0;
  private preferredWorktreeRestore = false;
  private worktreeSelectedByUser = false;
  private baseRefSelectedByUser = false;
  private nameSelectedByUser = false;

  constructor(
    private readonly read: () => DraftRepositorySnapshot,
    private readonly callbacks: DraftRepositoryCallbacks,
  ) {}

  get worktree(): boolean {
    return this.worktreeValue;
  }

  get preferenceWorktree(): boolean {
    return this.worktreeValue || this.preferredWorktreeRestore;
  }

  get worktreeName(): string {
    return this.worktreeNameValue;
  }

  get baseRef(): string {
    // An omitted ref lets the Gateway fetch its default; discovery is only a suggestion.
    return this.baseRefOverride ?? "";
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
    return this.worktreeSelectedByUser || this.baseRefSelectedByUser || this.nameSelectedByUser;
  }

  adoptPreference(preference: NewSessionPreference | null) {
    if (!this.worktreeSelectedByUser) {
      this.worktreeValue = false;
      this.preferredWorktreeRestore = preference?.worktree === true;
    }
    if (!this.baseRefSelectedByUser) {
      const baseRef = preference?.baseRef || undefined;
      if (this.baseRefOverride !== baseRef) {
        this.selectionRevision += 1;
      }
      this.baseRefOverride = baseRef;
    }
    if (!this.nameSelectedByUser) {
      const worktreeName = preference?.worktreeName ?? "";
      if (this.worktreeNameValue !== worktreeName) {
        this.selectionRevision += 1;
      }
      this.worktreeNameValue = worktreeName;
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
    this.baseRefOverride = undefined;
    this.worktreeNameValue = "";
    this.baseRefSelectedByUser = false;
    this.nameSelectedByUser = false;
    if (persist) {
      this.callbacks.persistPreference({ baseRef: "", worktreeName: "" });
    }
  }

  invalidate() {
    this.requestToken += 1;
    this.repositoryValue = { kind: "idle" };
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

  forceWorktree(value: boolean) {
    this.selectionRevision += 1;
    this.worktreeValue = value;
  }

  rejectPreferredWorktree() {
    this.preferredWorktreeRestore = false;
    this.worktreeValue = false;
    this.clearDetails(true);
  }

  select(value: boolean) {
    if (this.worktreeValue === value || this.read().remotePlacement) {
      return;
    }
    this.selectWorktree(value, false);
    this.callbacks.persistPreference({
      folder: this.read().folder.trim() || this.read().workspace,
      worktree: this.worktreeValue,
    });
    if (this.worktreeValue && !this.available()) {
      this.load();
    }
    this.callbacks.requestUpdate();
  }

  setBaseRef(baseRef: string, submitting: boolean) {
    if (submitting) {
      return;
    }
    this.selectionRevision += 1;
    this.baseRefOverride = baseRef;
    this.baseRefSelectedByUser = true;
    this.callbacks.persistPreference({ baseRef });
    this.callbacks.requestUpdate();
  }

  setWorktreeName(worktreeName: string, submitting: boolean) {
    if (submitting) {
      return;
    }
    this.selectionRevision += 1;
    this.worktreeNameValue = worktreeName;
    this.nameSelectedByUser = true;
    this.callbacks.persistPreference({ worktreeName });
    this.callbacks.requestUpdate();
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
      ...(!submission.recovered ? { selectedBaseRef: this.baseRefOverride?.trim() ?? "" } : {}),
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
            name !== this.worktreeNameValue.trim()
          ) {
            return;
          }
          // A custom name belongs to one accepted draft; keep the checkout defaults.
          this.selectionRevision += 1;
          this.worktreeNameValue = "";
          this.nameSelectedByUser = true;
          this.callbacks.requestUpdate();
        }))
    );
  }

  available(): boolean {
    const state = this.repositoryValue;
    // A saved path or .git marker cannot prove that Git has a usable HEAD.
    return state.kind === "git" || state.kind === "pending-clone";
  }

  matchesCurrentRepo(): boolean {
    const snapshot = this.read();
    const state = this.repositoryValue;
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
      .catch(() => {
        if (requestId !== this.requestToken) {
          return;
        }
        this.adoptResolvedRepository({ kind: "unavailable", repoRoot });
      });
  }

  synchronize() {
    if (!this.matchesCurrentRepo()) {
      this.load();
    }
  }

  private adoptResolvedRepository(state: ResolvedRepository) {
    // Worktree preferences can arrive while discovery is pending.
    this.repositoryValue = state;
    if (state.kind === "direct") {
      if (!this.read().remotePlacement) {
        const rejectedWorktree = this.worktreeValue || this.preferredWorktreeRestore;
        this.worktreeValue = false;
        if (rejectedWorktree) {
          this.callbacks.persistPreference({ worktree: false });
        }
      }
    } else if (this.preferredWorktreeRestore && !this.worktreeSelectedByUser) {
      // Failed discovery cannot revoke isolation intent; the submit gate checks availability.
      this.worktreeValue = true;
    }
    this.preferredWorktreeRestore = false;
    this.callbacks.requestUpdate();
  }
}
