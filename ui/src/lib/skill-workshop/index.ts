export type SkillWorkshopProposalStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "quarantined"
  | "stale";

type SkillWorkshopFile = {
  path: string;
  size: string;
  contents: string;
};

type SkillWorkshopScanFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  file: string;
  line: number;
  message: string;
  evidence: string;
};

type SkillWorkshopScan = {
  state: "pending" | "clean" | "failed" | "quarantined";
  scannedAt: string;
  critical: number;
  warn: number;
  info: number;
  findings: SkillWorkshopScanFinding[];
};

export type SkillWorkshopProposal = {
  key: string;
  slug: string;
  name: string;
  oneLine: string;
  body: string;
  status: SkillWorkshopProposalStatus;
  origin?: {
    agentId?: string;
    sessionKey?: string;
    runId?: string;
    messageId?: string;
  };
  version: number;
  createdAt: number;
  updatedAt?: number;
  recencyGroup: "today" | "yesterday" | "earlier";
  ageLabel: string;
  supportFiles: SkillWorkshopFile[];
  isNew: boolean;
  scan?: SkillWorkshopScan;
  statusReason?: string;
};

export type SkillWorkshopStatusFilter = "all" | SkillWorkshopProposalStatus;
export type SkillWorkshopAction = "apply" | "revise" | "reject" | "restore";
export type SkillWorkshopMode = "board" | "today";

export type SkillWorkshopActionBusy = {
  key: string;
  action: SkillWorkshopAction;
};

export type SkillWorkshopActionNotice = {
  key: string;
  label: string;
  slug: string;
};

export function filterSkillWorkshopProposals(
  proposals: SkillWorkshopProposal[],
  statusFilter: SkillWorkshopStatusFilter,
  query: string,
): SkillWorkshopProposal[] {
  const q = query.trim().toLowerCase();
  return proposals.filter((p) => {
    if (statusFilter !== "all" && p.status !== statusFilter) {
      return false;
    }
    if (q) {
      const hay = `${p.name} ${p.oneLine} ${p.slug}`.toLowerCase();
      if (!hay.includes(q)) {
        return false;
      }
    }
    return true;
  });
}
