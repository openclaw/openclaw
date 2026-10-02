import fs from "node:fs/promises";
import path from "node:path";
import { gitEnvironment } from "../../agents/worktrees/git.js";
import { executeGitCommand, gitNullConfigPath } from "../../infra/git-exec.js";
import { parseProjectGitUrl } from "../../projects/project-git-url.js";
import { workerSshCommandOptions } from "./ssh.js";
import { prepareWorkerWorkspaceGitPack } from "./workspace-git-base.js";

const FETCH_TIMEOUT_MS = 10 * 60_000;

type RepositoryBaseRequest = {
  url: string;
  baseCommit: string;
  token: string;
  temporaryRoot: string;
  signal: AbortSignal;
  assertCurrent: () => void;
};

async function prepareRepositoryWorkerBase(params: RepositoryBaseRequest) {
  if (parseProjectGitUrl(params.url)?.url !== params.url) {
    throw new Error("Repository preparation requires a canonical GitHub URL");
  }
  if (!/^[a-f0-9]{40}$/u.test(params.baseCommit)) {
    throw new Error("Repository preparation requires an exact GitHub commit");
  }
  if (!params.token.trim()) {
    throw new Error("Private repository preparation requires a current GitHub credential");
  }
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  const repository = path.join(params.temporaryRoot, "repository.git");
  // Inherited Git configuration, tracing, credential helpers and .netrc must not
  // redirect this account-bound fetch or persist its credential.
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
        ...(authenticated
          ? {
              env: {
                GIT_CONFIG_COUNT: "3",
                GIT_CONFIG_KEY_2: `http.${params.url}.extraHeader`,
                GIT_CONFIG_VALUE_2: `Authorization: Basic ${Buffer.from(`x-access-token:${params.token}`).toString("base64")}`,
              },
            }
          : {}),
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
          ? "GitHub could not supply the pinned repository commit; check access and retry preparation"
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
  return { repository, command, baseEnv };
}

/** The caller retains scratch-directory custody until this operation settles. */
export async function prepareRepositoryWorkerGitPack(
  params: RepositoryBaseRequest,
): Promise<string> {
  const { repository, baseEnv } = await prepareRepositoryWorkerBase(params);
  const pack = await prepareWorkerWorkspaceGitPack({
    root: repository,
    baseCommit: params.baseCommit,
    temporaryRoot: params.temporaryRoot,
    signal: params.signal,
    baseEnv,
  });
  params.assertCurrent();
  return pack;
}

/** A transient source for the existing node snapshot transfer, never an execution workspace. */
export async function prepareRepositoryWorkerReadWorkspace(
  params: RepositoryBaseRequest,
): Promise<string> {
  const { repository, command } = await prepareRepositoryWorkerBase(params);
  const workspace = path.join(params.temporaryRoot, "workspace");
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.writeFile(path.join(workspace, ".git"), "gitdir: " + repository + "\n");
  await command(["config", "--local", "core.bare", "false"]);
  await command(["config", "--local", "core.worktree", workspace]);
  // The fetched repository has no templates, helpers or inherited configuration.
  // Checkout never executes repository setup or exports its read credential.
  await command(["checkout", "--detach", "--force", params.baseCommit]);
  params.assertCurrent();
  return workspace;
}
