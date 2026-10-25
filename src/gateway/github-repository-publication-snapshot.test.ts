import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import {
  applyNodeRepositoryCheckpoint,
  withNodeRepositoryPublication,
} from "../node-host/node-worker-repository-transfers.js";
import { NODE_WORKSPACE_EMPTY_MANIFEST_REF } from "../worker/node-workspace-transfer-protocol.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import { prepareRepositoryPublicationRestore } from "./github-repository-publication-restore.js";
import {
  REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
  readGitHubRepositoryPublicationBlob,
  readGitHubRepositoryPublicationMetadata,
} from "./github-repository-publication-snapshot.js";
import { captureWorkspaceManifest } from "./worker-environments/workspace-manifest-worker.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const baseEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Snapshot Fixture",
  GIT_AUTHOR_EMAIL: "snapshot@example.test",
  GIT_COMMITTER_NAME: "Snapshot Fixture",
  GIT_COMMITTER_EMAIL: "snapshot@example.test",
};
const runGit = (cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: Buffer) =>
  execFileSync("git", args, { cwd, env, input, encoding: "utf8" }).trim();

async function fixture(linked: false | "linked" | "linked-config" = false) {
  const root = temporary.make("github-repository-snapshot-");
  let cwd = path.join(root, "worker");
  await fs.mkdir(cwd);
  const gitConfig = path.join(root, "empty.gitconfig");
  await fs.writeFile(gitConfig, "");
  const env = { ...baseEnv, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: gitConfig };
  const git = (...args: string[]) => runGit(cwd, env, args);
  const file = (name: string) => path.join(cwd, name);
  const write = (name: string, content: string | Buffer) => fs.writeFile(file(name), content);
  git("init", "--quiet");
  await write(".gitattributes", "*.txt text eol=lf\n");
  await write(".gitignore", "ignored*.txt\n");
  await write("ignored-removed.txt", "private generated fixture\n");
  git("add", "-f", "ignored-removed.txt");
  await write("counter.txt", "zero\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  if (linked) {
    if (linked === "linked-config") {
      git("config", "extensions.worktreeConfig", "true");
    }
    const checkout = path.join(root, "linked");
    git("worktree", "add", "--quiet", "--detach", checkout, base);
    cwd = checkout;
  }
  const output = path.join(root, "snapshot");
  const capture = (baseCommit = base) =>
    execFileSync(
      process.execPath,
      ["-e", REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS, cwd, baseCommit, output],
      { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  const metadata = (digest: string) => readGitHubRepositoryPublicationMetadata(output, digest);
  const blob = (sha: string) => readGitHubRepositoryPublicationBlob(output, sha);
  return { cwd, root, git, base, output, capture, env, file, write, metadata, blob };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const indexPath = (f: Fixture) => path.resolve(f.cwd, f.git("rev-parse", "--git-path", "index"));
const remoteSnapshot = async (f: Fixture, base = f.base) =>
  (await f.metadata(f.capture(base))).snapshot;
const local = (f: Fixture) => captureGitHubPublicationWorkspaceSnapshot({ cwd: f.cwd });
const state = async (f: Fixture, names: string[] = []) => [
  f.git("rev-parse", "HEAD"),
  ...(await Promise.all([
    fs.readFile(indexPath(f)),
    ...names.map((name) => fs.readFile(f.file(name))),
  ])),
];

it("preserves committed CRLF bytes when capturing clean and edited workspaces", async () => {
  const f = await fixture();
  const file = "gradlew.bat";
  const content = Buffer.from("@echo off\r\necho unchanged\r\n");
  await f.write(file, content);
  await f.write(".gitattributes", "* text=auto eol=lf\n");
  f.git("add", ".gitattributes");
  // Model an existing CRLF blob: ordinary add would normalize a new file first.
  const blob = runGit(f.cwd, f.env, ["hash-object", "-w", "--no-filters", "--stdin"], content);
  f.git("update-index", "--add", "--cacheinfo", `100644,${blob},${file}`);
  f.git("commit", "--quiet", "-m", "existing CRLF blob");
  const head = f.git("rev-parse", "HEAD");
  const tree = f.git("rev-parse", "HEAD^{tree}");
  expect(f.git("status", "--porcelain")).toBe("");
  const before = await state(f, [file]);
  const manifestHome = temporary.make(".publication-home-", process.cwd());
  for (const edited of [false, true]) {
    if (edited) {
      await f.write("counter.txt", "changed\r\n");
      await fs.rm(f.output, { recursive: true });
    }
    const captured = await local(f);
    const remote = await remoteSnapshot(f, head);
    const nodeSnapshot = await withNodeRepositoryPublication(
      {
        workspaceDir: f.cwd,
        manifestHome,
        baseCommit: head,
        baseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
      },
      async (root) => {
        const raw = await fs.readFile(path.join(root, "snapshot.json"), "utf8");
        const digest = "sha256:" + createHash("sha256").update(raw).digest("hex");
        return (await readGitHubRepositoryPublicationMetadata(root, digest)).snapshot;
      },
    );
    expect(nodeSnapshot).toEqual(remote);
    expect(captured).toMatchObject({
      sourceHeadCommit: head,
      sourceIndexTree: tree,
      workspaceTree: remote.workspaceTree,
    });
    expect(f.git("rev-parse", `${captured.workspaceTree}:${file}`)).toBe(blob);
    if (edited) {
      expect(remote.entries).toEqual([
        { path: "counter.txt", mode: "100644", sha: expect.any(String) },
      ]);
      expect(await f.blob(remote.entries[0]!.sha!)).toEqual(Buffer.from("changed\n"));
    } else {
      expect(captured.workspaceTree).toBe(tree);
      expect(remote.entries).toEqual([]);
    }
    await expect(state(f, [file])).resolves.toEqual(before);
  }
});

it("captures same-size unstaged edits with matching cached timestamps in a linked worktree", async () => {
  const f = await fixture("linked");
  f.git("config", "core.trustctime", "false");
  f.git("config", "core.checkStat", "minimal");
  const file = f.file("counter.txt");
  const timestamp = Math.floor(Date.now() / 1000) - 60;
  await fs.writeFile(file, "staged\n");
  await fs.utimes(file, timestamp, timestamp);
  f.git("add", "counter.txt");
  const stagedTree = f.git("write-tree");
  // Reproduce a coarse-timestamp filesystem without relying on execution timing.
  await fs.utimes(indexPath(f), timestamp, timestamp);
  await fs.writeFile(file, "latest\n");
  await fs.utimes(file, timestamp, timestamp);
  const before = await state(f, ["counter.txt"]);
  const captured = await local(f);
  const remote = await remoteSnapshot(f);
  expect(captured).toMatchObject({
    sourceIndexTree: stagedTree,
    workspaceTree: remote.workspaceTree,
  });
  expect(f.git("show", `${captured.workspaceTree}:counter.txt`)).toBe("latest");
  await expect(state(f, ["counter.txt"])).resolves.toEqual(before);
});

it.each(["split", "linked-config"] as const)(
  "preserves staged path inventory and index bytes while staging workspace changes (%s index)",
  async (format) => {
    const f = await fixture(format === "linked-config" ? format : false);
    await f.write("ignored-added.txt", "staged\r\n");
    f.git("add", "-f", "ignored-added.txt");
    await f.write("ignored-intent.txt", "intent\r\n");
    f.git("add", "-N", "-f", "ignored-intent.txt");
    f.git("rm", "--cached", "ignored-removed.txt");
    await f.write("counter.txt", "staged counter\r\n");
    f.git("add", "counter.txt");
    await f.write("counter.txt", "latest counter\r\n");
    await f.write("ignored-added.txt", "latest\r\n");
    if (format === "split") {
      f.git("update-index", "--split-index");
    }
    const before = await state(f, ["ignored-removed.txt"]);
    const remote = await remoteSnapshot(f);
    await expect(state(f, ["ignored-removed.txt"])).resolves.toEqual(before);
    expect(remote.entries).toEqual(
      expect.arrayContaining([
        { path: "ignored-removed.txt", mode: "100644", sha: null },
        expect.objectContaining({ path: "ignored-added.txt", mode: "100644" }),
        expect.objectContaining({ path: "ignored-intent.txt", mode: "100644" }),
      ]),
    );
    const captured = await local(f);
    await expect(state(f, ["ignored-removed.txt"])).resolves.toEqual(before);
    expect(captured.workspaceTree).toBe(remote.workspaceTree);
    expect(f.git("show", `${captured.sourceIndexTree}:ignored-added.txt`)).toBe("staged");
    for (const [name, content] of [
      ["ignored-added.txt", "latest\n"],
      ["ignored-intent.txt", "intent\n"],
      ["counter.txt", "latest counter\n"],
    ] as const) {
      const entry = remote.entries.find((candidate) => candidate.path === name)!;
      expect(await f.blob(entry.sha!)).toEqual(Buffer.from(content));
    }
  },
);

it("restores accepted publication paths as unstaged without running hooks or filters", async () => {
  const f = await fixture();
  const base = await captureWorkspaceManifest({ root: f.cwd, baseCommit: f.base });
  await f.write("ignored-[1].txt", "publishable\n");
  f.git("--literal-pathspecs", "add", "-f", "--", "ignored-[1].txt");
  await fs.rm(f.file("ignored-removed.txt"));
  if (process.platform !== "win32") {
    await fs.symlink("counter.txt", f.file("ignored-link.txt"));
    f.git("add", "-f", "ignored-link.txt");
  }
  const current = await captureWorkspaceManifest({ root: f.cwd, baseCommit: f.base });
  const digest = f.capture();
  const restored = path.join(f.root, "restored");
  f.git("clone", "--quiet", "--no-local", "--", f.cwd, restored);
  await applyNodeRepositoryCheckpoint({
    workspaceDir: restored,
    stagingRoot: f.cwd,
    baseManifestRef: base.manifestRef,
    currentManifestRef: current.manifestRef,
    base: base.manifest,
    current: current.manifest,
  });
  const git = (...args: string[]) =>
    runGit(restored, f.env, [
      "-C",
      restored,
      "-c",
      `core.hooksPath=${path.join(f.root, "unused-hooks")}`,
      "-c",
      "core.fsmonitor=false",
      ...args,
    ]);
  await fs.writeFile(path.join(restored, "ignored-removed.txt"), "recovery-only bytes\n");
  const hooks = path.join(restored, ".git", "test-hooks");
  const sentinel = path.join(f.root, "unexpected-hook-or-filter");
  await fs.mkdir(hooks);
  await fs.writeFile(
    path.join(hooks, "post-index-change"),
    `#!/bin/sh\nprintf hook > '${sentinel}'\n`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(restored, ".git", "info", "attributes"),
    "ignored*.txt filter=synthetic\n",
  );
  git("config", "core.hooksPath", hooks);
  git("config", "core.fsmonitor", `printf fsmonitor > '${sentinel}'`);
  git("config", "filter.synthetic.clean", `printf filter > '${sentinel}'`);
  expect(await fs.readFile(sentinel, "utf8").catch(() => undefined)).toBeUndefined();
  const batches = await prepareRepositoryPublicationRestore({
    current: current.manifest,
    publicationStagingRoot: f.output,
    publicationDigest: digest,
  });
  const restore = () => {
    for (const batch of batches) {
      execFileSync(
        process.execPath,
        [
          ...resolveRuntimeWorkerArgv(
            resolveRuntimeProcessEntrypointUrl("repositoryPublicationRestore"),
          ),
          batch.action,
        ],
        {
          cwd: restored,
          env: f.env,
          input: batch.input,
          stdio: "pipe",
        },
      );
    }
  };
  expect(restore).toThrow();
  expect(await fs.readFile(sentinel, "utf8").catch(() => undefined)).toBeUndefined();
  git("config", "--unset", "core.fsmonitor");
  expect(restore).toThrow();
  expect(await fs.readFile(sentinel, "utf8").catch(() => undefined)).toBeUndefined();
  git("config", "--unset", "filter.synthetic.clean");
  restore();
  expect(await fs.readFile(sentinel, "utf8").catch(() => undefined)).toBeUndefined();
  expect(git("--literal-pathspecs", "ls-files", "--", "ignored-[1].txt")).toBe("ignored-[1].txt");
  expect(git("diff", "--cached", "--name-only")).toBe("ignored-removed.txt");
  expect(git("ls-files", "--", "ignored-removed.txt")).toBe("");
  expect(await fs.readFile(path.join(restored, "ignored-removed.txt"), "utf8")).toBe(
    "recovery-only bytes\n",
  );
  expect(await fs.readFile(path.join(restored, "ignored-[1].txt"), "utf8")).toBe("publishable\n");
  if (process.platform !== "win32") {
    expect(await fs.readlink(path.join(restored, "ignored-link.txt"))).toBe("counter.txt");
    expect(git("ls-files", "--", "ignored-link.txt")).toBe("ignored-link.txt");
  }
});

it("rejects an unresolved index without changing conflict stages or working files", async () => {
  const f = await fixture();
  f.git("switch", "--quiet", "-c", "conflicting");
  await f.write("counter.txt", "one\n");
  f.git("commit", "--quiet", "-am", "one");
  f.git("switch", "--quiet", "--detach", f.base);
  await f.write("counter.txt", "two\n");
  f.git("commit", "--quiet", "-am", "two");
  expect(() => f.git("merge", "conflicting")).toThrow();
  const before = await state(f, ["counter.txt"]);
  expect(f.capture).toThrow();
  await expect(local(f)).rejects.toThrow();
  await expect(state(f, ["counter.txt"])).resolves.toEqual(before);
});

it.each(["--local", "--worktree"] as const)(
  "rejects a configured clean command in %s before the snapshot can run it",
  async (scope) => {
    const f = await fixture();
    await f.write(".gitattributes", "*.txt filter=synthetic\n");
    if (scope === "--worktree") {
      f.git("config", "extensions.worktreeConfig", "true");
    }
    f.git("config", scope, "filter.synthetic.clean", "touch ran-clean-filter");
    expect(f.capture).toThrow();
    await expect(fs.stat(f.file("ran-clean-filter"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("rejects substituted checkpoint bytes and paths outside the normalized payload", async () => {
  const f = await fixture();
  await f.write("counter.txt", "changed\n");
  const digest = f.capture();
  const { snapshot } = await f.metadata(digest);
  const entry = snapshot.entries[0]!;
  await fs.writeFile(path.join(f.output, "blobs", entry.sha!), "different\n");
  await expect(f.blob(entry.sha!)).rejects.toThrow("changed");
  const unsafe = JSON.stringify({ ...snapshot, entries: [{ ...entry, path: "../escape" }] });
  await fs.writeFile(path.join(f.output, "snapshot.json"), unsafe);
  await expect(f.metadata(digest)).rejects.toThrow("digest");
  await expect(
    readGitHubRepositoryPublicationMetadata(
      f.output,
      "sha256:" + createHash("sha256").update(unsafe).digest("hex"),
    ),
  ).rejects.toThrow("entry");
  if (process.platform !== "win32") {
    await fs.rm(path.join(f.output, "blobs", entry.sha!));
    await fs.symlink(f.file("counter.txt"), path.join(f.output, "blobs", entry.sha!));
    await expect(f.blob(entry.sha!)).rejects.toThrow();
  }
});
