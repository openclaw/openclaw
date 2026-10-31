export type WorktreeFilesystemOptions = {
  signal?: AbortSignal;
  commitGuard: () => void;
};

export interface WorktreeFilesystemBackend {
  id: string;
  estimateCloneBytes: (entries: number, indexBytes: number) => number;
  createTemplate: (path: string, options: WorktreeFilesystemOptions) => Promise<void>;
  cloneTemplate: (
    source: string,
    destination: string,
    options: WorktreeFilesystemOptions,
  ) => Promise<void>;
}
