import type { ManagedProjectBaseV1 } from "../projects/managed-project-source.js";
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
};
