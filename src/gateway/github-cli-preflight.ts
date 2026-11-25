import { resolveExecutablePathAsync } from "../infra/executable-path.js";

const GITHUB_CLI_REQUIRED_MESSAGE =
  "GitHub CLI (`gh`) is required on the Gateway host. Install it and retry.";

export class GitHubCliUnavailableError extends Error {
  constructor() {
    super(GITHUB_CLI_REQUIRED_MESSAGE);
    this.name = "GitHubCliUnavailableError";
  }
}

export async function assertGitHubCliAvailable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Installation can change executable availability without changing PATH; re-probe on each retry.
  if (!(await resolveExecutablePathAsync("gh", { env, useCache: false }))) {
    throw new GitHubCliUnavailableError();
  }
}
