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
export function createAgentSelectionDrafts(
  host: AgentSelectionDraftHost,
  resetSelection: () => void,
) {
  const retainedFiles = new Map<string, RetainedAgentFileDrafts>();
  let ownerProfileId: string | null = null;
  let retainedIdentity: {
    agentId: string;
    profileId: string | null;
    intentRevision: number;
    draft: AgentIdentityDraft;
  } | null = null;

  function observeGateway(snapshot: Pick<ApplicationGatewaySnapshot, "phase" | "selfUser">) {
    if (snapshot.phase !== "connected") {
      return;
    }
    const profileId = snapshot.selfUser?.id ?? null;
    if (profileId !== ownerProfileId) {
      retainedIdentity = null;
      resetIdentityDraft(host);
      ownerProfileId = profileId;
    }
  }

  function select(selection: Selection) {
    const { selectedId, intentRevision, awaitingRoster, profileId } = selection;
    if (retainedIdentity?.intentRevision !== intentRevision) {
      retainedIdentity = null;
    }
    if (selectedId === host.agentsSelectedId) {
      return;
    }
    if (host.agentsSelectedId) {
      const drafts = retainAgentFileDrafts(host);
      if (drafts) {
        retainedFiles.set(host.agentsSelectedId, drafts);
      }
      // Retire the editor with discovery, retaining only its private unsaved draft.
      retainedIdentity =
        !selectedId &&
        awaitingRoster &&
        Object.values(host.identityDraft).some((value) => value !== null)
          ? {
              agentId: host.agentsSelectedId,
              profileId: ownerProfileId,
              intentRevision,
              draft: host.identityDraft,
            }
          : null;
    }
    host.agentsSelectedId = selectedId;
    resetSelection();
    if (selectedId) {
      const identity = retainedIdentity;
      retainedIdentity = null;
      if (identity?.agentId === selectedId && identity.profileId === profileId) {
        host.identityDraft = identity.draft;
      }
    }
    const files = selectedId ? retainedFiles.get(selectedId) : undefined;
    if (files && selectedId) {
      retainedFiles.delete(selectedId);
      host.agentFileEditors = files.editors;
      host.agentFileActive = files.active;
      host.agentFileConflict = files.conflict;
      // Loaded bases stay empty: returning must read disk while retaining the draft's ancestry.
    }
  }

  function clear() {
    retainedFiles.clear();
    retainedIdentity = null;
  }
  return { observeGateway, select, clear };
}
