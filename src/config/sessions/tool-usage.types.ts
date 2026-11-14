import type { ToolUsageCatalogEntry, ToolUsageRow } from "../../agents/tool-usage.js";

export type AgentToolUsageAppend =
  | { kind: "begin"; runId: string; now: number }
  | {
      kind: "flush";
      runId: string;
      generation: number;
      rows: readonly ToolUsageRow[];
      now: number;
    };

export type AgentToolUsageState = {
  generation: number;
  liveSince: number | null;
  importedWindows: { since: number; before: number }[];
  lastImportAt: number | null;
};
export type AgentToolUsageStatus = AgentToolUsageState & { rows: ToolUsageRow[] };
export type AgentToolUsageImportScan = {
  rows: ToolUsageRow[];
  successfulCalls: number;
  scannedEvents: number;
  coldEvents: number;
  excluded: {
    errors: number;
    cancelled: number;
    pending: number;
    incognito: number;
    notExecuted: number;
    wrappers: number;
    unknownTools: number;
    duplicates: number;
    outsideWindow: number;
    inherited: number;
    recordedLive: number;
    unknownRuns: number;
    unknownOutcomes: number;
  };
};
export type AgentToolUsageImportResult = AgentToolUsageImportScan & {
  dryRun: boolean;
  applied: boolean;
  since: number;
  before: number;
  lastImportAt: number | null;
};
export type AgentToolUsageReadInput = {
  kind: "agent-tool-usage";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  now: number;
};
export type AgentToolUsageImportReadInput = {
  kind: "agent-tool-usage-import";
  executingAgentId: string;
  counterDatabase: { agentId: string; path: string };
  previous: AgentToolUsageState;
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  catalog: readonly ToolUsageCatalogEntry[];
  since: number;
  before: number;
  activeRunIds?: readonly string[];
};
