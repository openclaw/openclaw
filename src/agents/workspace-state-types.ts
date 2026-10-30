import type { WorkspaceStateIdentity } from "./workspace-state-identity.js";

export const WORKSPACE_SETUP_STATE_VERSION = 1 as const;

export type WorkspaceSetupState = {
  version: typeof WORKSPACE_SETUP_STATE_VERSION;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
};

export type WorkspaceAttestation = {
  attestedAtMs: number;
  generatedHashes: ReadonlyMap<string, string>;
};

export type WorkspaceStateSnapshot = {
  identity: WorkspaceStateIdentity;
  setupExists: boolean;
  setupUpdatedAtMs?: number;
  setup: WorkspaceSetupState;
  attestation?: WorkspaceAttestation;
};
