import type { JSX } from "@solidjs/web";
import type { SkillLibraryEntry } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot, SkillStatusEntry, SkillStatusReport } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type {
  ClawHubSkillDetail,
  ClawHubSkillSecurityVerdict,
  loadClawHubDetail,
  SkillsState,
} from "../../lib/skills/index.ts";

export type SkillsRouteData = {
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  agents: ApplicationContext["agents"];
  selectedAgentId: string | null;
  selectionIntentRevision: number;
  /** An admitted prefetch adopted by the mounted Skills request owner. */
  reportRead?: Promise<SkillStatusReport | undefined>;
  error: string | null;
  clawhubRef?: string;
};

export type SkillsPageProps = { routeData?: SkillsRouteData; surface?: "discovery" | "settings" };

export type ClawHubDetailReceipt = {
  client: GatewayBrowserClient | null;
  epoch: number;
  agentId: string | null;
  agentRevision: number;
  ref: string;
  completion: ReturnType<typeof loadClawHubDetail>;
};

export type SkillsStatusFilter = "all" | "ready" | "needs-setup" | "disabled";
export type SkillDetailTab = "overview" | "card";

export type SkillsPresentation = {
  skillsFilter: string;
  skillsStatusFilter: SkillsStatusFilter;
  skillsDetailKey: string | null;
  skillsDetailTab: SkillDetailTab;
  clawhubSearchQuery: string;
};

export type SkillsProps = {
  state: SkillsState & SkillsPresentation;
  mutationSkills: SkillStatusEntry[];
  saving: boolean;
  toggleSavingSkillKey?: string;
  toggleDisabled?: boolean;
  readClawHubDetail: () => ClawHubSkillDetail | null;
  readClawHubVerdicts: () => Record<string, ClawHubSkillSecurityVerdict>;
  readClawHubSearch: () => boolean;
  clawhubSearchEpoch: number;
  surface?: "discovery" | "settings";
  libraryEntries?: SkillLibraryEntry[];
  onLibraryOpen?: (skillId: string) => void;
  library?: JSX.Element;
  pageMenu?: () => JSX.Element;
  showInventory?: boolean;
  canUpdate: boolean;
  canInstall: boolean;
  loading: boolean;
  error: string | null;
  onFilterChange: (next: string) => void;
  onStatusFilterChange: (next: SkillsStatusFilter) => void;
  onRefresh: () => void;
  onToggle: (skillKey: string, enabled: boolean) => void;
  onEdit: (skillKey: string, value: string) => void;
  /** `replaceable` tells, from a config snapshot, whether the stored key may be typed over. */
  onSaveKey: (
    skillKey: string,
    replaceable: (snapshot: ConfigSnapshot | null, skillKey: string) => boolean | undefined,
  ) => void;
  /** The config the skill dialog reads to tell how a stored API key is held. */
  apiKeyConfig: {
    snapshot: () => ConfigSnapshot | null;
    error: () => string | null;
    retry: () => void;
  };
  onInstall: (skillKey: string, name: string, installId: string) => void;
  onDetailOpen: (skillKey: string) => void;
  onDetailClose: () => void;
  onDetailTabChange: (tab: SkillDetailTab) => void;
  onClawHubQueryChange: (query: string) => void;
  onClawHubDetailOpen: (ref: string) => void;
  onClawHubDetailClose: () => void;
  onClawHubInstall: (ref: string, version?: string) => void;
};
