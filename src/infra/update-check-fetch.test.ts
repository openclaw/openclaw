import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { resolveUpdateAvailability } from "../commands/status.update.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { checkUpdateStatus } from "./update-check.js";
import { withUpdateInstallStatus } from "./update-install-status.js";

async function git(root: string, ...args: string[]) {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], { timeoutMs: 5000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function initialize(root: string) {
  await fs.mkdir(root, { recursive: true });
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "OpenClaw Test");
  await git(root, "config", "user.email", "test@openclaw.invalid");
}

const commit = (root: string, message: string) =>
  git(root, "commit", "--allow-empty", "-am", message);

async function objectStorageKiB(root: string) {
  const counts = await git(root, "count-objects", "-v");
  return [...counts.matchAll(/^size(?:-pack)?: (\d+)$/gm)].reduce(
    (total, match) => total + Number(match[1]),
    0,
  );
}

it("refreshes a shallow detached Dev checkout without importing unrelated objects or tags", async () => {
  await withTestDir({ prefix: "openclaw-status-fetch-scope-" }, async (base) => {
    const source = path.join(base, "source");
    const receiver = path.join(base, "receiver");
    await initialize(source);
    await commit(source, "initial");
    const initial = await git(source, "rev-parse", "HEAD");
    await git(source, "switch", "--create", "unrelated");
    await fs.writeFile(path.join(source, "unrelated.bin"), randomBytes(256 * 1024));
    await git(source, "add", "unrelated.bin");
    await commit(source, "unrelated payload");
    const unrelatedBlob = await git(source, "rev-parse", "HEAD:unrelated.bin");
    await git(source, "tag", "unrelated-tag");
    await git(source, "switch", "main");
    await commit(source, "new main commit");
    const upstreamSha = await git(source, "rev-parse", "HEAD");

    await initialize(receiver);
    await git(receiver, "remote", "add", "origin", pathToFileURL(source).href);
    await git(receiver, "fetch", "--depth=1", "origin", initial);
    await git(receiver, "checkout", "--detach", initial);
    const shallowBefore = await fs.readFile(path.join(receiver, ".git", "shallow"), "utf8");
    // Operator fetch preferences must not widen a status check's selected upstream.
    await git(receiver, "config", "fetch.prune", "true");
    await git(receiver, "config", "fetch.pruneTags", "true");
    await git(receiver, "config", "remote.origin.tagOpt", "--tags");
    await git(receiver, "tag", "operator-tag");
    await git(receiver, "update-ref", "refs/remotes/origin/retained", initial);
    const beforeKiB = await objectStorageKiB(receiver);
    const configBefore = await fs.readFile(path.join(receiver, ".git", "config"), "utf8");

    const result = await checkUpdateStatus({
      root: receiver,
      fetchGit: true,
      useDetachedDevUpstream: true,
      includeRegistry: false,
      timeoutMs: 5000,
    });
    const unrelated = await runCommandWithTimeout(
      ["git", "-C", receiver, "cat-file", "-e", unrelatedBlob],
      { timeoutMs: 5000 },
    );
    expect.soft(result.git).toMatchObject({
      sha: initial,
      upstream: "origin/main",
      upstreamSha,
      ahead: 0,
      behind: 1,
      fetchOk: true,
    });
    expect
      .soft(resolveUpdateAvailability(result))
      .toMatchObject({ hasGitUpdate: true, gitBehind: 1 });
    expect
      .soft(await git(receiver, "for-each-ref", "--format=%(refname)", "refs/remotes", "refs/tags"))
      .toBe("refs/remotes/origin/main\nrefs/remotes/origin/retained\nrefs/tags/operator-tag");
    expect.soft(unrelated.code).not.toBe(0);
    expect.soft(await objectStorageKiB(receiver)).toBeLessThan(beforeKiB + 32);
    expect(await fs.readFile(path.join(receiver, ".git", "shallow"), "utf8")).toBe(shallowBefore);
    expect(await fs.readFile(path.join(receiver, ".git", "config"), "utf8")).toBe(configBefore);
  });
});

