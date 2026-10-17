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
const human = "Co-authored-by: alice <7+alice@users.noreply.github.com>";
const marker = "OpenClaw-Publication: previous-writer";
function expectNoPublicationWrites(calls: string[][]) {
  expect(
    calls.filter((args) =>
      args.some((arg) => ["commit-tree", "update-ref", "push", "POST"].includes(arg)),
    ),
  ).toEqual([]);
}

async function historyFixture() {
  const workspace = await createRealPublicationWorkspace();
  const { git, cwd } = workspace;
  const remote = path.join(root, "remote.git");
  await git("init", "--bare", remote);
  const fallback = mocks.runCommand.getMockImplementation()!;
  const calls: string[][] = [];
  let published = false;
  const pr = {
    url,
    userId: 42,
    state: "open",
    body: "",
    headSha: "",
    headRef: BRANCH,
    baseRef: "main",
  };
  const remoteHead = async () =>
    (await git("ls-remote", "--refs", remote, `refs/heads/${BRANCH}`)).split(/\s+/u)[0] ?? "";
  mocks.runCommand.mockImplementation(
    async (argv: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) => {
      calls.push(argv);
      if (argv.includes("ls-remote")) {
        return commandResult(await git("ls-remote", "--refs", remote, `refs/heads/${BRANCH}`));
      }
      if (argv.includes("fetch")) {
        // Base objects already exist locally; branch objects come from the real remote.
        const sha = argv.at(-1)!;
        if (sha === (await remoteHead())) {
          return commandResult(
            await git("fetch", "--no-tags", "--no-write-fetch-head", remote, sha),
          );
        }
        return commandResult();
      }
      if (argv.includes("push")) {
        try {
          const remoteIndex = argv.indexOf("--") + 1;
          const output = await git(
            ...argv.slice(1).map((arg, index) => (index + 1 === remoteIndex ? remote : arg)),
          );
          if (published) {
            pr.headSha = await remoteHead();
          }
          return commandResult(output);
        } catch {
          return commandResult("", 1);
        }
      }
      if (argv.includes("state=all")) {
        return commandResult(JSON.stringify(published ? [pr] : []));
      }
      if (argv.includes("POST")) {
        const body = JSON.parse(options!.input!);
        Object.assign(pr, { body: body.body, headSha: await remoteHead() });
        published = true;
        return commandResult(JSON.stringify({ html_url: url }));
      }
      return await fallback(argv, options);
    },
  );
  const coordinator = createTestGitHubPublicationCoordinator({
    placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
  });
  const publish = (idempotencyKey: string) =>
    coordinator.requestForSessionV2({ agentId: "main", sessionKey: SESSION_KEY, idempotencyKey });
  const state = async () => ({
    head: await git("rev-parse", "HEAD"),
    index: await fs.readFile(path.join(cwd, ".git", "index")),
    file: await fs.readFile(path.join(cwd, "artifact.txt"), "utf8"),
    remote: await remoteHead(),
  });
  const publishMessage = async (message: string) => {
    const parent = await git("rev-parse", "HEAD");
    const tree = await git("rev-parse", "HEAD^{tree}");
    const head = await git("commit-tree", tree, "-p", parent, "-m", message);
    await git("update-ref", `refs/heads/${BRANCH}`, head, parent);
    await git("push", remote, `${head}:refs/heads/${BRANCH}`);
    pr.headSha = head;
    return head;
  };
  const unchanged = async (before: Awaited<ReturnType<typeof state>>) => {
    expect(await state()).toEqual(before);
    expectNoPublicationWrites(calls);
  };
  return {
    ...workspace,
    calls,
    publish,
    state,
    remote,
    remoteHead,
    publishMessage,
    head: (ref = "HEAD") => git("rev-parse", ref),
    message: (ref = "HEAD") => git("show", "-s", "--format=%B", ref),
    write: (text: string) => fs.writeFile(path.join(cwd, "artifact.txt"), text),
    published: async (key: string, expected: Record<string, unknown> = {}) => {
      const result = await publish(key);
      expect(result).toMatchObject({ status: "published", url, ...expected });
      return result;
    },
    unchanged,
    rejected: async (key: string, code: string, action: string) => {
      const before = await state();
      calls.length = 0;
      expect(await publish(key)).toMatchObject({
        status: "failed",
        code,
        nextAction: expect.stringContaining(action),
      });
      await unchanged(before);
    },
    parsed: async () => {
      const file = path.join(root, "commit-message.txt");
      await fs.writeFile(file, await git("show", "-s", "--format=%B", "HEAD"));
      return await git("interpret-trailers", "--no-divider", "--parse", file);
    },
  };
}

