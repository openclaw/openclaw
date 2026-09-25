import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  BRANCH,
  SESSION_KEY,
  commandResult,
  createRealPublicationWorkspace,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
} from "./github-publication.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();
const url = "https://github.com/openclaw/openclaw/pull/125200";

async function historyFixture() {
  const workspace = await createRealPublicationWorkspace();
  const remote = path.join(root, "remote.git");
  await workspace.git("init", "--bare", remote);
  const fallback = mocks.runCommand.getMockImplementation()!;
  const calls: string[][] = [];
  let pr:
    | {
        url: string;
        userId: number;
        state: string;
        body: string;
        headSha: string;
        headRef: string;
        baseRef: string;
      }
    | undefined;
  const remoteHead = async () =>
    (await workspace.git("ls-remote", "--refs", remote, `refs/heads/${BRANCH}`)).split(/\s+/u)[0] ??
    "";
  mocks.runCommand.mockImplementation(
    async (argv: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) => {
      calls.push(argv);
      if (argv.includes("ls-remote")) {
        return commandResult(
          await workspace.git("ls-remote", "--refs", remote, `refs/heads/${BRANCH}`),
        );
      }
      if (argv.includes("fetch")) {
        // Base objects already exist locally; branch objects come from the real remote.
        const sha = argv.at(-1)!;
        if (sha === (await remoteHead())) {
          return commandResult(
            await workspace.git("fetch", "--no-tags", "--no-write-fetch-head", remote, sha),
          );
        }
        return commandResult();
      }
      if (argv.includes("push")) {
        try {
          const remoteIndex = argv.indexOf("--") + 1;
          const output = await workspace.git(
            ...argv.slice(1).map((arg, index) => (index + 1 === remoteIndex ? remote : arg)),
          );
          if (pr) {
            pr.headSha = await remoteHead();
          }
          return commandResult(output);
        } catch {
          return commandResult("", 1);
        }
      }
      if (argv.includes("state=all")) {
        return commandResult(JSON.stringify(pr ? [pr] : []));
      }
      if (argv.includes("POST")) {
        const body = JSON.parse(options!.input!);
        pr = {
          url,
          userId: 42,
          state: "open",
          body: body.body,
          headSha: await remoteHead(),
          headRef: BRANCH,
          baseRef: "main",
        };
        return commandResult(JSON.stringify({ html_url: url }));
      }
      return await fallback(argv, options);
    },
  );
  const coordinator = createTestGitHubPublicationCoordinator({
    placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
  });
  const publish = (idempotencyKey: string) =>
    coordinator.requestForSession({ agentId: "main", sessionKey: SESSION_KEY, idempotencyKey });
  const state = async () => ({
    head: await workspace.git("rev-parse", "HEAD"),
    index: await fs.readFile(path.join(workspace.cwd, ".git", "index")),
    file: await fs.readFile(path.join(workspace.cwd, "artifact.txt"), "utf8"),
    remote: await remoteHead(),
  });
  const publishMessage = async (message: string) => {
    const parent = await workspace.git("rev-parse", "HEAD");
    const tree = await workspace.git("rev-parse", "HEAD^{tree}");
    const head = await workspace.git("commit-tree", tree, "-p", parent, "-m", message);
    await workspace.git("update-ref", `refs/heads/${BRANCH}`, head, parent);
    await workspace.git("push", remote, `${head}:refs/heads/${BRANCH}`);
    pr!.headSha = head;
    return head;
  };
  return { ...workspace, calls, publish, state, remote, remoteHead, publishMessage };
}