it.each(["attached", "detached", "detached-no-branch"])(
  "refreshes only the custom destination for a %s upstream",
  async (mode) => {
    await withTestDir({ prefix: "openclaw-status-custom-upstream-" }, async (base) => {
      const source = path.join(base, "source");
      const receiver = path.join(base, "receiver");
      await initialize(source);
      await commit(source, "initial");
      const initial = await git(source, "rev-parse", "HEAD");
      await git(source, "branch", "unrelated");
      await initialize(receiver);
      await git(receiver, "remote", "add", "foo/bar", pathToFileURL(source).href);
      await git(receiver, "config", "remote.foo/bar.fetch", "+refs/heads/*:refs/status/*");
      await git(receiver, "fetch", "--depth=1", "foo/bar", initial);
      await git(receiver, "checkout", "--detach", initial);
      await git(receiver, "branch", "main", initial);
      await git(receiver, "config", "branch.main.remote", "foo/bar");
      await git(receiver, "config", "branch.main.merge", "refs/heads/main");
      if (mode === "attached") {
        await git(receiver, "checkout", "main");
        await git(receiver, "branch", "-m", "main", "topic=main");
      } else if (mode === "detached-no-branch") {
        await git(receiver, "update-ref", "-d", "refs/heads/main");
      }
      await commit(source, "new main commit");
      const upstreamSha = await git(source, "rev-parse", "HEAD");
      const result = await checkUpdateStatus({
        root: receiver,
        fetchGit: true,
        useDetachedDevUpstream: mode !== "attached",
        includeRegistry: false,
        timeoutMs: 5000,
      });
      expect(result.git).toMatchObject({
        upstream: "status/main",
        upstreamSha,
        ahead: 0,
        behind: 1,
        fetchOk: true,
      });
      expect(
        await git(receiver, "for-each-ref", "--format=%(refname)", "refs/status", "refs/remotes"),
      ).toBe("refs/status/main");
    });
  },
);

it("honors a non-force fetch mapping into a local branch", async () => {
  await withTestDir({ prefix: "openclaw-status-nonforce-upstream-" }, async (base) => {
    const source = path.join(base, "source");
    const receiver = path.join(base, "receiver");
    await initialize(source);
    await commit(source, "initial");
    await git(base, "clone", pathToFileURL(source).href, receiver);
    await git(receiver, "config", "user.name", "OpenClaw Test");
    await git(receiver, "config", "user.email", "test@openclaw.invalid");
    await git(receiver, "switch", "--create", "protected");
    await commit(receiver, "local protected work");
    const protectedSha = await git(receiver, "rev-parse", "HEAD");
    await git(receiver, "switch", "main");
    await git(receiver, "config", "remote.origin.fetch", "refs/heads/main:refs/heads/protected");
    await commit(source, "divergent remote work");
    const result = await checkUpdateStatus({
      root: receiver,
      fetchGit: true,
      includeRegistry: false,
    });
    expect(result.git).toMatchObject({
      fetchOk: false,
      upstreamSha: null,
      ahead: null,
      behind: null,
    });
    expect(await git(receiver, "rev-parse", "protected")).toBe(protectedSha);
  });
});

