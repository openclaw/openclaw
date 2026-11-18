import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { WorktreeWorkerAuthority } from "./types.js";

export type WorktreeFilesystemOptions = {
  signal?: AbortSignal;
  commitGuard: SessionSourceAssertion;
  workerAuthority?: WorktreeWorkerAuthority;
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
