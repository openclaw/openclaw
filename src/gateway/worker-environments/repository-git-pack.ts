import fs from "node:fs/promises";
import path from "node:path";
import { gitEnvironment } from "../../agents/worktrees/git.js";
import { executeGitCommand, gitNullConfigPath } from "../../infra/git-exec.js";
import { appendGitConfig } from "../../infra/git-maintenance-env.js";
import { parseConfiguredProjectGitUrl } from "../../projects/project-git-url.runtime.js";
import { workerSshCommandOptions } from "./ssh.js";
import { prepareWorkerWorkspaceGitPack } from "./workspace-git-base.js";

const FETCH_TIMEOUT_MS = 10 * 60_000;

/** The caller retains scratch-directory custody until this operation settles. */
export async function fetchRepositoryCheckoutPack(params: {
  url: string;
  baseCommit: string;
  httpAuthorization?: string;
  temporaryRoot: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<string> {
  const url = URL.canParse(params.url) ? new URL(params.url) : undefined;
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== params.url
  ) {
    throw new Error("Repository preparation requires a normalized HTTPS repository URL");
  }
  if (!/^[a-f0-9]{40}$/u.test(params.baseCommit)) {
    throw new Error("Repository preparation requires an exact commit");
  }
  if (
    params.httpAuthorization !== undefined &&
    (!params.httpAuthorization.trim() || /[\r\n\0]/u.test(params.httpAuthorization))
  ) {
    throw new Error("Private repository preparation requires a current repository credential");
  }
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  const repository = path.join(params.temporaryRoot, "repository.git");
  // Inherited Git configuration, tracing, credential helpers and .netrc must not
  // redirect this account-bound fetch or persist its credential. No checkout is made.
  const baseEnv = gitEnvironment({
    ...workerSshCommandOptions({ timeoutMs: FETCH_TIMEOUT_MS }).baseEnv,
    HOME: repository,
    XDG_CONFIG_HOME: repository,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "https",
  });
  const command = async (args: string[], authenticated = false): Promise<string> => {
    assertCurrent();
    const result = await executeGitCommand(
      repository,
      ["-c", "http.followRedirects=false", ...args],
      {
        baseEnv,
        env:
          authenticated && params.httpAuthorization
            ? appendGitConfig(baseEnv, [
                [`http.${params.url}.extraHeader`, `Authorization: ${params.httpAuthorization}`],
              ])
            : undefined,
        input: "",
        timeoutMs: FETCH_TIMEOUT_MS,
        signal: params.signal,
        beforeRun: assertCurrent,
        killProcessTree: true,
        maxOutputBytes: 4_096,
      },
    ).catch(() => {
      params.signal.throwIfAborted();
      // Git errors may echo raw or encoded authentication; never retain their
      // diagnostic payload or attach it as a cause across the preparation boundary.
      throw new Error("Git could not prepare the repository snapshot; retry preparation");
    });
    assertCurrent();
    if (result.termination !== "exit" || result.code !== 0 || result.stdoutTruncatedBytes) {
      throw new Error(
        authenticated
          ? "Repository could not supply the pinned repository commit; check access and retry preparation"
          : "Git could not prepare the repository snapshot; retry preparation",
      );
    }
    return result.stdout.trim();
  };

  assertCurrent();
  await fs.mkdir(repository, { mode: 0o700 });
  await command(["init", "--bare", "--quiet", "--template=", "--object-format=sha1"]);
  // Depth bounds history, not incoming disk bytes. The existing pack owner caps
  // the emitted snapshot; the temporary fetch also has a finite command deadline.
  await command(
    [
      "fetch",
      "--depth=1",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "--no-write-fetch-head",
      "--",
      params.url,
      params.baseCommit,
    ],
    true,
  );
  if ((await command(["cat-file", "-t", params.baseCommit])) !== "commit") {
    throw new Error("The pinned repository object is not a commit");
  }
  assertCurrent();
  const pack = await prepareWorkerWorkspaceGitPack({
    root: repository,
    baseCommit: params.baseCommit,
    temporaryRoot: params.temporaryRoot,
    signal: params.signal,
    baseEnv,
  });
  assertCurrent();
  return pack;
}

/** Native GitHub callers keep their existing source admission and token contract. */
export async function prepareRepositoryWorkerGitPack(params: {
  url: string;
  baseCommit: string;
  token: string;
  temporaryRoot: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<string> {
  if (parseConfiguredProjectGitUrl(params.url)?.url !== params.url) {
    throw new Error("Repository preparation requires a normalized GitHub HTTPS repository URL");
  }
  if (!params.token.trim()) {
    throw new Error("Private repository preparation requires a current GitHub credential");
  }
  const { token, ...input } = params;
  return await fetchRepositoryCheckoutPack({
    ...input,
    httpAuthorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  });
}
