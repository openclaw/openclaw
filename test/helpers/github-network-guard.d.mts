export type GitHubTestContext = {
  file?: string;
  test?: string;
  negativeControl?: boolean;
};
export function setGitHubTestContext(context: () => GitHubTestContext): void;
export function withGitHubNegativeControl<T>(action: () => T): T;
export function githubNetworkAttemptCounts(): { incidental: number; negativeControl: number };
export function installGitHubNetworkGuard(): () => void;
export function blockGitHubTestCommand(transport?: string): never;
export function githubTestHostPolicy(env?: NodeJS.ProcessEnv): {
  suffixes: string[];
  exact: string[];
};
export function isGitHubTestHost(host: unknown, env?: NodeJS.ProcessEnv): boolean;
