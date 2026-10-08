import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireGit } from "../agents/worktrees/git.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { gitNullConfigPath } from "./git-exec.js";
import { runGitReadOperation } from "./git-read-cache.js";

const directories = createTempDirTracker();
const ref = "refs/fixtures/read-file";
const first = '{"generation":1}\n';
const second = '{"generation":2}\n';
let root: string;
let firstCommit: string;
let secondCommit: string;
let firstBlob: string;

function git(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv) {
  return requireGit(cwd, args, {
    input,
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "openclaw-test@example.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "openclaw-test@example.invalid",
      ...env,
    },
  });
}

function read(filePath = "fixture.json", selectedRef = ref, repo = root) {
  return runGitReadOperation({
    type: "repository.ref-file",
    input: { root: repo, ref: selectedRef, path: filePath },
  });
}

beforeAll(async () => {
  root = directories.make("openclaw-ref-file-");
  await git(root, ["init", "--template=", "-b", "main"]);
  firstBlob = await git(root, ["hash-object", "-w", "--stdin"], first);
  const secondBlob = await git(root, ["hash-object", "-w", "--stdin"], second);
  const boundary = await git(root, ["hash-object", "-w", "--stdin"], "a".repeat(64 * 1024));
  const oversized = await git(root, ["hash-object", "-w", "--stdin"], "a".repeat(64 * 1024 + 1));
  const emptyTree = await git(root, ["mktree"], "");
  const tree = await git(
    root,
    ["mktree"],
    `100644 blob ${firstBlob}\tfixture.json\n100644 blob ${boundary}\tboundary.txt\n100644 blob ${oversized}\toversized.txt\n040000 tree ${emptyTree}\tdirectory\n`,
  );
  const nextTree = await git(root, ["mktree"], `100644 blob ${secondBlob}\tfixture.json\n`);
  firstCommit = await git(root, ["-c", "commit.gpgSign=false", "commit-tree", tree, "-m", "first"]);
  secondCommit = await git(root, [
    "-c",
    "commit.gpgSign=false",
    "commit-tree",
    nextTree,
    "-m",
    "second",
  ]);
  await git(root, ["update-ref", "refs/heads/main", firstCommit]);
  await git(root, ["update-ref", ref, firstCommit]);
  await git(root, ["symbolic-ref", "refs/fixtures/symbolic", ref]);
  await fs.writeFile(path.join(root, "fixture.json"), "uncommitted contents\n");
});

afterAll(async () => {
  await drainGlobalSingletonLifecycleState();
  directories.cleanup();
});

it("reads committed bytes and observes independent ref updates without touching the checkout", async () => {
  expect(await read()).toBe(first);
  await git(root, ["update-ref", ref, secondCommit]);
  expect(await read()).toBe(second);
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(firstCommit);
  expect(await fs.readFile(path.join(root, "fixture.json"), "utf8")).toBe("uncommitted contents\n");
  await git(root, ["update-ref", ref, firstCommit]);
  await git(root, ["replace", firstCommit, secondCommit]);
  try {
    expect(await git(root, ["show", `${ref}:fixture.json`])).toBe(second.trim());
    expect(await read()).toBe(first);
  } finally {
    await git(root, ["replace", "-d", firstCommit]);
  }
});

it("rejects symbolic refs, revision expressions, nonliteral paths and non-bounded blobs", async () => {
  expect(await read("boundary.txt")).toBe("a".repeat(64 * 1024));
  for (const [selectedRef, file] of [
    ["refs/fixtures/symbolic", "fixture.json"],
    ["refs/fixtures/missing", "fixture.json"],
    ["refs/fixtures", "fixture.json"],
    ["HEAD", "fixture.json"],
    [`${ref}~0`, "fixture.json"],
    [`${ref}:fixture.json`, "fixture.json"],
    [ref, "../fixture.json"],
    [ref, "/fixture.json"],
    [ref, "fixture.json\nHEAD:fixture.json"],
    [ref, "directory"],
    [ref, "missing.json"],
    [ref, "oversized.txt"],
  ]) {
    expect(await read(file, selectedRef), `${selectedRef}:${file}`).toBeNull();
  }
});

it("leaves missing promisor blobs unfetched even when the remote can supply them", async () => {
  await git(root, ["config", "uploadpack.allowFilter", "true"]);
  const clone = path.join(directories.make("openclaw-ref-file-partial-"), "clone");
  await git(root, [
    "clone",
    "--no-checkout",
    "--filter=blob:none",
    pathToFileURL(root).href,
    clone,
  ]);
  expect(
    await git(clone, ["cat-file", "--batch-check"], `${firstBlob}\n`, {
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
    }),
  ).toBe(`${firstBlob} missing`);
  expect(await read("fixture.json", "refs/heads/main", clone)).toBeNull();
  // A reachable source is the negative control: an explicit unrestricted read can fetch it.
  expect(
    await git(clone, ["cat-file", "blob", firstBlob], undefined, {
      GIT_NO_LAZY_FETCH: "0",
      GIT_ALLOW_PROTOCOL: "file",
    }),
  ).toBe(first.trim());
  expect(await read("fixture.json", "refs/heads/main", clone)).toBe(first);
});
