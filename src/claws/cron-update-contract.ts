import type { ClawInstallRecordUpdate, PersistedClawInstall } from "./provenance-types.js";

export type ClawCronInstallUpdate = {
  plan: ClawInstallRecordUpdate;
  expectedClaw?: { version: string; integrity: string };
  agentConfigDigest?: string;
};

export type ClawCronUpdateExecution = {
  appliedIds: string[];
  rollback: () => Promise<void>;
  commit?: (install: ClawCronInstallUpdate) => Promise<PersistedClawInstall>;
  publish?: () => Promise<void>;
};