describe("GitHub publication branch history", () => {
  installGitHubPublicationTestHarness();

  it("publishes initial work and fast-forward edits, then reuses an attributed published head across requests", async () => {
    const f = await historyFixture();
    const first = await f.publish("initial");
    expect(first).toMatchObject({ status: "published", url });
    const firstHead = await f.remoteHead();
    expect(await f.publish("initial")).toEqual(first);
    await fs.writeFile(path.join(f.cwd, "artifact.txt"), "next accepted edit\n");
    expect(await f.publish("fast-forward")).toMatchObject({ status: "published", url });
    const secondHead = await f.remoteHead();
    expect(secondHead).not.toBe(firstHead);
    expect(await f.git("rev-parse", "HEAD^")).toBe(firstHead);
    expect(await f.git("show", "-s", "--format=%B", "HEAD")).toContain(
      "Co-authored-by: alice <7+alice@users.noreply.github.com>",
    );
    const before = await f.state();
    f.calls.length = 0;
    expect(await f.publish("separate-same-content")).toMatchObject({
      status: "published",
      url,
      headCommit: secondHead,
    });
    expect(await f.state()).toEqual(before);
    expect(
      f.calls.some(
        (args) => args.includes("commit-tree") || args.includes("push") || args.includes("POST"),
      ),
    ).toBe(false);
  });

  it("repairs unrecognized published credit without rewriting history or importing body examples", async () => {
    const f = await historyFixture();
    expect(await f.publish("initial")).toMatchObject({ status: "published", url });
    const human = "Co-authored-by: alice <7+alice@users.noreply.github.com>";
    const other = "Co-authored-by: example <99+example@users.noreply.github.com>";
    const marker = "OpenClaw-Publication: previous-writer";
    const layouts = [
      `${human}\n\nWorked on by:\n- @alice\n\n${marker}`,
      `${human}\n\n${other}\n${marker}`,
      `${human}\n\n${marker}`,
      ["Example:", "```text", human, other, "```", "", marker].join("\n"),
    ];
    const parsed = async () => {
      const file = path.join(root, "commit-message.txt");
      await fs.writeFile(file, await f.git("show", "-s", "--format=%B", "HEAD"));
      return await f.git("interpret-trailers", "--no-divider", "--parse", file);
    };
    for (const [index, layout] of layouts.entries()) {
      // Represent an already-published implementation commit from an older writer.
      const message = `Implementation credit\n\n${layout}`;
      const previous = await f.publishMessage(message);
      expect(await parsed()).not.toContain(human);
      const tree = await f.git("rev-parse", "HEAD^{tree}");
      f.calls.length = 0;
      const repaired = await f.publish(`repair-${index}`);
      expect(repaired).toMatchObject({ status: "published", url });
      expect(await parsed()).toBe(`${human}\nOpenClaw-Publication: ${repaired.requestId}`);
      expect(await f.git("rev-parse", "HEAD^")).toBe(previous);
      expect(await f.git("rev-parse", "HEAD^{tree}")).toBe(tree);
      expect(await f.git("show", "-s", "--format=%B", previous)).toBe(message);
      expect(f.calls.filter((args) => args.includes("commit-tree"))).toHaveLength(1);
      expect(f.calls.some((args) => args.includes("POST"))).toBe(false);
      const before = await f.state();
      f.calls.length = 0;
      expect(await f.publish(`repair-${index}`)).toEqual(repaired);
      expect(await f.publish(`reuse-${index}`)).toMatchObject({
        status: "published",
        headCommit: before.head,
      });
      expect(await f.state()).toEqual(before);
      expect(f.calls.some((args) => args.includes("commit-tree") || args.includes("push"))).toBe(
        false,
      );
    }
    // Commit-format trailer parsing must not treat a Markdown separator as a patch divider.
    const valid = await f.publishMessage(`Implementation credit\n\n---\n\n${human}\n${marker}`);
    expect(await parsed()).toBe(`${human}\n${marker}`);
    const before = await f.state();
    f.calls.length = 0;
    expect(await f.publish("markdown-separator")).toMatchObject({
      status: "published",
      headCommit: valid,
    });
    expect(await f.state()).toEqual(before);
    expect(f.calls.some((args) => args.includes("commit-tree") || args.includes("push"))).toBe(
      false,
    );
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args: string[], options) =>
      args.some((arg) => arg.startsWith("--format=%(trailers:"))
        ? commandResult("", 128)
        : await fallback(args, options),
    );
    f.calls.length = 0;
    expect(await f.publish("unavailable-trailer-read")).toMatchObject({
      status: "failed",
      code: "unavailable",
    });
    expect(await f.state()).toEqual(before);
    expect(f.calls.some((args) => args.includes("commit-tree") || args.includes("push"))).toBe(
      false,
    );
  });

  it("adds missing contributor credit instead of silently reusing an older attributed head", async () => {
    const f = await historyFixture();
    expect(await f.publish("initial")).toMatchObject({ status: "published" });
    const previousHead = await f.remoteHead();
    const tree = await f.git("rev-parse", "HEAD^{tree}");
    const trailer = "Co-authored-by: bob <8+bob@users.noreply.github.com>";
    mocks.attribution.mockReturnValue({ trailers: [trailer], logins: ["bob"], prompt: "" });
    expect(await f.publish("new-credit")).toMatchObject({ status: "published", url });
    expect(await f.git("rev-parse", "HEAD^")).toBe(previousHead);
    expect(await f.git("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(await f.git("show", "-s", "--format=%B", "HEAD")).toContain(trailer);
    const head = await f.remoteHead();
    expect(await f.publish("same-credit")).toMatchObject({ status: "published", headCommit: head });

    // Opt-out, bot-only, and no-human sessions all resolve to no current attribution.
    // Existing public history stays intact; future generated commits must not copy it.
    mocks.attribution.mockReturnValue(undefined);
    expect(await f.publish("no-current-human")).toMatchObject({
      status: "published",
      headCommit: head,
    });
    await fs.writeFile(path.join(f.cwd, "artifact.txt"), "work without current human credit\n");
    expect(await f.publish("new-work-no-human")).toMatchObject({ status: "published", url });
    expect(await f.git("show", "-s", "--format=%(trailers:key=Co-authored-by,only)", "HEAD")).toBe(
      "",
    );
    const uncredited = await f.remoteHead();
    expect(await f.publish("reuse-no-human")).toMatchObject({
      status: "published",
      headCommit: uncredited,
    });
  });

  it.each([
    { publication: "initial", reflog: "recreated" },
    { publication: "initial", reflog: "expired" },
    { publication: "refresh", reflog: "recreated" },
    { publication: "refresh", reflog: "expired" },
  ])(
    "publishes $publication work after its branch reflog is $reflog",
    async ({ publication, reflog }) => {
      const f = await historyFixture();
      if (publication === "refresh") {
        expect(await f.publish("initial")).toMatchObject({ status: "published", url });
      }
      const previousRemote = await f.remoteHead();
      await fs.writeFile(path.join(f.cwd, "artifact.txt"), "committed topic edit\n");
      await f.git("add", "artifact.txt");
      await f.git("commit", "-m", "topic edit");
      const sourceHead = await f.git("rev-parse", "HEAD");
      const sourceTree = await f.git("rev-parse", "HEAD^{tree}");
      if (reflog === "recreated") {
        await f.git("branch", "-m", "saved-topic");
        await f.git("switch", "-c", BRANCH, sourceHead);
      } else {
        await f.git("reflog", "expire", "--expire=now", `refs/heads/${BRANCH}`);
      }
      f.calls.length = 0;

      expect(await f.publish("after-reflog-change")).toMatchObject({ status: "published", url });

      expect(await f.git("rev-parse", "HEAD^")).toBe(sourceHead);
      expect(await f.git("rev-parse", "HEAD^{tree}")).toBe(sourceTree);
      expect(await f.remoteHead()).toBe(await f.git("rev-parse", "HEAD"));
      if (previousRemote) {
        await f.git("merge-base", "--is-ancestor", previousRemote, "HEAD");
      }
      expect(f.calls.filter((args) => args.includes("POST"))).toHaveLength(
        publication === "initial" ? 1 : 0,
      );
    },
  );

  it("rejects unrelated initial history without changing the workspace or remote", async () => {
    const f = await historyFixture();
    const tree = await f.git("rev-parse", "HEAD^{tree}");
    const unrelated = await f.git("commit-tree", tree, "-m", "unrelated root");
    await f.git("update-ref", `refs/heads/${BRANCH}`, unrelated);
    const before = await f.state();
    f.calls.length = 0;

    expect(await f.publish("unrelated-base")).toMatchObject({
      status: "failed",
      code: "workspace_changed",
      nextAction: expect.stringContaining("no shared Git history"),
    });

    expect(await f.state()).toEqual(before);
    expect(
      f.calls.some(
        (args) =>
          args.includes("commit-tree") ||
          args.includes("update-ref") ||
          args.includes("push") ||
          args.includes("POST"),
      ),
    ).toBe(false);
  });

  it.each(["rebased", "remote-ahead", "unrelated"] as const)(
    "rejects %s history before changing HEAD, index, files, or remote",
    async (history) => {
      const f = await historyFixture();
      // Already-committed source plus an intentional first-publication marker.
      await f.git("add", "artifact.txt");
      await f.git("commit", "-m", "source change");
      expect(await f.publish("initial")).toMatchObject({ status: "published" });
      const published = await f.remoteHead();
      if (history === "rebased") {
        await f.git("checkout", "main");
        await fs.writeFile(path.join(f.cwd, "upstream.txt"), "upstream\n");
        await f.git("add", "upstream.txt");
        await f.git("commit", "-m", "upstream advance");
        await f.git("checkout", BRANCH);
        await f.git("rebase", "main");
      } else {
        const tree = await f.git("rev-parse", "HEAD^{tree}");
        const remoteCommit = await f.git(
          "commit-tree",
          tree,
          ...(history === "remote-ahead" ? ["-p", published] : []),
          "-m",
          "remote change",
        );
        await f.git("push", f.remote, `${remoteCommit}:refs/heads/foreign`);
        await f.git("-C", f.remote, "update-ref", `refs/heads/${BRANCH}`, remoteCommit);
      }
      await fs.writeFile(path.join(f.cwd, "artifact.txt"), "staged after divergence\n");
      await f.git("add", "artifact.txt");
      await fs.writeFile(path.join(f.cwd, "artifact.txt"), "unstaged after divergence\n");
      const before = await f.state();
      f.calls.length = 0;
      const rejected = await f.publish("diverged");
      expect(await f.state()).toEqual(before);
      expect(rejected).toMatchObject({
        status: "failed",
        code: "push_rejected",
        nextAction: expect.stringContaining("published head"),
      });
      expect(
        f.calls.some(
          (args) =>
            args.includes("commit-tree") ||
            args.includes("update-ref") ||
            args.includes("push") ||
            args.includes("POST"),
        ),
      ).toBe(false);
    },
  );

  it("retains identity-change semantics when identity is revoked during remote observation", async () => {
    const f = await historyFixture();
    const before = await f.state();
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args: string[], options) => {
      const result = await fallback(args, options);
      if (args.includes("ls-remote")) {
        mocks.matchesIdentity.mockReturnValue(false);
      }
      return result;
    });
    expect(await f.publish("revoked-identity")).toMatchObject({
      status: "failed",
      code: "identity_changed",
      nextAction: expect.stringContaining("Reconnect"),
    });
    expect(await f.state()).toEqual(before);
    expect(
      f.calls.some(
        (args) => args.includes("commit-tree") || args.includes("push") || args.includes("POST"),
      ),
    ).toBe(false);
  });

  it.each(["failed", "malformed", "wrong-ref", "fetch", "ancestry"] as const)(
    "leaves the workspace untouched when remote %s observation is unknown",
    async (fault) => {
      const f = await historyFixture();
      const tree = await f.git("rev-parse", "HEAD^{tree}");
      const remoteCommit = await f.git("commit-tree", tree, "-m", "remote object");
      await f.git("push", f.remote, `${remoteCommit}:refs/heads/${BRANCH}`);
      const fallback = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv: string[], options) => {
        if (argv.includes("ls-remote")) {
          if (fault === "failed") {
            return commandResult("", 1);
          }
          if (fault === "malformed") {
            return commandResult("not-a-ref");
          }
          if (fault === "wrong-ref") {
            return commandResult(`${remoteCommit}\trefs/heads/other\n`);
          }
        }
        if (fault === "fetch" && argv.includes("fetch") && argv.at(-1) === remoteCommit) {
          return commandResult("", 1);
        }
        if (
          fault === "ancestry" &&
          argv.includes("--is-ancestor") &&
          argv.at(-2) === remoteCommit
        ) {
          return commandResult("", 128);
        }
        return await fallback(argv, options);
      });
      const before = await f.state();
      f.calls.length = 0;
      const rejected = await f.publish(`unknown-${fault}`);
      expect(await f.state()).toEqual(before);
      expect(rejected).toMatchObject({
        status: "failed",
        code: "unavailable",
        nextAction: expect.stringContaining("verify"),
      });
      expect(
        f.calls.some(
          (args) =>
            args.includes("commit-tree") ||
            args.includes("update-ref") ||
            args.includes("push") ||
            args.includes("POST"),
        ),
      ).toBe(false);
    },
  );
});