it.each(["local", "local-detached", "missing"])(
  "does not fetch for a %s upstream",
  async (upstream) => {
    await withTestDir({ prefix: "openclaw-status-local-upstream-" }, async (root) => {
      await initialize(root);
      await commit(root, "initial");
      await git(root, "branch", "base");
      await commit(root, "local work");
      if (upstream !== "missing") {
        await git(root, "config", "branch.main.remote", ".");
        await git(root, "config", "branch.main.merge", "refs/heads/base");
      }
      if (upstream === "local-detached") {
        await git(root, "checkout", "--detach");
      }
      const result = await checkUpdateStatus({
        root,
        fetchGit: true,
        includeRegistry: false,
        useDetachedDevUpstream: true,
      });
      expect(result.git).toMatchObject(
        upstream !== "missing"
          ? { upstream: "base", ahead: 1, behind: 0, fetchOk: true }
          : { upstream: null, ahead: null, behind: null, fetchOk: null },
      );
      await expect(fs.stat(path.join(root, ".git", "FETCH_HEAD"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        withUpdateInstallStatus({ channel: "dev", autoEnabled: false }, result, true, null, root)
          .install?.git,
      ).toMatchObject(
        upstream !== "missing"
          ? { status: "ahead", commitsAhead: 1 }
          : { status: "unavailable", reason: "no-upstream" },
      );
    });
  },
);

it.each(["refs/remotes/origin/main", "refs/heads/saved"])(
  "does not report excluded remote data as fresh (%s)",
  async (destination) => {
    await withTestDir({ prefix: "openclaw-status-excluded-source-" }, async (base) => {
      const source = path.join(base, "source");
      const receiver = path.join(base, "receiver");
      await initialize(source);
      await commit(source, "initial");
      await git(base, "clone", pathToFileURL(source).href, receiver);
      const sha = await git(receiver, "rev-parse", "HEAD");
      await git(receiver, "checkout", "--detach");
      await git(receiver, "update-ref", destination, sha);
      await git(receiver, "config", "remote.origin.fetch", "+refs/heads/main:" + destination);
      await git(receiver, "config", "--add", "remote.origin.fetch", "^refs/heads/main");
      await commit(source, "remote advances");
      const result = await checkUpdateStatus({
        root: receiver,
        fetchGit: true,
        useDetachedDevUpstream: true,
        includeRegistry: false,
      });
      expect(result.git).toMatchObject({
        upstreamSha: null,
        ahead: null,
        behind: null,
        fetchOk: false,
      });
      expect(await git(receiver, "rev-parse", destination)).toBe(sha);
    });
  },
);

it("keeps disconnected shallow comparisons unknown after a scoped refresh", async () => {
  await withTestDir({ prefix: "openclaw-status-disconnected-shallow-" }, async (base) => {
    const source = path.join(base, "source");
    const receiver = path.join(base, "receiver");
    await initialize(source);
    await commit(source, "common ancestor");
    await git(source, "switch", "--create", "feature");
    await commit(source, "feature work");
    const feature = await git(source, "rev-parse", "HEAD");
    await git(source, "switch", "main");
    await commit(source, "main work");
    await commit(source, "moving main");
    const main = await git(source, "rev-parse", "HEAD");
    await initialize(receiver);
    await git(receiver, "remote", "add", "origin", pathToFileURL(source).href);
    await git(receiver, "fetch", "--depth=1", "origin", feature);
    await git(receiver, "checkout", "--detach", feature);
    const shallow = await fs.readFile(path.join(receiver, ".git", "shallow"), "utf8");
    const result = await checkUpdateStatus({
      root: receiver,
      fetchGit: true,
      useDetachedDevUpstream: true,
      includeRegistry: false,
    });
    expect(result.git).toMatchObject({
      upstreamSha: main,
      fetchOk: true,
      ahead: null,
      behind: null,
    });
    expect(resolveUpdateAvailability(result)).toMatchObject({
      hasGitUpdate: false,
      gitBehind: null,
    });
    expect(await fs.readFile(path.join(receiver, ".git", "shallow"), "utf8")).toBe(shallow);
    expect(await git(receiver, "for-each-ref", "--format=%(refname)", "refs/remotes")).toBe(
      "refs/remotes/origin/main",
    );
  });
});

it("preserves configured custom tracking ahead of the Dev origin default", async () => {
  await withTestDir({ prefix: "openclaw-tracking-priority-" }, async (base) => {
    const source = path.join(base, "source");
    const receiver = path.join(base, "receiver");
    await initialize(source);
    await commit(source, "base");
    const currentSha = await git(source, "rev-parse", "HEAD");
    await git(source, "switch", "--create", "release");
    await commit(source, "release advances");
    const releaseSha = await git(source, "rev-parse", "HEAD");
    await git(source, "switch", "main");
    await commit(source, "main advances");
    await initialize(receiver);
    await git(receiver, "remote", "add", "origin", pathToFileURL(source).href);
    await git(receiver, "config", "remote.origin.fetch", "+refs/heads/release:refs/status/release");
    await git(receiver, "fetch", "--depth=1", "--no-tags", "origin", currentSha);
    await git(receiver, "checkout", "--detach", currentSha);
    await git(receiver, "config", "branch.main.remote", "origin");
    await git(receiver, "config", "branch.main.merge", "refs/heads/release");
    const result = await checkUpdateStatus({
      root: receiver,
      fetchGit: true,
      useDetachedDevUpstream: true,
      includeRegistry: false,
      timeoutMs: 5000,
    });
    expect(result.git).toMatchObject({
      sha: currentSha,
      upstream: "status/release",
      upstreamSha: releaseSha,
      ahead: 0,
      behind: 1,
      fetchOk: true,
    });
  });
});

it.each([
  "full",
  "missing-full",
  "missing-short",
  "local",
  "excluded",
  "ambiguous",
  "configured",
  "tag-priority",
  "tail-nonmatch",
  "abbreviated-excluded",
  "object-source",
  "wrong-object-format",
  "at-source",
])("resolves optional source hints through live Git mappings (%s)", async (mode) => {
  await withTestDir({ prefix: "openclaw-source-hint-mapping-" }, async (base) => {
    const source = path.join(base, "source");
    const root = path.join(base, "install");
    await initialize(source);
    await commit(source, "installed");
    const sha = await git(source, "rev-parse", "HEAD");
    await git(base, "clone", "--quiet", source, root);
    await git(root, "checkout", "--detach", sha);
    await git(root, "branch", "-D", "main");
    await git(root, "remote", "add", "team/fork", source);
    const sourceRef =
      mode === "wrong-object-format"
        ? sha + "a".repeat(24)
        : mode === "object-source"
          ? sha
          : mode === "at-source"
            ? "@"
            : mode === "tail-nonmatch"
              ? "missing"
              : ["tag-priority", "abbreviated-excluded"].includes(mode)
                ? "main"
                : "refs/heads/main";
    await git(root, "config", "remote.team/fork.fetch", "+" + sourceRef + ":refs/status/main");
    if (!mode.startsWith("missing")) {
      await git(root, "update-ref", "refs/status/main", sha);
    }
    if (mode === "local") {
      await git(root, "branch", "saved", sha);
    } else if (mode === "excluded" || mode === "abbreviated-excluded") {
      await git(root, "config", "--add", "remote.team/fork.fetch", "^refs/heads/main");
    } else if (mode === "ambiguous") {
      await git(root, "remote", "add", "other", source);
      await git(root, "config", "remote.other.fetch", "+refs/heads/main:refs/status/main");
    } else if (mode === "configured") {
      await git(root, "config", "branch.main.remote", "origin");
      await git(root, "config", "branch.main.merge", "refs/heads/main");
    }
    if (mode === "tag-priority") {
      await git(source, "tag", "main", sha);
    } else if (mode === "tail-nonmatch") {
      await git(source, "branch", "other/missing", sha);
    }
    await commit(source, "available");
    const target = await git(source, "rev-parse", "HEAD");
    const upstreamRef =
      mode === "local" ? "saved" : mode === "missing-short" ? "status/main" : "refs/status/main";
    const configBefore = await fs.readFile(path.join(root, ".git", "config"));
    const result = await checkUpdateStatus({
      root,
      fetchGit: true,
      useDetachedDevUpstream: true,
      includeRegistry: false,
      gitSourceHint: { root, sha, upstreamRef },
    });
    const usesHint = ![
      "excluded",
      "ambiguous",
      "configured",
      "abbreviated-excluded",
      "tail-nonmatch",
      "wrong-object-format",
    ].includes(mode);
    const selectsCurrent = ["local", "tag-priority", "object-source"].includes(mode);
    expect(result.git).toMatchObject({
      upstream: usesHint ? upstreamRef : "origin/main",
      upstreamSource: usesHint ? "receipt" : "tracking",
      upstreamSha: selectsCurrent ? sha : target,
      fetchOk: true,
      ahead: 0,
      behind: selectsCurrent ? 0 : 1,
    });
    expect(await fs.readFile(path.join(root, ".git", "config"))).toEqual(configBefore);
    expect(await git(root, "rev-parse", "HEAD")).toBe(sha);
  });
});

it("rejects an ambiguous hexadecimal receipt prefix without interpreting it as a ref", async () => {
  await withTestDir({ prefix: "openclaw-source-hint-ambiguous-sha-" }, async (root) => {
    await git(root, "init", "--initial-branch=main", "--object-format=sha1");
    const writeObject = async (type: "tree" | "commit", input: string) => {
      const result = await runCommandWithTimeout(
        ["git", "-C", root, "hash-object", "-t", type, "-w", "--stdin"],
        { timeoutMs: 5000, input },
      );
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const tree = await writeObject("tree", "");
    // These two synthetic commits share seven hex digits. No collision search runs in CI.
    const commitWithNonce = (nonce: number) =>
      writeObject(
        "commit",
        "tree " +
          tree +
          "\nauthor Test <test@openclaw.invalid> 1 +0000\n" +
          "committer Test <test@openclaw.invalid> 1 +0000\n\nambiguity fixture " +
          nonce +
          "\n",
      );
    const sha = await commitWithNonce(2465);
    expect(sha).toBe("4c236745f0e4c2f009c8042ce7e712df871bd0de");
    await git(root, "update-ref", "refs/heads/main", sha);
    await git(root, "checkout", "--detach", sha);
    await git(root, "remote", "add", "origin", root);
    await git(root, "remote", "add", "upstream", root);
    const receiptSha = sha.slice(0, 7);
    const inspect = () =>
      checkUpdateStatus({
        root,
        fetchGit: true,
        useDetachedDevUpstream: true,
        includeRegistry: false,
        gitSourceHint: { root, sha: receiptSha, upstreamRef: "upstream/main" },
      });
    expect((await inspect()).git).toMatchObject({
      upstream: "upstream/main",
      upstreamSource: "receipt",
    });
    const collision = await commitWithNonce(11791);
    expect(collision).toBe("4c236746ae2c51a39c70d768fe4fe99c426fc830");
    expect(
      (await git(root, "rev-parse", "--disambiguate=" + receiptSha)).split("\n").toSorted(),
    ).toEqual([sha, collision]);
    expect((await inspect()).git).toMatchObject({
      upstream: "origin/main",
      upstreamSource: "tracking",
    });
  });
});
