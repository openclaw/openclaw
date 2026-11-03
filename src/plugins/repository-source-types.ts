import type { ManagedProjectBaseV1 } from "../projects/managed-project-source.js";
import type { RepositoryCredentialReader } from "./repository-integration.types.js";
/** Vendor-neutral repository facts; credentials remain with the source implementation. */
export type RepositorySourceProject = {
  id: string;
  repoRoot: string;
  source: "cloned" | "registered" | "workspace";
};

export type RepositorySourcePreparation = {
  project: RepositorySourceProject;
  assertCurrent: () => void;
  /** Without a ref, observe and hydrate the current remote default through source transport. */
  resolveBase: (ref?: string) => Promise<ManagedProjectBaseV1>;
};

export type RepositoryTreeEntry = {
  path: string;
  type: "tree" | "blob";
  mode: string;
  sha: string;
};

export type RepositoryWorkerReadLease = {
  repositoryId: string;
  /** Opaque, nonsecret cache partition. Never evidence of current access. */
  identityKey: string;
  /** Public sources may use the host's anonymous archive transport instead of a Git pack. */
  private?: boolean;
  baseCommit: string;
  tree: string;
  assertCurrent: () => void;
  confirmAdmission: () => Promise<void>;
  revalidate: (signal?: AbortSignal) => Promise<void>;
  readTree: (sha: string, signal?: AbortSignal) => Promise<RepositoryTreeEntry[]>;
  readBlob: (sha: string, signal?: AbortSignal) => Promise<string>;
  /** Sources own authentication; the native worker pack owner consumes the resulting file. */
  prepareGitPack?: (input: {
    temporaryRoot: string;
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<string>;
};

export type RepositorySourceV1 = {
  /** Local contribution ID declared by this plugin's manifest. */
  id: string;
  resolve: (url: string) =>
    | {
        url: string;
        name: string;
        /** Read-safe presentation only; source selection never grants repository access. */
        display?: Readonly<{ identity: string; host?: string }>;
      }
    | undefined;
  prepare: (input: {
    url: string;
    agentId: string;
    requiredCommit?: string;
    signal?: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<RepositorySourcePreparation>;
  worker?: {
    /** Opt in to host-owned published-branch/checkpoint restoration with source-owned identity. */
    restore?: (input: {
      url: string;
      agentId: string;
      requiredCommit: string;
      signal?: AbortSignal;
      assertCurrent: () => void;
    }) => Promise<{
      project: RepositorySourceProject;
      assertCurrent: () => void;
      readRemoteHead: (branch: string) => Promise<string | undefined>;
    }>;

    /** Cheap current selection check for reusing a prepared worker, never credential authority. */
    isIdentityCurrent?: (input: { agentId: string; identityKey: string }) => boolean;
    prepare: (input: {
      url: string;
      agentId: string;
      ref?: string;
      baseCommit?: string;
      expected?: { repositoryId: string; identityKey: string };
      /** Current host-admitted actor/operation; source selection never grants credential access. */
      readCredential?: RepositoryCredentialReader;
      /** Retain an issued credential's cleanup with this worker operation. */
      retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
      signal?: AbortSignal;
      assertCurrent: () => void;
    }) => Promise<RepositoryWorkerReadLease>;
    checkout: (input: {
      url: string;
      agentId: string;
      transfer: import("./repository-checkout-transfer.js").RepositoryCheckoutTransfer;
      /** Current host-admitted actor/operation; source selection never grants credential access. */
      readCredential?: RepositoryCredentialReader;
      /** Retain an issued credential's cleanup with this worker operation. */
      retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
      assertCurrent: () => void;
    }) => Promise<void>;
  };
};

/** Host-admitted source operations bound to one resolved URL and registration lifetime. */
type ResolvedRepositorySource = {
  id: string;
  name: string;
  url: string;
  display?: NonNullable<ReturnType<RepositorySourceV1["resolve"]>>["display"];
  assertCurrent: () => void;
  prepare: (input: {
    agentId: string;
    requiredCommit?: string;
    signal?: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<RepositorySourcePreparation>;
  isWorkerIdentityCurrent: (input: {
    agentId: string;
    identity: { source: string; key?: string };
  }) => boolean;
  supportsPublicationRestoration: boolean;
  restoreWorker: (input: {
    agentId: string;
    requiredCommit: string;
    signal?: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<{
    project: RepositorySourceProject;
    assertCurrent: () => void;
    readRemoteHead: (branch: string) => Promise<string | undefined>;
  }>;
  prepareWorker: (input: {
    agentId: string;
    ref?: string;
    baseCommit?: string;
    expected?: { repositoryId: string; identityKey: string };
    readCredential?: RepositoryCredentialReader;
    retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
    signal?: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<RepositoryWorkerReadLease>;
  checkoutWorker: (input: {
    agentId: string;
    transfer: import("./repository-checkout-transfer.js").RepositoryCheckoutTransfer;
    readCredential?: RepositoryCredentialReader;
    retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
    assertCurrent: () => void;
  }) => Promise<void>;
};

/** Gateway source lookup contract; implementation and registry custody stay host-owned. */
export type RepositorySources = {
  resolve: (url: string, sourceId?: string) => ResolvedRepositorySource;
};
