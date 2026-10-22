import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  retainAgentFileDrafts,
  type AgentFilesState,
  type RetainedAgentFileDrafts,
} from "./files.ts";
import {
  resetIdentityDraft,
  type AgentIdentityDraft,
  type AgentIdentityOutcome,
} from "./identity-actions.ts";

type AgentSelectionDraftHost = AgentFilesState & {
  agentsSelectedId: string | null;
  agentFileActive: string | null;
  identityDraft: AgentIdentityDraft;
  identitySaving: boolean;
  identityOutcome: Promise<AgentIdentityOutcome> | null;
};

type Selection = {
  selectedId: string | null;
  profileId: string | null;
};

export type RetainedIdentitySave = {
  client: GatewayBrowserClient;
  snapshot: ApplicationGatewaySnapshot | null;
  promise: Promise<void>;
};

type RetainedIdentityWork = {
  scope: {
    gateway: ApplicationContext["gateway"];
    connectionRevision: number;
    gatewayUrl: string;
  };
  profileId: string | null;
  identities: Map<string, { profileId: string | null; draft: AgentIdentityDraft }>;
  saves: Map<string, RetainedIdentitySave>;
};

const retainedIdentityWork = new WeakMap<ApplicationContext, RetainedIdentityWork>();

function identityWorkFor(context: ApplicationContext): RetainedIdentityWork {
  const gateway = context.gateway;
  const scope = {
    gateway,
    connectionRevision: gateway.connectionRevision ?? 0,
    gatewayUrl: gateway.connection?.gatewayUrl ?? "",
  };
  let work = retainedIdentityWork.get(context);
  if (
    !work ||
    work.scope.gateway !== scope.gateway ||
    work.scope.connectionRevision !== scope.connectionRevision ||
    work.scope.gatewayUrl !== scope.gatewayUrl
  ) {
    work = { scope, profileId: null, identities: new Map(), saves: new Map() };
    retainedIdentityWork.set(context, work);
  }
  return work;
}

/** Owns private editor drafts across the selected target's presentation lifetime. */
export function createAgentSelectionDrafts(
  host: AgentSelectionDraftHost,
  resetSelection: () => void,
) {
  const retainedFiles = new Map<string, RetainedAgentFileDrafts>();
  let lifetime: RetainedIdentityWork | null = null;
  let ownerProfileId: string | null = null;

  function bindContext(context: ApplicationContext): Map<string, RetainedIdentitySave> {
    const next = identityWorkFor(context);
    if (lifetime && lifetime !== next) {
      resetIdentityDraft(host);
    }
    lifetime = next;
    ownerProfileId = next.profileId;
    return next.saves;
  }

  function retainCurrentIdentity() {
    if (
      lifetime &&
      host.agentsSelectedId &&
      Object.values(host.identityDraft).some((value) => value !== null)
    ) {
      lifetime.identities.set(host.agentsSelectedId, {
        profileId: ownerProfileId,
        draft: host.identityDraft,
      });
    }
  }

  function observeGateway(snapshot: Pick<ApplicationGatewaySnapshot, "phase" | "selfUser">) {
    if (snapshot.phase !== "connected") {
      return;
    }
    const profileId = snapshot.selfUser?.id ?? null;
    if (profileId !== ownerProfileId) {
      lifetime?.identities.clear();
      lifetime?.saves.clear();
      resetIdentityDraft(host);
      ownerProfileId = profileId;
      if (lifetime) {
        lifetime.profileId = profileId;
      }
    }
  }

  function restoreIdentity(selectedId: string | null, profileId: string | null): boolean {
    if (!selectedId) {
      return false;
    }
    const retained = lifetime?.identities.get(selectedId);
    if (!retained) {
      return false;
    }
    if (retained.profileId !== profileId) {
      if (profileId !== null) {
        lifetime?.identities.delete(selectedId);
      }
      return false;
    }
    lifetime?.identities.delete(selectedId);
    host.identityDraft = retained.draft;
    return true;
  }

  function select(selection: Selection): boolean {
    const { selectedId, profileId } = selection;
    if (selectedId === host.agentsSelectedId) {
      return restoreIdentity(selectedId, profileId);
    }
    if (host.agentsSelectedId) {
      const files = retainAgentFileDrafts(host);
      if (files) {
        retainedFiles.set(host.agentsSelectedId, files);
      }
      retainCurrentIdentity();
    }
    host.agentsSelectedId = selectedId;
    resetSelection();
    const restoredIdentity = restoreIdentity(selectedId, profileId);
    const files = selectedId ? retainedFiles.get(selectedId) : undefined;
    if (files && selectedId) {
      retainedFiles.delete(selectedId);
      host.agentFileEditors = files.editors;
      host.agentFileActive = files.active;
      host.agentFileConflict = files.conflict;
      // Loaded bases stay empty: returning must read disk while retaining the draft's ancestry.
    }
    return restoredIdentity;
  }

  function clear() {
    retainedFiles.clear();
    lifetime?.identities.clear();
    lifetime?.saves.clear();
  }
  return { bindContext, retainCurrentIdentity, observeGateway, select, clear };
}
