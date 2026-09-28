import type { WorkspaceHashMetrics } from "./workspace-hash-memo.js";
import type { WorkspaceNode } from "./workspace-manifest-comparison.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import type {
  StagedWorkerWorkspaceInventory,
  StagedWorkerWorkspaceReadEntry,
} from "./workspace-result-inventory.js";

export type WorkspaceComputationHashes = {
  owner: "gateway" | "worker";
  entries: Array<[string, string]>;
};

export type WorkspaceComputationHashResult<T> = {
  value: T;
  hashes: Array<[string, string]>;
  metrics: WorkspaceHashMetrics;
};

type WorkspaceManifestCapture = {
  manifest: WorkerWorkspaceManifest;
  manifestRef: string;
};

type WorkspaceManifestSnapshot = WorkspaceManifestCapture & {
  rawManifest: string;
};

type WorkspaceManifestComparison = {
  changed: boolean;
  entries: WorkerWorkspaceManifestEntry[];
  paths: string[];
};

type WorkspaceManifestPair = {
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
} & WorkspaceManifestComparison;

type WorkspaceApplyPreflight = {
  applyPaths: Set<string>;
  conflictPaths: string[];
  blockingConflictPaths: string[];
};

type WorkspaceFileSnapshot =
  | { type: "file"; mode: number; size: number; sha256: string }
  | { type: "unsupported" };

export type WorkspaceManifestValueInputs = {
  "workspace.manifest.capture": {
    root: string;
    baseCommit: string | null;
    preserveDirectories?: readonly string[];
    includePaths?: readonly string[];
    hashes?: WorkspaceComputationHashes;
  };
  "workspace.manifest.snapshot": WorkspaceManifestValueInputs["workspace.manifest.capture"];
  "workspace.manifest.file": {
    path: string;
    maxBytes: number;
    root?: string;
    hashes?: WorkspaceComputationHashes;
  };
  "workspace.manifest.nodes": {
    root: string;
    paths: string[];
    hashes?: WorkspaceComputationHashes;
  };
  "workspace.manifest.tree-input": {
    inputPath: string;
    ref: string;
    entries: readonly WorkerWorkspaceManifestEntry[];
    source: { root: string; tree?: never } | { root: string; tree: string };
  };
  "workspace.manifest.serialize": { manifest: WorkerWorkspaceManifest };
  "workspace.manifest.overlay": {
    source: WorkerWorkspaceManifest;
    prepared: WorkerWorkspaceManifest;
    incoming: WorkerWorkspaceManifest;
  };
  "workspace.reconcile.preflight": {
    root: string;
    base: WorkerWorkspaceManifest;
    current: WorkerWorkspaceManifest;
    hashes?: WorkspaceComputationHashes;
  };
};

type WorkspaceManifestValueInput = { payload: Uint8Array<ArrayBuffer> };

export type WorkspaceStageInputSource<Raw = Uint8Array<ArrayBuffer>> =
  | {
      baseManifestRef: string;
      currentManifestRef: string;
      baseManifestRaw: Raw;
      currentManifestRaw: Raw;
    }
  | {
      publication: {
        metadata: Raw;
        publicationDigest: string;
        currentManifestRef: string;
        baseCommit: string;
      };
    };

export type WorkspaceStageInput<Raw = Uint8Array<ArrayBuffer>> = WorkspaceStageInputSource<Raw> & {
  inputPath: string;
  stagingRoot: string;
  stagedResultRef: string;
};

export type WorkspaceManifestComputationOperations = {
  "workspace.manifest.tree-input": {
    input: WorkspaceManifestValueInput;
    output: null;
  };
  "workspace.manifest.nodes": {
    input: WorkspaceManifestValueInput;
    output: WorkspaceComputationHashResult<Array<[string, WorkspaceNode]>>;
  };
  "workspace.manifest.capture": {
    input: WorkspaceManifestValueInput;
    output: WorkspaceComputationHashResult<WorkspaceManifestCapture>;
  };
  "workspace.manifest.snapshot": {
    input: WorkspaceManifestValueInput;
    output: WorkspaceComputationHashResult<WorkspaceManifestSnapshot>;
  };
  "workspace.manifest.parse": {
    input: { raw: Uint8Array<ArrayBuffer>; expectedRef?: string };
    output: { manifest: WorkerWorkspaceManifest; manifestRef: string };
  };
  "workspace.manifest.serialize": {
    input: WorkspaceManifestValueInput;
    output: { raw: string; manifestRef: string };
  };
  "workspace.manifest.overlay": {
    input: WorkspaceManifestValueInput;
    output: { manifest: WorkerWorkspaceManifest; manifestRef: string };
  };
  "workspace.manifest.pair": {
    input: {
      baseRaw: Uint8Array<ArrayBuffer>;
      baseRef: string;
      currentRaw: Uint8Array<ArrayBuffer>;
      currentRef: string;
    };
    output: WorkspaceManifestPair;
  };
  "workspace.reconcile.preflight": {
    input: WorkspaceManifestValueInput;
    output: WorkspaceComputationHashResult<WorkspaceApplyPreflight>;
  };
  "workspace.manifest.file": {
    input: WorkspaceManifestValueInput;
    output: WorkspaceComputationHashResult<WorkspaceFileSnapshot>;
  };
  "workspace.manifest.staged": {
    input: { root: string; ref: string };
    output: StagedWorkerWorkspaceInventory;
  };
  "workspace.manifest.entries": {
    input: {
      root: string;
      entries: StagedWorkerWorkspaceReadEntry[];
    };
    output: Uint8Array;
  };
  "workspace.manifest.stage-input": {
    input: WorkspaceStageInput;
    output: null;
  };
};

export type WorkspaceManifestComputationCommand = {
  [K in keyof WorkspaceManifestComputationOperations]: {
    type: K;
    input: WorkspaceManifestComputationOperations[K]["input"];
  };
}[keyof WorkspaceManifestComputationOperations];

export type WorkspaceManifestComputationResult =
  WorkspaceManifestComputationOperations[keyof WorkspaceManifestComputationOperations]["output"];
