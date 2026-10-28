import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { runCommandBuffered } from "../process/exec.js";
import type {
  GitLabPublicationCredentials,
  GitLabPublicationTarget,
} from "./gitlab-publication-adapter.js";

const oid = /^[a-f0-9]{40}$/u;

export type GitLabPublicationGit = Awaited<ReturnType<typeof prepareGitLabPublicationGit>>;

/** Local objects live in a private bare repository; the session worktree and its index remain untouched. */
export async function prepareGitLabPublicationGit(params: {
  repositoryRoot: string;
  snapshot: { baseCommit: string; baseTree: string; workspaceTree: string };
  parentCommit: string;
  message: string;
  author: { name: string; email: string; date: string };
  target: GitLabPublicationTarget;
  assertCurrent: () => void;
}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gitlab-publication-"));
  const directory = path.join(temporary, "objects.git");
  const gitExecutable = resolveExecutablePath("git");
  if (!gitExecutable) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw new Error("GitLab publication requires Git.");
  }
  const commonEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: temporary,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "0",
  };
  const run = async (
    args: string[],
    options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {},
  ) => {
    params.assertCurrent();
    const result = await runCommandBuffered(
      [gitExecutable, "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args],
      {
        baseEnv: {},
        env: { ...commonEnv, ...options.env },
        ...(options.input === undefined ? {} : { input: options.input }),
        timeoutMs: 60_000,
        maxOutputBytes: 256 * 1024,
      },
    );
    params.assertCurrent();
    if (result.code !== 0) {
      throw new Error("GitLab publication local Git operation failed.");
    }
    return result.stdout.toString("utf8").trim();
  };
  try {
    const commonDirectory = await run([
      "-C",
      params.repositoryRoot,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const sourceObjects = path.join(commonDirectory, "objects");
    await fs.stat(sourceObjects);
    await run(["init", "--bare", "--quiet", "--object-format=sha1", directory]);
    // Local upload-pack subprocesses must see the same pinned source objects.
    // This private repository is removed by close(); no source config is changed.
    await fs.writeFile(
      path.join(directory, "objects", "info", "alternates"),
      `${JSON.stringify(sourceObjects)}\n`,
      { mode: 0o600 },
    );
    const env: NodeJS.ProcessEnv = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects,
    };
    const git = (args: string[], input?: string | Buffer) =>
      run(["--git-dir", directory, ...args], { env, ...(input === undefined ? {} : { input }) });
    if (!oid.test(params.parentCommit)) {
      throw new Error("GitLab publication parent commit is invalid.");
    }
    if (
      !oid.test(params.snapshot.baseCommit) ||
      !oid.test(params.snapshot.baseTree) ||
      !oid.test(params.snapshot.workspaceTree)
    ) {
      throw new Error("GitLab publication accepted object identity is invalid.");
    }
    await git(["cat-file", "-e", `${params.parentCommit}^{commit}`]);
    const baseTree = await git(["rev-parse", `${params.snapshot.baseCommit}^{tree}`]);
    if (baseTree !== params.snapshot.baseTree) {
      throw new Error("GitLab publication pinned source tree changed.");
    }
    // Native workspace capture wrote the accepted tree into the managed
    // repository. The private bare transport reads exactly those objects via
    // alternates; it never reconstructs content from a second checkpoint.
    await git(["cat-file", "-e", `${params.snapshot.workspaceTree}^{tree}`]);
    const commitEnv: NodeJS.ProcessEnv = {
      ...env,
      GIT_AUTHOR_NAME: params.author.name,
      GIT_AUTHOR_EMAIL: params.author.email,
      GIT_AUTHOR_DATE: params.author.date,
      GIT_COMMITTER_NAME: params.author.name,
      GIT_COMMITTER_EMAIL: params.author.email,
      GIT_COMMITTER_DATE: params.author.date,
    };
    const headCommit = await run(
      [
        "--git-dir",
        directory,
        "commit-tree",
        params.snapshot.workspaceTree,
        "-p",
        params.parentCommit,
      ],
      {
        env: commitEnv,
        input: params.message,
      },
    );
    if (!oid.test(headCommit)) {
      throw new Error("GitLab publication commit identity is invalid.");
    }
    return {
      headCommit,
      directory,
      async run(args: string[], token?: string) {
        const scopedHeader =
          token === undefined
            ? {}
            : {
                GIT_CONFIG_COUNT: "3",
                GIT_CONFIG_KEY_0: `http.${params.target.gitUrl}.extraheader`,
                GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`,
                GIT_CONFIG_KEY_1: "http.followRedirects",
                GIT_CONFIG_VALUE_1: "false",
                GIT_CONFIG_KEY_2: "credential.helper",
                GIT_CONFIG_VALUE_2: "",
              };
        return await run(["--git-dir", directory, ...args], { env: { ...env, ...scopedHeader } });
      },
      async close() {
        await fs.rm(temporary, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function observeGitLabPublicationHead(params: {
  target: GitLabPublicationTarget;
  branch: string;
  credentials: GitLabPublicationCredentials;
  git: GitLabPublicationGit;
  assertCurrent: () => void;
}): Promise<string | null> {
  return await params.credentials.withToken(async (token) => {
    params.assertCurrent();
    const raw = await params.git.run(
      ["ls-remote", "--refs", params.target.gitUrl, `refs/heads/${params.branch}`],
      token,
    );
    const lines = raw ? raw.split("\n") : [];
    if (lines.length > 1) {
      throw new Error("GitLab publication branch observation is invalid.");
    }
    if (!lines.length) {
      return null;
    }
    const match = /^([a-f0-9]{40})\trefs\/heads\/(.+)$/u.exec(lines[0]!);
    if (!match || match[2] !== params.branch) {
      throw new Error("GitLab publication branch observation is invalid.");
    }
    return match[1]!;
  });
}

export async function pushGitLabPublicationCommit(params: {
  target: GitLabPublicationTarget;
  branch: string;
  expectedHead: string | null;
  git: GitLabPublicationGit;
  credentials: GitLabPublicationCredentials;
  assertCurrent: () => void;
}) {
  return await params.credentials.withToken(async (token) => {
    params.assertCurrent();
    await params.git.run(
      [
        "push",
        "--porcelain",
        `--force-with-lease=refs/heads/${params.branch}:${params.expectedHead ?? ""}`,
        "--no-follow-tags",
        "--recurse-submodules=no",
        "--",
        params.target.gitUrl,
        `${params.git.headCommit}:refs/heads/${params.branch}`,
      ],
      token,
    );
  });
}
