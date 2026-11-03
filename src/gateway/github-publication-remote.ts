import os from "node:os";
import { appendGitConfig, gitMaintenanceEnvironment } from "../infra/git-maintenance-env.js";
import { withGitNetworkRetry } from "../infra/git-network-retry.js";
import { runCommandBuffered } from "../process/exec.js";
import { withGitProcessOperation } from "../process/spawn-diagnostics.js";
import { parseGitHubPublicationBaseRef } from "./github-publication-base.js";
type GitHubCommandOptions = {
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer | (() => string | Buffer);
  maxOutputBytes?: number;
  beforeRun?: () => void;
};
/** GitHub API transport owns gh; local Git and workspace effects stay with the host. */
export async function runGitHubPublicationCommand(
  argv: string[],
  options: GitHubCommandOptions = {},
) {
  if (argv[0] !== "gh") {
    throw new Error("GitHub API transport requires gh.");
  }
  return await withGitProcessOperation("publication", () =>
    withGitNetworkRetry(
      undefined,
      { timeoutMs: 60_000, beforeRun: options.beforeRun },
      (timeoutMs) =>
        runCommandBuffered(argv, {
          env: {
            ...(options.env ?? process.env),
            GIT_NO_REPLACE_OBJECTS: "1",
            ...appendGitConfig(gitMaintenanceEnvironment(), [["core.hooksPath", os.devNull]]),
          },
          ...(options.input !== undefined
            ? { input: typeof options.input === "function" ? options.input() : options.input }
            : {}),
          timeoutMs,
          maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
        }),
    ),
  );
}
export async function requireGitHubPublicationCommand(
  argv: string[],
  options: GitHubCommandOptions = {},
) {
  const result = await runGitHubPublicationCommand(argv, options);
  if (result.code !== 0) {
    throw new Error("gh command failed");
  }
  return result.stdout.toString("utf8").trim();
}
export function createGitHubPublicationApiRunner(assertCurrent: () => void) {
  return {
    run: async (argv: string[], options: GitHubCommandOptions = {}) => {
      const result = await runGitHubPublicationCommand(argv, {
        ...options,
        beforeRun: () => {
          assertCurrent();
          options.beforeRun?.();
        },
      });
      assertCurrent();
      return result;
    },
  };
}

export function githubPublicationApiArgs(
  endpoint: string,
  method = "GET",
  host = "github.com",
): string[] {
  return [
    "gh",
    "api",
    "--hostname",
    host,
    "--method",
    method,
    endpoint,
    ...(method === "GET" ? [] : ["--input", "-"]),
  ];
}

export async function readGitHubPublicationBaseSha(
  run: ReturnType<typeof createGitHubPublicationApiRunner>["run"],
  repository: string,
  branch: string,
  host: string,
  env: NodeJS.ProcessEnv,
) {
  const result = await run(
    [
      "gh",
      "api",
      "--hostname",
      host,
      `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
      "--jq",
      "{ref: .ref, sha: .object.sha}",
    ],
    { env },
  );
  if (result.code !== 0) {
    throw new Error("GitHub publication workspace base branch could not be verified.");
  }
  return parseGitHubPublicationBaseRef(result.stdout.toString("utf8"), branch);
}
