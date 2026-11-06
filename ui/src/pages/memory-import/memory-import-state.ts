import type { MigrationsMemoryApplyResult } from "../../../../packages/gateway-protocol/src/schema/migrations.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import type {
  SessionBackfillGatewayResult,
  SessionBackfillProgress,
  SessionBackfillRollbackResult,
} from "./view-types.ts";

export type MemoryImportClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

type PendingMemoryImport = {
  providerId: string;
  agentId: string;
  planFingerprint: string;
  itemIds: string[];
  overwrite: boolean;
  idempotencyKey: string;
  attempted: boolean;
};

export type MemoryImportState = {
  replaceExisting: boolean;
  selectedByProvider: Record<string, string[]>;
  applyingProviderId: string | null;
  pendingImport: PendingMemoryImport | null;
  applyError: string | null;
  lastResults: Record<string, MigrationsMemoryApplyResult>;
  backfillFrom: string;
  backfillTo: string;
  backfillBusy: "preview" | "apply" | "rollback" | null;
  backfillError: string | null;
  backfillPreview: SessionBackfillGatewayResult | null;
  backfillProgress: SessionBackfillProgress | null;
  backfillRollbackResult: SessionBackfillRollbackResult | null;
  backfillRollbackTarget: { client: MemoryImportClient; agentId: string } | null;
};
