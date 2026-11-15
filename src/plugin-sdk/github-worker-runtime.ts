/** Gateway-owned execution grants and external gh profiles for native workers. */
export { managedGitHubIdentityEnvironment } from "../agents/github-tool-identity-env.js";
export { writeManagedGitHubProfileFiles } from "../agents/github-tool-profile-files.js";
/** Keep node command discovery independent of Gateway execution owners. */
export async function prepareWorkerGitHubBindingGrant(
  ...args: Parameters<
    typeof import("../gateway/worker-environments/worker-github-execution-identity.js").prepareWorkerGitHubBindingGrant
  >
): ReturnType<
  typeof import("../gateway/worker-environments/worker-github-execution-identity.js").prepareWorkerGitHubBindingGrant
> {
  const runtime =
    await import("../gateway/worker-environments/worker-github-execution-identity.js");
  return await runtime.prepareWorkerGitHubBindingGrant(...args);
}
export type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "../gateway/worker-environments/worker-github-binding-contract.js";
export {
  parseWorkerGitHubLaunchBinding,
  type WorkerGitHubLaunchBinding,
} from "../worker/launch-descriptor.js";
