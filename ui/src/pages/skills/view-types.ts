import type { TemplateResult } from "lit";
import type { SkillLibraryEntry } from "../../../../packages/gateway-protocol/src/index.ts";
import type { SkillsState } from "../../lib/skills/index.ts";

export type SkillsStatusFilter = "all" | "ready" | "needs-setup" | "disabled";
export type SkillDetailTab = "overview" | "card";

export type SkillsProps = {
  state: SkillsState;
  surface?: "discovery" | "settings";
  libraryEntries?: SkillLibraryEntry[];
  onLibraryOpen?: (skillId: string) => void;
  library?: TemplateResult;
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