describe("GitHub publication branch history", () => {
  installGitHubPublicationTestHarness();

  it("publishes initial work and fast-forward edits, then reuses an attributed published head across requests", async () => {
    const f = await historyFixture();
    // Signature display must not prepend diagnostics to machine-readable commit facts.
    const signedCommit = path.join(root, "signed-commit.txt");
    await fs.writeFile(
      signedCommit,
      [
        `tree ${await f.git("rev-parse", "HEAD^{tree}")}`,
        `parent ${await f.git("rev-parse", "HEAD")}`,
        "author Fixture <fixture@example.invalid> 1700000000 +0000",
        "committer Fixture <fixture@example.invalid> 1700000000 +0000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " synthetic-invalid-signature",
        " -----END PGP SIGNATURE-----",
        "",
        "Signed fixture",
        "",
      ].join("\n"),
    );
    const signedHead = await f.git("hash-object", "-t", "commit", "-w", signedCommit);
    await f.git("update-ref", "HEAD", signedHead);
    await f.git("config", "log.showSignature", "true");
    const first = await f.published("initial");
    const firstHead = await f.remoteHead();
    expect(await f.publish("initial")).toEqual(first);
    await f.write("next accepted edit\n");
    await f.published("fast-forward");
    const secondHead = await f.remoteHead();
    expect(secondHead).not.toBe(firstHead);
    expect(await f.head("HEAD^")).toBe(firstHead);
    expect(await f.message()).toContain(human);
    const before = await f.state();
    f.calls.length = 0;
    await f.published("separate-same-content", { headCommit: secondHead });
    await f.unchanged(before);
  });

  it("repairs unrecognized published credit without rewriting history or importing body examples", async () => {
    const f = await historyFixture();
    await f.published("initial");
    const other = "Co-authored-by: example <99+example@users.noreply.github.com>";
    const layouts = [
      `${human}\n\nWorked on by:\n- @alice\n\n${marker}`,
      `${human}\n\n${other}\n${marker}`,
      `${human}\n\n${marker}`,
      ["Example:", "```text", human, other, "```", "", marker].join("\n"),
    ];
    for (const [index, layout] of layouts.entries()) {
      // Represent an already-published implementation commit from an older writer.
      const message = `Implementation credit\n\n${layout}`;
      const previous = await f.publishMessage(message);
      expect(await f.parsed()).not.toContain(human);
      const tree = await f.head("HEAD^{tree}");
      f.calls.length = 0;
      const repaired = await f.published(`repair-${index}`);
      expect(await f.parsed()).toBe(`${human}\nOpenClaw-Publication: ${repaired.requestId}`);
      expect(await f.head("HEAD^")).toBe(previous);
      expect(await f.head("HEAD^{tree}")).toBe(tree);
      expect(await f.message(previous)).toBe(message);
      expect(f.calls.filter((args) => args.includes("commit-tree"))).toHaveLength(1);
      expect(f.calls.some((args) => args.includes("POST"))).toBe(false);
      const before = await f.state();
      f.calls.length = 0;
      expect(await f.publish(`repair-${index}`)).toEqual(repaired);
      await f.published(`reuse-${index}`, { headCommit: before.head });
      await f.unchanged(before);
    }
    // Commit-format trailer parsing must not treat a Markdown separator as a patch divider.
    const valid = await f.publishMessage(`Implementation credit\n\n---\n\n${human}\n${marker}`);
    expect(await f.parsed()).toBe(`${human}\n${marker}`);
    const before = await f.state();
    f.calls.length = 0;
    await f.published("markdown-separator", { headCommit: valid });
    await f.unchanged(before);
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
    await f.unchanged(before);
  });

  it("adds missing contributor credit instead of silently reusing an older attributed head", async () => {
    const f = await historyFixture();
    await f.published("initial");
    const previousHead = await f.remoteHead();
    const tree = await f.head("HEAD^{tree}");
    const trailer = "Co-authored-by: bob <8+bob@users.noreply.github.com>";
    mocks.attribution.mockReturnValue({ trailers: [trailer], logins: ["bob"], prompt: "" });
    await f.published("new-credit");
    expect(await f.head("HEAD^")).toBe(previousHead);
    expect(await f.head("HEAD^{tree}")).toBe(tree);
    expect(await f.message()).toContain(trailer);
    const head = await f.remoteHead();
    await f.published("same-credit", { headCommit: head });

    // Opt-out, bot-only, and no-human sessions all resolve to no current attribution.
    // Existing public history stays intact; future generated commits must not copy it.
    mocks.attribution.mockReturnValue(undefined);
    await f.published("no-current-human", { headCommit: head });
    await f.write("work without current human credit\n");
    await f.published("new-work-no-human");
    expect(await f.git("show", "-s", "--format=%(trailers:key=Co-authored-by,only)", "HEAD")).toBe(
      "",
    );
    const uncredited = await f.remoteHead();
    await f.published("reuse-no-human", { headCommit: uncredited });
  });

  it("publishes initial work after its branch reflog is recreated", async () => {
    const f = await historyFixture();
    await f.write("committed topic edit\n");
    await f.git("add", "artifact.txt");
    await f.git("commit", "-m", "topic edit");
    const sourceHead = await f.head();
    const sourceTree = await f.head("HEAD^{tree}");
    await f.git("branch", "-m", "saved-topic");
    await f.git("switch", "-c", BRANCH, sourceHead);
    f.calls.length = 0;

    await f.published("after-reflog-change");

    expect(await f.head("HEAD^")).toBe(sourceHead);
    expect(await f.head("HEAD^{tree}")).toBe(sourceTree);
    expect(await f.remoteHead()).toBe(await f.head());
    expect(f.calls.filter((args) => args.includes("POST"))).toHaveLength(1);
  });

  it("rejects unrelated initial history without changing the workspace or remote", async () => {
    const f = await historyFixture();
    const tree = await f.head("HEAD^{tree}");
    const unrelated = await f.git("commit-tree", tree, "-m", "unrelated root");
    await f.git("update-ref", `refs/heads/${BRANCH}`, unrelated);
    await f.rejected("unrelated-base", "workspace_changed", "no shared Git history");
  });

  it("rejects unrelated history before changing HEAD, index, files, or remote", async () => {
    const f = await historyFixture();
    // Already-committed source plus an intentional first-publication marker.
    await f.git("add", "artifact.txt");
    await f.git("commit", "-m", "source change");
    await f.published("initial");
    const tree = await f.head("HEAD^{tree}");
    const remoteCommit = await f.git("commit-tree", tree, "-m", "remote change");
    await f.git("push", f.remote, `${remoteCommit}:refs/heads/foreign`);
    await f.git("-C", f.remote, "update-ref", `refs/heads/${BRANCH}`, remoteCommit);
    await f.write("staged after divergence\n");
    await f.git("add", "artifact.txt");
    await f.write("unstaged after divergence\n");
    await f.rejected("diverged", "push_rejected", "published head");
  });

  it("retains identity-change semantics when identity is revoked during remote observation", async () => {
    const f = await historyFixture();
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args: string[], options) => {
      const result = await fallback(args, options);
      if (args.includes("ls-remote")) {
        mocks.matchesIdentity.mockReturnValue(false);
      }
      return result;
    });
    await f.rejected("revoked-identity", "identity_changed", "Reconnect");
  });

  it.each(["failed", "wrong-ref", "fetch", "ancestry"] as const)(
    "leaves the workspace untouched when remote %s observation is unknown",
    async (fault) => {
      const f = await historyFixture();
      const tree = await f.head("HEAD^{tree}");
      const remoteCommit = await f.git("commit-tree", tree, "-m", "remote object");
      await f.git("push", f.remote, `${remoteCommit}:refs/heads/${BRANCH}`);
      const fallback = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv: string[], options) => {
        if (argv.includes("ls-remote")) {
          if (fault === "failed") {
            return commandResult("", 1);
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
      await f.rejected(`unknown-${fault}`, "unavailable", "verify");
    },
  );
});
