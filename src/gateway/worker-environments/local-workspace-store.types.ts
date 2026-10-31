import type { Selectable, Updateable } from "kysely";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { LocalWorkspaceManifestRecord } from "./local-workspace-manifest-tree.js";

export type LocalWorkspaceProjection = Selectable<DB["local_workspace_projections"]>;
export type LocalWorkspaceManifestMutation = {
  records: LocalWorkspaceManifestRecord[];
  removed: string[];
  previousRoot: string | null;
  resultingRoot: string;
  replace?: boolean;
  treeRoot?: string;
  previousTreeRoot?: string | null;
  fingerprints?: { target: "canonical" | "projection"; blob: string };
};
export type LocalWorkspaceMutation =
  | { kind: "create"; row: Omit<LocalWorkspaceProjection, "revision"> }
  | {
      kind: "update";
      revision: number;
      patch: Updateable<DB["local_workspace_projections"]>;
      manifest?: LocalWorkspaceManifestMutation;
    }
  | { kind: "delete"; revision: number };

/** Manifest computation prepares the full mutation; the host publishes only this header. */
export type LocalWorkspacePreparedUpdate = {
  revision: number;
  patch: Updateable<DB["local_workspace_projections"]>;
  mutation: Uint8Array;
  preparations?: Uint8Array[];
};

export type LocalWorkspaceManifestScan = {
  version: 1;
  kind: "scan";
  previousRoot: string | null;
  resultingRoot: string;
  treeRoot?: string;
  previousTreeRoot?: string | null;
  fingerprints?: { target: "canonical" | "projection"; blob: string };
  preparations?: Uint8Array[];
  records: LocalWorkspaceManifestRecord[];
  observation?: LocalWorkspacePreparedUpdate;
  removed: string[];
  replace?: true;
  baseManifestRaw: string;
  baseManifestRef: string;
  currentManifestRaw: string;
  currentManifestRef: string;
  buildCacheInputs: string[];
};

export type LocalWorkspaceManifestValue =
  | LocalWorkspaceManifestScan
  | { kind: "rescan" }
  | { kind: "materialize"; rawManifest: string; manifestRef: string }
  | { kind: "replace"; update: LocalWorkspacePreparedUpdate };
