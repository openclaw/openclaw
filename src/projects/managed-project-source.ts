export type ManagedProjectOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  assertCurrent?: () => void;
};

export type ManagedProjectBaseV1 = { commit: string; ref: string };

/** Native custody supplies environment; source adapters own remote admission and transport. */
export type ManagedProjectSourceV1 = {
  resolveUrl: (url: string) => { url: string; name: string } | null;
  invalidUrlMessage: string;
  clone: (
    input: { url: string; target: string; requiredCommit?: string },
    options: ManagedProjectOptions & { readonly env: NodeJS.ProcessEnv; assertCurrent: () => void },
  ) => Promise<void>;
  ensureCommit: (
    input: { url: string; target: string; commit: string },
    options: ManagedProjectOptions & { readonly env: NodeJS.ProcessEnv; assertCurrent: () => void },
  ) => Promise<void>;
  resolveBase: (
    input: { url: string; target: string; ref?: string },
    options: ManagedProjectOptions & { readonly env: NodeJS.ProcessEnv; assertCurrent: () => void },
  ) => Promise<ManagedProjectBaseV1>;
  refresh: (
    input: { url: string; target: string },
    options: ManagedProjectOptions & { readonly env: NodeJS.ProcessEnv; assertCurrent: () => void },
  ) => Promise<void>;
};
