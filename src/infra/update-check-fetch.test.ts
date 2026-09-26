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

it.each(["attached", "detached", "receipt"])(
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
      } else if (mode === "receipt") {
        await git(receiver, "branch", "-D", "main");
        await git(receiver, "update-ref", "refs/status/main", initial);
      }
      await commit(source, "new main commit");
      const upstreamSha = await git(source, "rev-parse", "HEAD");
      const result = await checkUpdateStatus({
        root: receiver,
        fetchGit: true,
        useDetachedDevUpstream: mode === "detached",
        ...(mode === "receipt"
          ? {
              gitUpstreamFallback: { currentSha: initial, upstreamRef: "refs/status/main" },
            }
          : {}),
        includeRegistry: false,
        timeoutMs: 5000,
      });
      expect(result.git).toMatchObject({
        upstream: mode === "receipt" ? "refs/status/main" : "status/main",
        upstreamSha,
        ahead: 0,
        behind: 1,
        fetchOk: true,
        upstreamSource: mode === "receipt" ? "receipt" : "tracking",
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

it.each(["local", "local-receipt", "missing"])(
  "does not fetch for a %s upstream",
  async (upstream) => {
    await withTestDir({ prefix: "openclaw-status-local-upstream-" }, async (root) => {
      await initialize(root);
      await commit(root, "initial");
      await git(root, "branch", "base");
      await commit(root, "local work");
      if (upstream === "local") {
        await git(root, "config", "branch.main.remote", ".");
        await git(root, "config", "branch.main.merge", "refs/heads/base");
      }
      const currentSha = await git(root, "rev-parse", "HEAD");
      if (upstream === "local-receipt") {
        await git(root, "checkout", "--detach");
      }
      const result = await checkUpdateStatus({
        root,
        fetchGit: true,
        includeRegistry: false,
        ...(upstream === "local-receipt"
          ? { gitUpstreamFallback: { currentSha, upstreamRef: "base" } }
          : {}),
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

it.each([
  "duplicate",
  "ambiguous",
  "ambiguous-missing",
  "conflicting-missing",
  "excluded",
  "excluded-alias",
  "excluded-alias-pattern",
  "excluded-local",
])("keeps receipt freshness honest for %s remote mappings", async (mapping) => {
  await withTestDir({ prefix: "openclaw-status-receipt-mapping-" }, async (base) => {
    const source = path.join(base, "source");
    const receiver = path.join(base, "receiver");
    await initialize(source);
    await commit(source, "initial");
    await git(base, "clone", pathToFileURL(source).href, receiver);
    const currentSha = await git(receiver, "rev-parse", "HEAD");
    await git(receiver, "checkout", "--detach");
    await git(receiver, "branch", "-D", "main");
    await git(receiver, "fetch", "origin", "refs/heads/main");
    const fetchHead = await fs.readFile(path.join(receiver, ".git", "FETCH_HEAD"), "utf8");
    const receiptRef = mapping === "excluded-local" ? "refs/heads/saved" : "origin/main";
    if (mapping === "excluded-local") {
      await git(receiver, "update-ref", receiptRef, currentSha);
      await git(receiver, "config", "remote.origin.fetch", "+refs/heads/main:refs/heads/saved");
      await git(receiver, "config", "--add", "remote.origin.fetch", "^refs/heads/main");
    } else if (mapping.startsWith("excluded-alias")) {
      await git(source, "branch", "other");
      await git(
        receiver,
        "config",
        "--add",
        "remote.origin.fetch",
        "+refs/heads/other:refs/remotes/origin/main",
      );
      await git(
        receiver,
        "config",
        "--add",
        "remote.origin.fetch",
        mapping === "excluded-alias-pattern" ? "^refs/heads/oth*" : "^refs/heads/other",
      );
    } else if (mapping.startsWith("ambiguous")) {
      await git(receiver, "remote", "add", "other", pathToFileURL(source).href);
      await git(
        receiver,
        "config",
        "remote.other.fetch",
        "+refs/heads/main:refs/remotes/origin/main",
      );
    } else {
      await git(
        receiver,
        "config",
        "--add",
        "remote.origin.fetch",
        mapping === "excluded"
          ? "^refs/heads/main"
          : mapping === "conflicting-missing"
            ? "+refs/heads/other:refs/remotes/origin/main"
            : "+refs/heads/main:refs/remotes/origin/main",
      );
    }
    if (mapping.endsWith("-missing")) {
      await git(receiver, "update-ref", "-d", "refs/remotes/origin/main");
    }
    await commit(source, "remote advances");
    const latest = await git(source, "rev-parse", "HEAD");
    const result = await checkUpdateStatus({
      root: receiver,
      fetchGit: true,
      includeRegistry: false,
      gitUpstreamFallback: { currentSha, upstreamRef: receiptRef },
      useDetachedDevUpstream: true,
    });
    const refreshes = mapping === "duplicate" || mapping.startsWith("excluded-alias");
    expect(result.git).toMatchObject(
      refreshes
        ? { upstreamSha: latest, ahead: 0, behind: 1, fetchOk: true }
        : {
            upstreamSha: null,
            ahead: null,
            behind: null,
            fetchOk: null,
          },
    );
    if (mapping.endsWith("-missing")) {
      expect(
        await git(receiver, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/main"),
      ).toBe("");
    } else {
      expect(await git(receiver, "rev-parse", receiptRef)).toBe(refreshes ? latest : currentSha);
    }
    if (!refreshes) {
      expect(await fs.readFile(path.join(receiver, ".git", "FETCH_HEAD"), "utf8")).toBe(fetchHead);
    }
  });
});

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

it.each([
  "receipt",
  "configured",
  "missing-ref",
  "missing-short",
  "missing-origin",
  "unresolvable",
])("preserves %s intent ahead of an unmaterialized origin main default", async (mode) => {
  await withTestDir({ prefix: "openclaw-receipt-priority-" }, async (base) => {
    const source = path.join(base, "source");
    const receiver = path.join(base, "receiver");
    await initialize(source);
    await git(source, "commit", "--allow-empty", "-m", "base");
    const currentSha = await git(source, "rev-parse", "HEAD");
    await git(source, "switch", "--create", "release");
    await git(source, "commit", "--allow-empty", "-m", "release advances");
    const releaseSha = await git(source, "rev-parse", "HEAD");
    await git(source, "switch", "main");
    await git(source, "commit", "--allow-empty", "-m", "main advances once");
    await git(source, "commit", "--allow-empty", "-m", "main advances twice");
    const mainSha = await git(source, "rev-parse", "HEAD");
    await initialize(receiver);
    const origin = pathToFileURL(source).href;
    await git(receiver, "remote", "add", "origin", origin);
    await git(
      receiver,
      "config",
      "--add",
      "remote.origin.fetch",
      "+refs/heads/release:refs/status/release",
    );
    await git(receiver, "fetch", "--depth=1", "--no-tags", "origin", currentSha);
    await git(receiver, "checkout", "--detach", currentSha);
    await git(receiver, "update-ref", "refs/status/release", currentSha);
    expect(
      await git(
        receiver,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/main",
        "refs/remotes/origin/main",
      ),
    ).toBe("");
    expect(await git(receiver, "config", "--get-regexp", "^branch\\.main\\.").catch(() => "")).toBe(
      "",
    );
    expect(await git(receiver, "remote", "get-url", "origin")).toBe(origin);
    if (mode === "configured") {
      await git(receiver, "config", "branch.main.remote", "origin");
      await git(receiver, "config", "branch.main.merge", "refs/heads/main");
    } else if (mode.startsWith("missing-") || mode === "unresolvable") {
      await git(receiver, "update-ref", "-d", "refs/status/release");
      if (mode === "unresolvable") {
        await git(receiver, "config", "--unset-all", "remote.origin.fetch");
      }
    }
    const receiptRef =
      mode === "missing-short"
        ? "status/release"
        : mode === "missing-origin"
          ? "origin/main"
          : "refs/status/release";
    const selectsMain = mode === "configured" || mode === "missing-origin";
    const result = await checkUpdateStatus({
      root: receiver,
      fetchGit: true,
      useDetachedDevUpstream: true,
      includeRegistry: false,
      timeoutMs: 5000,
      gitUpstreamFallback: { currentSha, upstreamRef: receiptRef },
    });
    expect(await git(receiver, "remote", "get-url", "origin")).toBe(origin);
    expect(result.git).toMatchObject({
      sha: currentSha,
      upstream: mode === "configured" ? "origin/main" : receiptRef,
      upstreamSource: mode === "configured" ? "tracking" : "receipt",
      upstreamSha: mode === "unresolvable" ? null : selectsMain ? mainSha : releaseSha,
      ahead: mode === "unresolvable" ? null : 0,
      behind: mode === "unresolvable" ? null : selectsMain ? 2 : 1,
      fetchOk: mode === "unresolvable" ? null : true,
    });
  });
});
