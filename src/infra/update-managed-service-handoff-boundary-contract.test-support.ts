import type { ManagedServiceManagerBoundaryOptions } from "./update-managed-service-handoff-lifecycle.test-support.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type ManagedServiceBoundaryOptions = ManagedServiceManagerBoundaryOptions & {
  trigger?: "cli" | "api" | "campaign";
  origin?: UpdateRunRecord["origin"];
  controlDisconnect?: "transferred" | "unarmed" | "dead-parent";
  beforeDisconnect?: (
    run: UpdateRunRecord | undefined,
    env: NodeJS.ProcessEnv,
  ) => void | Promise<void>;
  prepareState?: (params: {
    env: NodeJS.ProcessEnv;
    recoveryModulePath: string;
    sourceRuntimeImport: string;
  }) => void | Promise<void>;
  readSentinel?: (env: NodeJS.ProcessEnv) => unknown;
  relativeInput?: boolean;
  validationResult?: "failed" | "skipped" | "child-result";
  validationClockAdvanceMs?: number;
  terminalParentExitProbe?: true;
  cancelDuringValidation?: boolean;
  systemScope?: true;
  cancelAtActivation?: "requester" | "inspection";
  replaceLaunchdLeaseAfterInspection?: true;
  runnerFallback?: boolean;
  selectedDriver?: "2026.9.3";
  revokeWhileValidating?: boolean;
  replaceLedgerWriter?: boolean;
  finalizationWorkMs?: number;
  beforeParkNotice?: "acknowledged" | "stalled" | "rejected" | "disconnected";
  profileRequester?: true;
};
