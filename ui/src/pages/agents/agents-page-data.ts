import type { AgentsState } from "../../lib/agents/index.ts";
import type { AgentsPanel } from "../../lib/agents/panels.ts";
import type { CronState } from "../../lib/cron/types.ts";
import type { AgentFilesState, AgentFilesViewState } from "./files.ts";
import type { AgentIdentityDraft, AgentIdentityOutcome } from "./identity-actions.ts";
import type { AgentSkillsState } from "./skills.ts";

export type AgentsPageData = Omit<AgentsState, "agentsLoading" | "agentsError" | "agentsList"> &
  AgentFilesState &
  AgentFilesViewState &
  AgentSkillsState & {
    readonly agentsList: AgentsState["agentsList"];
    chatModelCatalogRead: Promise<void> | null;
    identityDraft: AgentIdentityDraft;
    identitySaving: boolean;
    identityOutcome: Promise<AgentIdentityOutcome> | null;
    cron: CronState;
    sessionKey: string;
    agentsPanel: AgentsPanel;
  };
export type AgentsViewData = Omit<
  AgentsPageData,
  | "client"
  | "connected"
  | "agents"
  | "sessions"
  | "sessionsResult"
  | "sessionKey"
  | "agentFileWriteRevisions"
>;
