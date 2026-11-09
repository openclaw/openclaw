import type { WorkspaceStateIdentity } from "./workspace-state-identity.js";

export const WORKSPACE_SETUP_STATE_VERSION = 1 as const;

export type WorkspaceSetupState = {
  version: typeof WORKSPACE_SETUP_STATE_VERSION;
  bootstrapSeededAt?: string;
  /** Set only by the initial seed: this BOOTSTRAP.md was supplied, so only its removal completes setup. */
  bootstrapSupplied?: true;
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
