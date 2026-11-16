import type { GitOperationStarter } from "../infra/git-network-retry.js";

export type ManagedProjectOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  assertCurrent?: () => void;
};

/**
 * Host-held checkout facts for one transport effect. Run each Git command through
 * `startRun` when present: it rechecks the host's checkout leases before the command starts.
 */
export type ManagedProjectTransportOptions = ManagedProjectOptions & {
  readonly env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  startRun?: GitOperationStarter;
};

export type ManagedProjectBaseV1 = { commit: string; ref: string };

/** Native custody supplies environment; source adapters own remote admission and transport. */
export type ManagedProjectSourceV1 = {
  resolveUrl: (url: string) => { url: string; name: string } | null;
  invalidUrlMessage: string;
  clone: (
    input: { url: string; target: string; requiredCommit?: string },
    options: ManagedProjectTransportOptions,
  ) => Promise<void>;
  ensureCommit: (
    input: { url: string; target: string; commit: string },
    options: ManagedProjectTransportOptions,
  ) => Promise<void>;
  resolveBase: (
    input: { url: string; target: string; ref?: string },
    options: ManagedProjectTransportOptions,
  ) => Promise<ManagedProjectBaseV1>;
  refresh: (
    input: { url: string; target: string },
    options: ManagedProjectTransportOptions,
  ) => Promise<void>;
};
