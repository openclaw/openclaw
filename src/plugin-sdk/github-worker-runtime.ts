/** Focused composition seam for process-scoped GitHub credentials on managed workers. */
export { managedGitHubIdentityEnvironment } from "../agents/github-tool-identity-env.js";
export { writeManagedGitHubProfileFiles } from "../agents/github-tool-identity.js";
export {
  prepareWorkerGitHubBinding,
  prepareWorkerGitHubBindingGrant,
  type WorkerGitHubBindingGrant,
  type WorkerGitHubBindingRefresh,
} from "../gateway/worker-environments/worker-github-binding.js";
export {
  parseWorkerGitHubLaunchBinding,
  type WorkerGitHubLaunchBinding,
} from "../worker/launch-descriptor.js";
