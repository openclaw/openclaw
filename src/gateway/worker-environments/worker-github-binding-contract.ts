import type { WorkerGitHubLaunchBinding } from "../../worker/launch-descriptor.js";

export type WorkerGitHubBindingRefresh = {
  generation: number;
  token: string;
  expiresAtMs?: number;
};
export type WorkerGitHubBindingGrant = {
  readonly binding: WorkerGitHubLaunchBinding;
  readonly signal: AbortSignal;
  assertCurrent: () => void;
  refresh: (installedGeneration?: number) => Promise<WorkerGitHubBindingRefresh | undefined>;
  revoke: () => Promise<void>;
};
