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

export type SkillsPresentation = {
  skillsFilter: string;
  skillsStatusFilter: SkillsStatusFilter;
  /** The installed skill whose page is open, from the address. */
  skillsDetailKey: string | null;
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
  /** Undefined until the library owner accepts its first inventory. */
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
  /** Where a skill page's first crumb leads: the list it was opened from. */
  listHref: string;
  /** Opens an installed skill's page. */
  onDetailOpen: (skillKey: string) => void;
  /** Leaves a skill page for the list it was opened from. */
  onDetailClose: () => void;
  onSkillCardRetry: (skillKey: string) => void;
  onClawHubQueryChange: (query: string) => void;
  /** Opens a ClawHub skill's page. */
  onClawHubDetailOpen: (ref: string) => void;
  onClawHubInstall: (ref: string, version?: string) => void;
};
