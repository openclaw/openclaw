import {
  githubPublicationApiArgs,
  runPublicationCommand,
} from "./github-publication-git-transport.js";

export function createGitHubPublicationJsonReader(params: {
  host: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  unavailable: () => Error;
  requireSuccess: boolean;
}) {
  const { host, env, assertCurrent, unavailable, requireSuccess } = params;
  return async (endpoint: string): Promise<unknown> => {
    assertCurrent();
    const response = await runPublicationCommand(githubPublicationApiArgs(endpoint, "GET", host), {
      env,
      beforeRun: assertCurrent,
    }).catch(() => {
      assertCurrent();
      throw unavailable();
    });
    assertCurrent();
    if (response.code !== 0) {
      if (requireSuccess) {
        throw unavailable();
      }
      return undefined;
    }
    try {
      return JSON.parse(response.stdout.toString("utf8"));
    } catch {
      throw unavailable();
    }
  };
}
