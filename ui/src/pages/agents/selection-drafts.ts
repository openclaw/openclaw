import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  retainAgentFileDrafts,
  type AgentFilesState,
  type RetainedAgentFileDrafts,
} from "./files.ts";
import { resetIdentityDraft } from "./identity-actions.ts";
import type { AgentIdentityDraft } from "./panels-overview.tsx";

type AgentSelectionDraftHost = AgentFilesState & {
  agentsSelectedId: string | null;
  agentFileActive: string | null;
  identityDraft: AgentIdentityDraft;
  identitySaving: boolean;
  identityError: string | null;
};

type Selection = {
  selectedId: string | null;
  intentRevision: number;
  awaitingRoster: boolean;
  profileId: string | null;
};

/** Owns private editor drafts across the selected target's presentation lifetime. */
export class AgentSelectionDrafts {
  private readonly files = new Map<string, RetainedAgentFileDrafts>();
  private profileId: string | null = null;
  private identity: {
    agentId: string;
    profileId: string | null;
    intentRevision: number;
    draft: AgentIdentityDraft;
  } | null = null;

  constructor(
    private readonly host: AgentSelectionDraftHost,
    private readonly resetSelection: () => void,
  ) {}

  observeGateway(snapshot: Pick<ApplicationGatewaySnapshot, "phase" | "selfUser">) {
    if (snapshot.phase !== "connected") {
      return;
    }
    const profileId = snapshot.selfUser?.id ?? null;
    if (profileId !== this.profileId) {
      this.identity = null;
      resetIdentityDraft(this.host);
      this.profileId = profileId;
    }
  }

  select(selection: Selection) {
    const { host } = this;
    const { selectedId, intentRevision, awaitingRoster, profileId } = selection;
    if (this.identity?.intentRevision !== intentRevision) {
      this.identity = null;
    }
    if (selectedId === host.agentsSelectedId) {
      return;
    }
    if (host.agentsSelectedId) {
      const drafts = retainAgentFileDrafts(host);
      if (drafts) {
        this.files.set(host.agentsSelectedId, drafts);
      }
      // Retire the editor with discovery, retaining only its private unsaved draft.
      this.identity =
        !selectedId &&
        awaitingRoster &&
        Object.values(host.identityDraft).some((value) => value !== null)
          ? {
              agentId: host.agentsSelectedId,
              profileId: this.profileId,
              intentRevision,
              draft: host.identityDraft,
            }
          : null;
    }
    host.agentsSelectedId = selectedId;
    this.resetSelection();
    if (selectedId) {
      const identity = this.identity;
      this.identity = null;
      if (identity?.agentId === selectedId && identity.profileId === profileId) {
        host.identityDraft = identity.draft;
      }
    }
    const files = selectedId ? this.files.get(selectedId) : undefined;
    if (files && selectedId) {
      this.files.delete(selectedId);
      host.agentFileEditors = files.editors;
      host.agentFileActive = files.active;
      host.agentFileConflict = files.conflict;
      // Loaded bases stay empty: returning must read disk while retaining the draft's ancestry.
    }
  }

  clear() {
    this.files.clear();
    this.identity = null;
  }
}
