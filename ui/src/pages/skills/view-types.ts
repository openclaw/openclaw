import type { TemplateResult } from "lit";
import type { SkillLibraryEntry } from "../../../../packages/gateway-protocol/src/index.ts";
import type { AgentsListResult, SkillStatusReport } from "../../api/types.ts";
import type { ClawHubSearchResult } from "../../lib/skills/clawhub-search.ts";
import type {
  ClawHubSkillSecurityVerdict,
  ClawHubSkillDetail,
  SkillOperation,
  SkillMessageMap,
} from "../../lib/skills/index.ts";

export type SkillsStatusFilter = "all" | "ready" | "needs-setup" | "disabled";
export type SkillDetailTab = "overview" | "card";

export type SkillsProps = {
  surface?: "discovery" | "settings";
  libraryEntries?: SkillLibraryEntry[];
  onLibraryOpen?: (skillId: string) => void;
  library?: TemplateResult;
  showInventory?: boolean;
  personalImport?: boolean;
  canUpdate: boolean;
  canInstall: boolean;
  connected: boolean;
  loading: boolean;
  report: SkillStatusReport | null;
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  error: string | null;
  filter: string;
  statusFilter: SkillsStatusFilter;
  edits: Record<string, string>;
  operation: SkillOperation;
  messages: SkillMessageMap;
  detailKey: string | null;
  detailTab: SkillDetailTab;
  clawhubVerdicts: Record<string, ClawHubSkillSecurityVerdict>;
  clawhubVerdictsLoading: boolean;
  clawhubVerdictsError: string | null;
  skillCardContents: Record<string, string>;
  skillCardLoadingKey: string | null;
  skillCardErrors: Record<string, string>;
  clawhubQuery: string;
  clawhubResults: ClawHubSearchResult[] | null;
  clawhubSearchLoading: boolean;
  clawhubSearchError: string | null;
  clawhubDetail: ClawHubSkillDetail | null;
  clawhubDetailRef: string | null;
  clawhubDetailLoading: boolean;
  clawhubDetailError: string | null;
  clawhubInstallMessage: {
    kind: "success" | "error";
    text: string;
  } | null;
  onFilterChange: (next: string) => void;
  onAgentChange: (agentId: string) => void;
  onStatusFilterChange: (next: SkillsStatusFilter) => void;
  onRefresh: () => void;
  onToggle: (skillKey: string, enabled: boolean) => void;
  onEdit: (skillKey: string, value: string) => void;
  onSaveKey: (skillKey: string) => void;
  onInstall: (skillKey: string, name: string, installId: string) => void;
  onDetailOpen: (skillKey: string) => void;
  onDetailClose: () => void;
  onDetailTabChange: (tab: SkillDetailTab) => void;
  onClawHubQueryChange: (query: string) => void;
  onClawHubDetailOpen: (ref: string) => void;
  onClawHubDetailClose: () => void;
  onClawHubInstall: (ref: string, version?: string) => void;
};
