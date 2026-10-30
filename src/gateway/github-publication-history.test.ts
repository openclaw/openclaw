import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  publicationPullRequestResponse,
  readPublicationCommit,
} from "./github-publication-git.test-support.js";
import {
  BRANCH,
  SESSION_KEY,
  commandResult,
  createRealPublicationWorkspace,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  overrideCommands as interceptCommand,
  root,
} from "./github-publication.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();
const url = "https://github.com/openclaw/openclaw/pull/125200";
const human = "Co-authored-by: alice <7+alice@users.noreply.github.com>";
const marker = "OpenClaw-Publication: previous-writer";
let f: Awaited<ReturnType<typeof historyFixture>>;

async function historyFixture() {
  const workspace = await createRealPublicationWorkspace();
  const { git, cwd } = workspace;
  const gitResult = async (...args: string[]) => commandResult(await git(...args));
  const remote = path.join(root, "remote.git");
  const remoteGit = git.bind(undefined, "-C", remote);
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
        return gitResult("ls-remote", "--refs", remote, `refs/heads/${BRANCH}`);
      }
      if (argv.includes("fetch")) {
        const sha = argv.at(-1)!;
        if (sha === (await remoteHead())) {
          return gitResult("fetch", "--no-tags", "--no-write-fetch-head", remote, sha);
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
      const commit = argv.find((arg) => arg.startsWith("repos/openclaw/openclaw/git/commits/"));
      if (commit) {
        try {
          return commandResult(
            JSON.stringify(await readPublicationCommit(remoteGit, commit.split("/").at(-1)!)),
          );
        } catch {
          return commandResult("", 1);
        }
      }
      if (argv.includes("GET") && argv.includes("repos/openclaw/openclaw/pulls/125200")) {
        return commandResult(JSON.stringify(publicationPullRequestResponse(pr)));
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
  const publish = (idempotencyKey: string, draft?: boolean) =>
    coordinator.requestForSessionV2({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey,
      ...(draft !== undefined ? { draft } : {}),
    });
  const state = async () => ({
    head: await git("rev-parse", "HEAD"),
    index: await fs.readFile(path.join(cwd, ".git", "index")),
    file: await fs.readFile(path.join(cwd, "artifact.txt"), "utf8"),
    remote: await remoteHead(),
  });
  const commit = async (message: string, parent?: string) =>
    git(
      "commit-tree",
      await git("rev-parse", "HEAD^{tree}"),
      ...(parent ? ["-p", parent] : []),
      "-m",
      message,
    );
  const publishMessage = async (message: string) => {
    const parent = await git("rev-parse", "HEAD");
    const head = await commit(message, parent);
    await git("update-ref", `refs/heads/${BRANCH}`, head, parent);
    await git("push", remote, `${head}:refs/heads/${BRANCH}`);
    pr.headSha = head;
    return head;
  };
  const unchanged = async (operation: () => Promise<unknown>) => {
    const before = await state();
    calls.length = 0;
    await operation();
    expect(await state()).toEqual(before);
    expect(
      calls.filter((args) =>
        args.some((arg) => ["commit-tree", "update-ref", "push", "POST"].includes(arg)),
      ),
    ).toEqual([]);
  };
  return {
    ...workspace,
    calls,
    publish,
    state,
    remote,
    remoteHead,
    commit,
    publishMessage,
    commitFacts: async () => ({
      parent: await git("rev-parse", "HEAD^"),
      tree: await git("rev-parse", "HEAD^{tree}"),
    }),
    head: (ref = "HEAD") => git("rev-parse", ref),
    message: (ref = "HEAD") => git("show", "-s", "--format=%B", ref),
    write: (text: string) => fs.writeFile(path.join(cwd, "artifact.txt"), text),
    published: async (key: string, expected: Record<string, unknown> = {}) => {
      const result = await publish(key);
      expect(result).toMatchObject({ status: "published", url, ...expected });
      return result;
    },
    unchanged,
    rejected: (key: string, code: string, action: string) =>
      unchanged(async () => {
        expect(await publish(key)).toMatchObject({
          status: "failed",
          code,
          nextAction: expect.stringContaining(action),
        });
      }),
    parsed: async () => {
      const file = path.join(root, "commit-message.txt");
      await fs.writeFile(file, await git("show", "-s", "--format=%B", "HEAD"));
      return await git("interpret-trailers", "--no-divider", "--parse", file);
    },
  };
}

describe("GitHub publication branch history", () => {
  installGitHubPublicationTestHarness();
  beforeEach(async () => {
    f = await historyFixture();
  });

  it("publishes initial work and fast-forward edits, then reuses an attributed published head across requests", async () => {
    // Signature display must not prepend diagnostics to machine-readable commit facts.
    const signedCommit = path.join(root, "signed-commit.txt");
    await fs.writeFile(
      signedCommit,
      [
        `tree ${await f.head("HEAD^{tree}")}`,
        `parent ${await f.head()}`,
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
    const callsBeforeUpdate = f.calls.length;
    expect(await f.publish("fast-forward", true)).toMatchObject({ status: "published", url });
    expect(
      f.calls
        .slice(callsBeforeUpdate)
        .filter(
          (args) => args.includes("POST") || args.includes("PATCH") || args.includes("graphql"),
        ),
    ).toEqual([]);
    const secondHead = await f.remoteHead();
    expect(secondHead).not.toBe(firstHead);
    expect(await f.head("HEAD^")).toBe(firstHead);
    expect(await f.message()).toContain(human);
    await f.unchanged(() => f.published("separate-same-content", { headCommit: secondHead }));
  });

  it("repairs unrecognized published credit without rewriting history or importing body examples", async () => {
    await f.published("initial");
    const other = "Co-authored-by: example <99+example@users.noreply.github.com>";
    const layouts = [
      `${human}\n\nWorked on by:\n- @alice\n\n${marker}`,
      `${human}\n\n${other}\n${marker}`,
      `${human}\n\n${marker}`,
      ["Example:", "```text", human, other, "```", "", marker].join("\n"),
    ];
    for (const [index, layout] of layouts.entries()) {
      const message = `Implementation credit\n\n${layout}`;
      const previous = await f.publishMessage(message);
      expect(await f.parsed()).not.toContain(human);
      const tree = await f.head("HEAD^{tree}");
      f.calls.length = 0;
      const repaired = await f.published(`repair-${index}`);
      expect(await f.parsed()).toBe(`${human}\nOpenClaw-Publication: ${repaired.requestId}`);
      expect(await f.commitFacts()).toEqual({ parent: previous, tree });
      expect(await f.message(previous)).toBe(message);
      expect(f.calls.filter((args) => args.includes("commit-tree"))).toHaveLength(1);
      expect(f.calls.some((args) => args.includes("POST"))).toBe(false);
      const beforeReplay = await f.head();
      await f.unchanged(async () => {
        expect(await f.publish(`repair-${index}`)).toEqual(repaired);
        await f.published(`reuse-${index}`, { headCommit: beforeReplay });
      });
    }
    // Commit-format trailer parsing must not treat a Markdown separator as a patch divider.
    const valid = await f.publishMessage(`Implementation credit\n\n---\n\n${human}\n${marker}`);
    expect(await f.parsed()).toBe(`${human}\n${marker}`);
    await f.unchanged(() => f.published("markdown-separator", { headCommit: valid }));
    interceptCommand((args) =>
      args.some((arg) => arg.startsWith("--format=%(trailers:"))
        ? commandResult("", 128)
        : undefined,
    );
    await f.unchanged(async () => {
      expect(await f.publish("unavailable-trailer-read")).toMatchObject({
        status: "failed",
        code: "unavailable",
      });
    });
  });

  it("adds missing contributor credit instead of silently reusing an older attributed head", async () => {
    await f.published("initial");
    const previousHead = await f.remoteHead();
    const tree = await f.head("HEAD^{tree}");
    const trailer = "Co-authored-by: bob <8+bob@users.noreply.github.com>";
    mocks.attribution.mockReturnValue({ trailers: [trailer], logins: ["bob"], prompt: "" });
    await f.published("new-credit");
    expect(await f.commitFacts()).toEqual({ parent: previousHead, tree });
    expect(await f.message()).toContain(trailer);
    const head = await f.remoteHead();
    await f.published("same-credit", { headCommit: head });

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
    await f.write("committed topic edit\n");
    await f.git("add", "artifact.txt");
    await f.git("commit", "-m", "topic edit");
    const sourceHead = await f.head();
    const sourceTree = await f.head("HEAD^{tree}");
    await f.git("branch", "-m", "saved-topic");
    await f.git("switch", "-c", BRANCH, sourceHead);
    f.calls.length = 0;

    await f.published("after-reflog-change");

    expect(await f.commitFacts()).toEqual({ parent: sourceHead, tree: sourceTree });
    expect(await f.remoteHead()).toBe(await f.head());
    expect(f.calls.filter((args) => args.includes("POST"))).toHaveLength(1);
  });

  it("rejects unrelated initial history without changing the workspace or remote", async () => {
    const unrelated = await f.commit("unrelated root");
    await f.git("update-ref", `refs/heads/${BRANCH}`, unrelated);
    await f.rejected("unrelated-base", "workspace_changed", "no shared Git history");
  });

  it("rejects unrelated history before changing HEAD, index, files, or remote", async () => {
    await f.git("add", "artifact.txt");
    await f.git("commit", "-m", "source change");
    await f.published("initial");
    const remoteCommit = await f.commit("remote change");
    await f.git("push", f.remote, `${remoteCommit}:refs/heads/foreign`);
    await f.git("-C", f.remote, "update-ref", `refs/heads/${BRANCH}`, remoteCommit);
    await f.write("staged after divergence\n");
    await f.git("add", "artifact.txt");
    await f.write("unstaged after divergence\n");
    await f.rejected("diverged", "push_rejected", "published head");
  });

  it("fails a push the remote rejected instead of leaving it unconfirmed", async () => {
    const hook = path.join(f.remote, "hooks", "pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await f.publish("rejected-push")).toMatchObject({
      status: "failed",
      code: "push_rejected",
      nextAction: expect.stringContaining("openclaw/openclaw. Nothing was pushed as @"),
    });
    expect(await f.remoteHead()).toBe("");
    expect(f.calls.some((args) => args.includes("POST"))).toBe(false);
  });

  it("continues the canonical PR when the configured repository uses different casing", async () => {
    const repository = await mocks.resolveRepository(f.cwd);
    mocks.resolveRepository.mockResolvedValue({
      ...repository,
      originUrl: "git@github.com:OpenClaw/OpenClaw.git",
    });
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation((argv: string[], options: unknown) =>
      transport(
        argv.map((arg) =>
          arg.replace(/^repos\/OpenClaw\/OpenClaw(?=\/|$)/u, "repos/openclaw/openclaw"),
        ),
        options,
      ),
    );
    await f.published("case-alias-first");
    await f.write("saved update through the same repository alias\n");
    await f.published("case-alias-update");
  });

  it.each(["branch", "published-pr"])(
    "retains identity-change semantics during %s observation",
    async (observation) => {
      if (observation === "published-pr") {
        await f.published("initial");
      }
      const fallback = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (args: string[], options) => {
        const result = await fallback(args, options);
        if (
          observation === "branch"
            ? args.includes("ls-remote")
            : args.includes("repos/openclaw/openclaw/pulls/125200")
        ) {
          mocks.matchesIdentity.mockReturnValue(false);
        }
        return result;
      });
      await f.rejected("revoked-identity", "identity_changed", "Reconnect");
    },
  );

  it("rejects a receipt PR naming another head repository without changing saved work", async () => {
    await f.published("initial");
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args: string[], options) => {
      const result = await fallback(args, options);
      if (args.includes("GET") && args.includes("repos/openclaw/openclaw/pulls/125200")) {
        const pr = JSON.parse(result.stdout.toString());
        pr.head.repo.full_name = "other-owner/openclaw";
        return commandResult(JSON.stringify(pr));
      }
      return result;
    });
    await f.rejected("foreign-head", "github_rejected", "permission");
  });

  it.each(["failed", "wrong-ref", "fetch", "ancestry"] as const)(
    "leaves the workspace untouched when remote %s observation is unknown",
    async (fault) => {
      await f.git("push", f.remote, "HEAD:refs/heads/main");
      // A locally created commit would let publication skip the remote fetch.
      const remoteCommit = await f.git(
        "-C",
        f.remote,
        "commit-tree",
        await f.head("HEAD^{tree}"),
        "-m",
        "remote object",
      );
      await f.git("-C", f.remote, "update-ref", `refs/heads/${BRANCH}`, remoteCommit);
      await expect(f.git("cat-file", "-e", `${remoteCommit}^{commit}`)).rejects.toThrow();
      let faultInjected = false;
      interceptCommand((argv) => {
        const targeted =
          fault === "failed" || fault === "wrong-ref"
            ? argv.includes("ls-remote")
            : fault === "fetch"
              ? argv.includes("fetch") && argv.at(-1) === remoteCommit
              : argv.includes("--is-ancestor") && argv.at(-2) === remoteCommit;
        if (targeted) {
          faultInjected = true;
          return fault === "wrong-ref"
            ? commandResult(`${remoteCommit}\trefs/heads/other\n`)
            : commandResult("", fault === "ancestry" ? 128 : 1);
        }
        return undefined;
      });
      await f.rejected(`unknown-${fault}`, "unavailable", "verify");
      expect(faultInjected).toBe(true);
    },
  );
});
