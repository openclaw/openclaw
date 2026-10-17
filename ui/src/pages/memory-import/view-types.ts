import type {
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../../../packages/gateway-protocol/src/schema/migrations.js";
import type { GatewayAgentRow } from "../../../../src/shared/session-types.js";

export type SessionBackfillGatewayResult = {
  days: number;
  candidates: number;
  perDay: Array<{ day: string; candidateCount: number; sample: string[] }>;
  staged: number;
  truncated?: boolean;
  cursor?: { advanced: boolean; exhausted: boolean; hasMore: boolean };
};

export type SessionBackfillProgress = {
  days: number;
  candidates: number;
  staged: number;
  complete: boolean;
};

export type SessionBackfillRollbackResult = {
  removedDiaryEntries: number;
  removedStagedEntries: number;
};

export type MemoryImportViewProps = {
  connected: boolean;
  canAdmin: boolean;
  agents: GatewayAgentRow[];
  selectedAgentId: string | null;
  plan: MigrationsMemoryPlanResult | null;
  loading: boolean;
  error: string | null;
  applyError: string | null;
  replaceExisting: boolean;
  selectedByProvider: Record<string, string[]>;
  applyingProviderId: string | null;
  pendingProviderId: string | null;
  lastResults: Record<string, MigrationsMemoryApplyResult>;
  backfillAvailable: boolean;
  backfillFrom: string;
  backfillTo: string;
  backfillBusy: "preview" | "apply" | "rollback" | null;
  backfillError: string | null;
  backfillPreview: SessionBackfillGatewayResult | null;
  backfillProgress: SessionBackfillProgress | null;
  backfillRollbackResult: SessionBackfillRollbackResult | null;
  backfillRollbackPending: boolean;
  onSelectAgent: (agentId: string) => void;
  onReplaceExisting: (enabled: boolean) => void;
  onRefresh: () => void;
  onToggleCollection: (providerId: string, itemIds: readonly string[], selected: boolean) => void;
  onRequestImport: (providerId: string) => void;
  onConfirmImport: () => void;
  onCancelImport: () => void;
  onBackfillFromChange: (value: string) => void;
  onBackfillToChange: (value: string) => void;
  onBackfillPreview: () => void;
  onBackfillApply: () => void;
  onBackfillRollbackRequest: () => void;
  onBackfillRollbackConfirm: () => void;
  onBackfillRollbackCancel: () => void;
};
