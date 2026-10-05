import fs from "node:fs/promises";
import path from "node:path";
import { gitEnvironment } from "../../agents/worktrees/git.js";
import { executeGitCommand, gitNullConfigPath } from "../../infra/git-exec.js";
import { parseConfiguredProjectGitUrl } from "../../projects/project-git-url.runtime.js";
import { workerSshCommandOptions } from "./ssh.js";
import { prepareWorkerWorkspaceGitPack } from "./workspace-git-base.js";

const FETCH_TIMEOUT_MS = 10 * 60_000;

/** The caller retains scratch-directory custody until this operation settles. */
async function createTemporaryRepositoryFetch(params: {
  url: string;
  token?: string;
  temporaryRoot: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  if (parseConfiguredProjectGitUrl(params.url)?.url !== params.url) {
    throw new Error("Repository preparation requires a canonical GitHub URL");
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
        ...(authenticated && params.token
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
  return { repository, command, baseEnv };
}

export async function prepareRepositoryWorkerGitPack(params: {
  url: string;
  baseCommit: string;
  token: string;
  temporaryRoot: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<string> {
  if (!/^[a-f0-9]{40}$/u.test(params.baseCommit)) {
    throw new Error("Repository preparation requires an exact GitHub commit");
  }
  if (!params.token.trim()) {
    throw new Error("Private repository preparation requires a current GitHub credential");
  }
  const { repository, command, baseEnv } = await createTemporaryRepositoryFetch(params);
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
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

/** Fetch only into a caller-owned import directory; never register a Gateway project. */
export async function prepareRepositoryRecoveryCheckout(params: {
  url: string;
  baseCommit: string;
  branch: string;
  requestedRef: string | null;
  token?: string;
  temporaryRoot: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  if (!/^[a-f0-9]{40}$/u.test(params.baseCommit)) {
    throw new Error("Recovery requires an exact pinned repository commit");
  }
  const { command } = await createTemporaryRepositoryFetch(params);
  const readHead = async (branch: string) => {
    const ref = `refs/heads/${branch.replace(/^(?:refs\/)?heads\//u, "")}`;
    const raw = await command(["ls-remote", "--refs", "--", params.url, ref], true);
    if (!raw) {
      return undefined;
    }
    const [sha, observed, ...extra] = raw.split(/\s+/u);
    if (!sha || !/^[a-f0-9]{40}$/u.test(sha) || observed !== ref || extra.length) {
      throw new Error("Recovery remote branch observation is invalid");
    }
    return sha;
  };
  const sessionHead = await readHead(params.branch);
  const selectedRef = sessionHead ? params.branch : params.requestedRef;
  if (!selectedRef) {
    throw new Error("Recovery cannot verify the retired branch's source ref");
  }
  const remoteHeadCommit = sessionHead ?? (await readHead(selectedRef));
  if (!remoteHeadCommit) {
    throw new Error(
      "Recovery repository ref is missing; retain the old checkpoint and restore its source",
    );
  }
  // A finite history window proves ordinary forward movement without importing all historical blobs.
  await command(
    [
      "fetch",
      "--depth=2048",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "--",
      params.url,
      remoteHeadCommit,
    ],
    true,
  );
  await command(
    [
      "fetch",
      "--depth=1",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "--",
      params.url,
      params.baseCommit,
    ],
    true,
  );
  await command(["merge-base", "--is-ancestor", params.baseCommit, remoteHeadCommit]);
  const root = path.join(params.temporaryRoot, "checkout");
  await command(["worktree", "add", "--detach", "--", root, remoteHeadCommit]);
  return {
    root,
    remoteHeadCommit,
    verifyRemote: async () => {
      if ((await readHead(selectedRef)) !== remoteHeadCommit) {
        throw new Error("Remote branch changed during recovery; retain the checkpoint and retry");
      }
    },
  };
}
