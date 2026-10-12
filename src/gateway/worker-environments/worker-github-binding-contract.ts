import type { WorkerGitHubLaunchBinding } from "../../worker/launch-descriptor.js";

export type WorkerGitHubBindingRefresh = {
  generation: number;
  token: string;
  expiresAtMs?: number;
};

export type WorkerGitHubBindingGrant = {
  binding: WorkerGitHubLaunchBinding;
  expiresAtMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  refresh?: (installedGeneration?: number) => Promise<WorkerGitHubBindingRefresh | undefined>;
  startRenewal?: (install: (snapshot: WorkerGitHubBindingRefresh) => Promise<void>) => () => void;
  revoke: () => Promise<void>;
};
