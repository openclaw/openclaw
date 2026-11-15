import {
  githubPublicationApiArgs,
  runPublicationCommand,
} from "./github-publication-git-transport.js";

/** Native transport/response failure, distinct from a caller or source authority refusal. */
export class GitHubPublicationReadUnavailableError extends Error {}

export function createGitHubPublicationJsonReader(params: {
  host: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  unavailable: () => Error;
  requireSuccess: boolean;
}) {
  const { host, env, assertCurrent, unavailable, requireSuccess } = params;
  const readFailure = () => {
    const cause = unavailable();
    return new GitHubPublicationReadUnavailableError(cause.message, { cause });
  };
  return async (
    endpoint: string,
    query?: { query?: string; variables?: Record<string, unknown>; jq?: string },
  ): Promise<unknown> => {
    assertCurrent();
    const response = await runPublicationCommand(
      [
        ...githubPublicationApiArgs(endpoint, query?.query ? "POST" : "GET", host),
        ...(query?.jq ? ["--jq", query.jq] : []),
      ],
      {
        env,
        ...(query?.query
          ? { input: JSON.stringify({ query: query.query, variables: query.variables }) }
          : {}),
        beforeRun: assertCurrent,
      },
    ).catch(() => {
      assertCurrent();
      throw readFailure();
    });
    assertCurrent();
    if (response.code !== 0) {
      if (requireSuccess) {
        throw readFailure();
      }
      return undefined;
    }
    try {
      return JSON.parse(response.stdout.toString("utf8"));
    } catch {
      throw readFailure();
    }
  };
}
