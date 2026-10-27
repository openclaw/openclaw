import type { LocalWorkspaceManifestValue } from "./local-workspace-store.types.js";
import type {
  readActualWorkspaceManifestImpl,
  readWorkspaceFileSnapshotWithLimit,
} from "./workspace-actual-manifest.js";
import type { WorkspaceHashMetrics } from "./workspace-hash-memo.js";
import type { WorkspaceNode, WorkspacePreflightInput } from "./workspace-manifest-comparison.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import type {
  StagedWorkerWorkspaceInventory,
  StagedWorkerWorkspaceReadEntry,
  WorkerWorkspaceGitHistory,
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

type WorkspaceManifestSnapshot = Awaited<ReturnType<typeof readActualWorkspaceManifestImpl>>;
type WorkspaceManifestCapture = Omit<WorkspaceManifestSnapshot, "rawManifest">;

export type WorkspaceManifestValueInputs = {
  "workspace.manifest.capture": {
    root: string;
    baseCommit: string | null;
    preserveDirectories?: readonly string[];
    includePaths?: readonly string[];
    buildCacheInputs?: string[];
    hashes?: WorkspaceComputationHashes;
  };
  "workspace.manifest.snapshot": WorkspaceManifestValueInputs["workspace.manifest.capture"];
  "workspace.manifest.document": WorkspaceManifestValueInputs["workspace.manifest.capture"];
  "workspace.manifest.reference": WorkspaceManifestValueInputs["workspace.manifest.capture"];
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
  "workspace.reconcile.preflight": WorkspacePreflightInput & {
    root: string;
    hashes?: WorkspaceComputationHashes;
  };
};

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
  buildCacheInputs?: string[];
  gitHistory?: WorkerWorkspaceGitHistory;
  parentCommit?: string;
};

export type WorkspaceManifestValueOutputs = {
  "workspace.manifest.capture": WorkspaceComputationHashResult<WorkspaceManifestCapture>;
  "workspace.manifest.snapshot": WorkspaceComputationHashResult<WorkspaceManifestSnapshot>;
  "workspace.manifest.document": WorkspaceComputationHashResult<
    Omit<WorkspaceManifestSnapshot, "manifest">
  >;
  "workspace.manifest.reference": WorkspaceComputationHashResult<string>;
  "workspace.manifest.file": WorkspaceComputationHashResult<
    Awaited<ReturnType<typeof readWorkspaceFileSnapshotWithLimit>>
  >;
  "workspace.manifest.nodes": WorkspaceComputationHashResult<Array<[string, WorkspaceNode]>>;
  "workspace.manifest.tree-input": null;
  "workspace.manifest.serialize": { raw: string; manifestRef: string };
  "workspace.manifest.overlay": WorkspaceManifestCapture;
  "workspace.reconcile.preflight": WorkspaceComputationHashResult<{
    applyPaths: Set<string>;
    conflictPaths: string[];
    blockingConflictPaths: string[];
  }>;
};

export type WorkspaceManifestComputationOperations = {
  [Type in keyof WorkspaceManifestValueInputs]: {
    input: { payload: Uint8Array<ArrayBuffer> };
    output: WorkspaceManifestValueOutputs[Type];
  };
} & {
  "workspace.manifest.local": {
    input: { snapshot: Uint8Array<ArrayBuffer> };
    output: LocalWorkspaceManifestValue;
  };
  "workspace.manifest.base-refresh": {
    input: {
      beforeRoot: string;
      afterRoot: string;
      baseCommit: string;
      baseRaw: Uint8Array<ArrayBuffer>;
      baseRef: string;
      buildCacheInputs: string[];
      action: "refresh_base" | "prepare_pr";
      hashes?: WorkspaceComputationHashes;
    };
    output: WorkspaceComputationHashResult<{
      rawManifest: string;
      manifestRef: string;
      buildCacheInputs: string[];
    }>;
  };
  "workspace.manifest.equal": {
    input: {
      baseRaw: Uint8Array<ArrayBuffer>;
      baseRef: string;
      currentRaw: Uint8Array<ArrayBuffer>;
      currentRef: string;
      buildCacheInputs?: string[];
    };
    output: boolean;
  };
  "workspace.manifest.remote-capture": {
    input: {
      argv: string[];
      home: string;
      memo?: string;
      maxHashMemoBytes: number;
    };
    output: string;
  };
  "workspace.manifest.parse": {
    input: { raw: Uint8Array<ArrayBuffer>; expectedRef?: string };
    output: { manifest: WorkerWorkspaceManifest; manifestRef: string };
  };
  "workspace.manifest.paths": {
    input: { raw: Uint8Array<ArrayBuffer>; expectedRef: string; buildCacheInputs: string[] };
    output: Set<string>;
  };
  "workspace.manifest.pair": {
    input: {
      baseRaw: Uint8Array<ArrayBuffer>;
      baseRef: string;
      currentRaw: Uint8Array<ArrayBuffer>;
      currentRef: string;
    };
    output: {
      base: WorkerWorkspaceManifest;
      current: WorkerWorkspaceManifest;
      changed: boolean;
      entries: WorkerWorkspaceManifestEntry[];
      paths: string[];
    };
  };
  "workspace.manifest.staged": {
    input: { root: string; ref: string; buildCacheInputs?: string[] };
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
