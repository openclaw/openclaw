import type { PersistedClawInstall } from "./provenance-types.js";
import type { ClawAddPlan } from "./types.js";

export type ClawCronInstallUpdate = {
  plan: ClawAddPlan;
  expectedClaw?: { version: string; integrity: string };
  agentConfigDigest?: string;
};

export type ClawCronUpdateExecution = {
  appliedIds: string[];
  rollback: () => Promise<void>;
  commit?: (install: ClawCronInstallUpdate) => Promise<PersistedClawInstall>;
  publish?: () => Promise<void>;
};
