// Exercise registered actions through session/requester owners; only GitHub I/O is synthetic.
// oxfmt-ignore
import { createPublicationActionFixture, createPublicationActionInvoker, publicationCheckpoint as checkpoint } from "./github-publication-actions.test-support.js";
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionGitHubActionResultSchema } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { syncCanonicalGitHubIdentity } from "../state/user-profile-writes.js";
import { createRequesterPublicationFixture } from "./github-publication-requester.test-support.js";
import {
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  SESSION_ID,
  SESSION_KEY,
} from "./github-publication.test-support.js";

const mocks = githubPublicationTestMocks();
const headCommit = "a".repeat(40);
const url = "https://github.com/example/repository/pull/7";
const repository = (id: number, full_name: string, type: string, push: boolean) => ({
  id,
  full_name,
  private: false,
  archived: false,
  owner: { type },
  permissions: { push },
});

async function fixture(previousPublication = false, prepared = true, bound = true) {
  const f = previousPublication
    ? await createPublicationActionFixture()
    : await createRequesterPublicationFixture(checkpoint, "local", {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
      });
  await syncCanonicalGitHubIdentity({
    identity: { accountId: 101, login: "contributor" },
    authenticationAlias: { kind: "email", email: "publication-guest@example.test" },
  });
  const base = repository(10, "example/repository", "Organization", true);
  const head = repository(20, "contributor/repository", "User", false);
  const scope = {
    agentId: "main",
    sessionKey: !bound && !previousPublication ? "agent:main:explicit-metadata" : SESSION_KEY,
  };
  if (scope.sessionKey !== SESSION_KEY) {
    await upsertSessionEntryCore(scope, {
      sessionId: randomUUID(),
      lifecycleRevision: randomUUID(),
      updatedAt: 1,
      sandbox: "required",
      createdActor: { type: "human", source: "profile", id: f.guestProfile },
    });
  }
  const entry = loadSessionEntryReadOnly(scope)!;
  if (scope.sessionKey !== SESSION_KEY) {
    expect(entry.worktree).toBeUndefined();
    expect(entry.repositoryWorkspaceId).toBeUndefined();
  }
  const binding = {
    url,
    host: "github.com",
    number: 7,
    base: {
      repository: base.full_name,
      repositoryId: base.id,
      branch: "main",
      commit: "b".repeat(40),
    },
    head: {
      repository: head.full_name,
      repositoryId: head.id,
      branch: "topic",
      commit: headCommit,
    },
    preparedHeadCommit: prepared ? headCommit : undefined,
  };
  if (bound) {
    await upsertSessionEntryCore(scope, {
      worktree: { ...entry.worktree!, githubPullRequest: binding },
    });
  }
  const headRef: { repo: typeof head | null; ref: string; sha: string } = {
    repo: head,
    ref: "topic",
    sha: headCommit,
  };
  const state = {
    html_url: url,
    number: 7,
    node_id: "PR_original",
    user: { id: 101, login: "contributor" },
    maintainer_can_modify: true,
    head: headRef,
    base: { repo: base, ref: "main", sha: "b".repeat(40) },
    state: "open",
    draft: true,
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    merge_commit_sha: null as string | null,
    title: "Original title",
    body: "Original contributor description",
  };
  const writes: { endpoint: string; input: Record<string, unknown> }[] = [];
  const previous = mocks.runCommand.getMockImplementation()!;
  let onRead: ((endpoint: string) => Promise<void>) | undefined;
  let permission = "write";
  let loseEditResponse = false;
  let loseReviewResponse = false;
  mocks.runCommand.mockImplementation(async (argv: string[], options) => {
    if (argv[0] !== "gh" || !argv.includes("--method")) {
      return await previous(argv, options);
    }
    const endpoint = argv.find(
      (arg) => arg === "graphql" || arg.startsWith("repos/") || arg.startsWith("user/"),
    )!;
    if (argv.includes("GET")) {
      await onRead?.(endpoint);
      const data =
        endpoint === `repos/${base.full_name}`
          ? base
          : endpoint === `repos/${head.full_name}`
            ? head
            : endpoint.endsWith("/branches/topic")
              ? { name: "topic", commit: { sha: state.head.sha }, protected: false }
              : endpoint.endsWith("/pulls/7")
                ? state
                : endpoint === "user/101"
                  ? { id: 101, login: "contributor" }
                  : endpoint.endsWith("/collaborators/contributor/permission")
                    ? { user: { id: 101 }, permission }
                    : undefined;
      return data ? commandResult(JSON.stringify(data)) : commandResult("", 1);
    }
    const input = JSON.parse(options!.input!);
    writes.push({ endpoint, input });
    if (endpoint === "graphql") {
      state.draft = false;
    } else if (endpoint.endsWith("/merge")) {
      state.merged = true;
      state.state = "closed";
      state.merge_commit_sha = "e".repeat(40);
    } else if (endpoint.endsWith("/comments")) {
      if (loseReviewResponse) {
        throw new Error("Connection lost after GitHub accepted the review request");
      }
      return commandResult(
        JSON.stringify({
          id: 123,
          html_url: `${url}#issuecomment-123`,
          body: "@clawsweeper re-review",
          user: { id: 42 },
        }),
      );
    } else if (endpoint.endsWith("/pulls/7")) {
      Object.assign(state, input);
      if (loseEditResponse) {
        throw new Error("Connection lost after GitHub accepted the metadata edit");
      }
    } else {
      throw new Error(`Unexpected fixture GitHub write: ${endpoint}`);
    }
    return commandResult("{}");
  });
  const invokeFrom = createPublicationActionInvoker(f);
  const invoke: ReturnType<typeof createPublicationActionInvoker> = (
    actor,
    input,
    source,
    invocation,
  ) => invokeFrom(actor, input, source ?? scope.sessionKey, invocation);
  return {
    ...f,
    invoke,
    act: (action: string, input: Record<string, unknown> = {}) =>
      invoke("guest", { action, expectedHeadCommit: headCommit, ...input }),
    state,
    base,
    head,
    scope,
    binding,
    writes,
    onRead(callback: (endpoint: string) => Promise<void>) {
      onRead = callback;
    },
    loseEditResponse() {
      loseEditResponse = true;
    },
    loseReviewResponse() {
      loseReviewResponse = true;
    },
    setPermission(value: string) {
      permission = value;
    },
  };
}

describe("actions on the imported original PR", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each(["guest", "admin"] as const)(
    "requests re-review of an explicit verified PR without importing source (%s)",
    async (actor) => {
      const f = await fixture(false, false, false);
      f.base.permissions.push = false;
      f.state.maintainer_can_modify = false;
      if (actor === "admin") {
        f.state.user = { id: 999, login: "other-contributor" };
      }
      const worktree = structuredClone(loadSessionEntryReadOnly(f.scope)?.worktree);
      const checkpoints = checkpoint.mock.calls.length;
      const result = await f.invoke(actor, {
        action: "request_review",
        pullRequestUrl: url,
        expectedHeadCommit: headCommit,
      });
      expect(result.details).toMatchObject({
        pullRequest: { url, repository: "example/repository", branch: "topic" },
        headCommit,
        reviewRequest: { status: "posted", url: `${url}#issuecomment-123` },
      });
      if (actor === "admin") {
        await expect(f.act("request_review", { pullRequestUrl: url })).rejects.toThrow(
          /not authored/,
        );
      }
      expect(f.writes).toEqual([
        {
          endpoint: "repos/example/repository/issues/7/comments",
          input: { body: "@clawsweeper re-review" },
        },
      ]);
      expect(loadSessionEntryReadOnly(f.scope)?.worktree).toEqual(worktree);
      expect(checkpoint.mock.calls.length).toBe(checkpoints);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it("does not retry an explicit re-review after a lost response", async () => {
    const f = await fixture(false, false, false);
    f.loseReviewResponse();
    await expect(f.act("request_review", { pullRequestUrl: url })).rejects.toThrow(
      /may already have been posted.*Read the PR comments.*do not retry blindly/u,
    );
    expect(f.writes).toEqual([
      {
        endpoint: "repos/example/repository/issues/7/comments",
        input: { body: "@clawsweeper re-review" },
      },
    ]);
  });

  it.each(["unbound", "publication", "binding"])(
    "edits an explicit verified PR while preserving the session's %s target",
    async (target) => {
      const f = await fixture(target === "publication", false, target === "binding");
      if (target === "binding") {
        await upsertSessionEntryCore(f.scope, {
          worktree: {
            ...loadSessionEntryReadOnly(f.scope)!.worktree!,
            githubPullRequest: {
              ...f.binding,
              number: 8,
              url: "https://github.com/example/repository/pull/8",
            },
          },
        });
      }
      const externalWrites = f.externalWrites.length;
      const worktree = structuredClone(loadSessionEntryReadOnly(f.scope)?.worktree);
      const checkpoints = checkpoint.mock.calls.length;
      const observed = await f.invoke("guest", { action: "edit", pullRequestUrl: url });
      expect(observed.details).toMatchObject({
        pullRequest: { url, repository: "example/repository", branch: "topic" },
        headCommit,
        title: "Original title",
      });
      await f.act("edit", {
        pullRequestUrl: url,
        expectedTitle: "Original title",
        title: "Updated external PR",
      });
      expect(f.writes).toEqual([
        { endpoint: "repos/example/repository/pulls/7", input: { title: "Updated external PR" } },
      ]);
      const current = loadSessionEntryReadOnly(f.scope);
      expect(current?.worktree).toEqual(worktree);
      expect(current?.repositoryWorkspaceId).toBeUndefined();
      expect(checkpoint.mock.calls.length).toBe(checkpoints);
      expect(f.externalWrites).toHaveLength(externalWrites);
    },
  );

  it.each([false, true])(
    "keeps explicit maintainer edits separate from later guest authority (private: %s)",
    async (privateRepository) => {
      const f = await fixture(false, false, false);
      f.base.private = privateRepository;
      f.head.private = privateRepository;
      f.state.user = { id: 999, login: "other-contributor" };
      const result = await f.invoke("admin", {
        action: "edit",
        pullRequestUrl: url,
        expectedHeadCommit: headCommit,
        title: "Maintainer clarification",
        expectedTitle: "Original title",
        body: "Clarified description",
        expectedBody: "Original contributor description",
      });
      expect(result.details).toMatchObject({
        title: "Maintainer clarification",
        body: "Clarified description",
      });
      await expect(
        f.act("edit", {
          pullRequestUrl: url,
          title: "Guest change",
          expectedTitle: "Maintainer clarification",
        }),
      ).rejects.toThrow(privateRepository ? /could not be verified/ : /not authored/);
      expect(f.writes).toEqual([
        {
          endpoint: "repos/example/repository/pulls/7",
          input: { title: "Maintainer clarification", body: "Clarified description" },
        },
      ]);
      const current = loadSessionEntryReadOnly(f.scope);
      expect(current).toMatchObject({
        sandbox: "required",
        createdActor: { id: f.guestProfile },
      });
      expect(current?.worktree).toBeUndefined();
      expect(current?.repositoryWorkspaceId).toBeUndefined();
    },
  );

  it.each([false, true])(
    "edits metadata without source push access (deleted fork: %s)",
    async (deleted) => {
      const f = await fixture(false, false, false);
      f.base.permissions.push = false;
      f.state.maintainer_can_modify = false;
      if (deleted) {
        f.state.head.repo = null;
      }
      await f.act("edit", {
        pullRequestUrl: url,
        title: "Metadata only",
        expectedTitle: f.state.title,
      });
      expect(f.state.title).toBe("Metadata only");
      expect(f.writes).toHaveLength(1);
    },
  );

  it.each(["author", "repository", "private access", "inaccessible", "host", "receipt"])(
    "denies an explicit target with invalid %s without any write",
    async (change) => {
      const f = await fixture(false, false, false);
      let pullRequestUrl = url;
      if (change === "author") {
        f.state.user.id = 999;
      }
      if (change === "repository") {
        f.state.base.repo = { ...f.base, id: 99 };
      }
      if (change === "private access") {
        f.base.private = true;
        f.setPermission("none");
      }
      if (change === "inaccessible") {
        pullRequestUrl = url.replace("/7", "/999");
      }
      if (change === "host") {
        pullRequestUrl = url.replace("github.com", "other.example");
      }
      await expect(
        f.act("edit", {
          pullRequestUrl,
          title: "Unauthorized change",
          expectedTitle: "Original title",
          ...(change === "receipt" ? { requestId: "00000000-0000-4000-8000-000000000001" } : {}),
        }),
      ).rejects.toThrow(
        change === "author"
          ? /not authored/
          : change === "host"
            ? /configured GitHub host/
            : change === "receipt"
              ? /no publication requestId/
              : /could not be verified/,
      );
      expect(f.writes).toEqual([]);
    },
  );

  it.each([
    ["edit", "requester"],
    ["edit", "head"],
    ["edit", "title"],
    ["request_review", "requester"],
    ["request_review", "requester and transport"],
    ["request_review", "head"],
    ["request_review", "closed"],
    ["request_review", "author"],
  ])("rechecks explicit %s target %s before the write", async (action, change) => {
    const f = await fixture(false, false, false);
    let reads = 0;
    f.onRead(async (endpoint) => {
      if (endpoint.endsWith("/pulls/7") && ++reads === 2) {
        if (change === "requester" || change === "requester and transport") {
          await f.revoke();
          if (change === "requester and transport") {
            throw new Error("Synthetic GitHub read failure");
          }
        }
        if (change === "head") {
          f.state.head.sha = "f".repeat(40);
        }
        if (change === "title") {
          f.state.title = "New human title";
        }
        if (change === "closed") {
          f.state.state = "closed";
        }
        if (change === "author") {
          f.state.user.id = 999;
        }
      }
    });
    await expect(
      f.act(action, {
        pullRequestUrl: url,
        ...(action === "edit" ? { title: "Requested title", expectedTitle: "Original title" } : {}),
      }),
    ).rejects.toThrow(
      change === "requester" || change === "requester and transport"
        ? /role changed/
        : change === "head"
          ? /head changed/
          : change === "closed"
            ? /closed/
            : change === "author"
              ? /not authored/
              : /metadata changed/,
    );
    expect(f.writes).toEqual([]);
  });

  it("reconciles an accepted explicit edit after a lost response without repeating the write", async () => {
    const f = await fixture(false, false, false);
    f.loseEditResponse();
    const input = { pullRequestUrl: url, title: "Accepted title", expectedTitle: "Original title" };
    expect((await f.act("edit", input)).details).toMatchObject({ title: "Accepted title" });
    expect((await f.act("edit", input)).details).toMatchObject({ title: "Accepted title" });
    expect(f.writes).toHaveLength(1);
  });

  it("reads the unprepared bound original PR despite an older publication", async () => {
    const f = await fixture(true, false);
    const checkpoints = checkpoint.mock.calls.length;
    const result = await f.invoke("guest", { action: "edit" });
    expect(result.details).toMatchObject({
      pullRequest: { url, repository: "example/repository", branch: "topic" },
      headCommit,
    });
    expect(result.details).not.toHaveProperty("publication");
    expect(Value.Check(SessionGitHubActionResultSchema, result.details)).toBe(true);
    expect(checkpoint.mock.calls.length).toBe(checkpoints);
    expect(f.writes).toEqual([]);
  });

  it("edits, requests the fixed review and marks ready without pushing source", async () => {
    const f = await fixture();
    const checkpoints = checkpoint.mock.calls.length;
    await f.act("edit", {
      expectedTitle: "Original title",
      title: "Updated title",
    });
    const review = await f.act("request_review");
    expect(review.details).toMatchObject({
      reviewRequest: { status: "posted", url: `${url}#issuecomment-123` },
    });
    expect((await f.act("ready")).details).toMatchObject({ state: "open" });
    expect(f.writes).toEqual([
      { endpoint: "repos/example/repository/pulls/7", input: { title: "Updated title" } },
      {
        endpoint: "repos/example/repository/issues/7/comments",
        input: { body: "@clawsweeper re-review" },
      },
      {
        endpoint: "graphql",
        input: { query: expect.any(String), variables: { id: "PR_original" } },
      },
    ]);
    expect(checkpoint.mock.calls.length).toBe(checkpoints);
    expect(f.externalWrites).toEqual([]);
  });

  it("uses the newly observed remote head for metadata without changing prepared source", async () => {
    const f = await fixture();
    const newerHead = "f".repeat(40);
    f.state.head.sha = newerHead;
    expect((await f.invoke("guest", { action: "edit" })).details).toMatchObject({
      headCommit: newerHead,
    });
    await f.act("edit", {
      expectedHeadCommit: newerHead,
      expectedTitle: "Original title",
      title: "Newer head metadata",
    });
    expect(f.state.title).toBe("Newer head metadata");
    expect(loadSessionEntryReadOnly(f.scope)?.worktree?.githubPullRequest).toEqual(f.binding);
  });

  it.each(["title", "body"] as const)(
    "preserves a human %s edit observed during eligibility preparation",
    async (field) => {
      const f = await fixture();
      let reads = 0;
      f.onRead(async (endpoint) => {
        // Eligibility rereads the PR after inspection and the action's first metadata read.
        if (endpoint.endsWith("/pulls/7") && ++reads === 3) {
          f.state[field] = "New human edit";
        }
      });
      const changes =
        field === "title"
          ? { expectedTitle: "Original title", title: "Requested title" }
          : { expectedBody: "Original contributor description", body: "Requested body" };
      await expect(f.act("edit", changes)).rejects.toThrow("metadata changed");
      expect(f.state[field]).toBe("New human edit");
      expect(f.writes).toEqual([]);
    },
  );

  it("keeps full-write inspect/merge separate from later guest turns", async () => {
    const f = await fixture();
    await expect(
      f.invoke("guest", { action: "inspect" }, SESSION_KEY, { raw: true }),
    ).rejects.toThrow(/scope|permission/iu);
    await f.act("ready");
    const merged = await f.invoke("admin", {
      action: "merge",
      mergeMethod: "squash",
      expectedHeadCommit: headCommit,
    });
    expect(merged.details).toMatchObject({ state: "merged", mergeCommit: "e".repeat(40) });
    expect(f.writes.at(-1)).toMatchObject({
      endpoint: "repos/example/repository/pulls/7/merge",
      input: { sha: headCommit, merge_method: "squash", commit_title: "Original title" },
    });
    expect(loadSessionEntryReadOnly(f.scope)).toMatchObject({
      sandbox: "required",
      createdActor: { id: f.guestProfile },
      worktree: { githubPullRequest: f.binding },
    });
  });

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const changes: Record<string, (f: Fixture) => void> = {
    author: (f) => {
      f.state.user.id = 999;
    },
    "head repository": (f) => {
      f.head.id = 99;
    },
    "base repository": (f) => {
      f.base.id = 99;
    },
    branch: (f) => {
      f.state.head.ref = "other";
    },
    head: (f) => {
      f.state.head.sha = "f".repeat(40);
    },
    "publisher permission": (f) => {
      f.state.maintainer_can_modify = false;
    },
    "private access": (f) => {
      f.base.private = true;
      f.setPermission("none");
    },
    session: (f) =>
      f.onRead(async () => {
        await upsertSessionEntryCore(f.scope, {
          worktree: {
            ...loadSessionEntryReadOnly(f.scope)!.worktree!,
            githubPullRequest: { ...f.binding, number: 8 },
          },
        });
      }),
    requester: (f) => f.onRead(() => f.revoke()),
  };
  it.each(Object.entries(changes))("denies changed %s before any effect", async (_name, change) => {
    const f = await fixture();
    change(f);
    await expect(f.act("request_review")).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });

  it("refuses stale receipt and missing head preconditions for the imported target", async () => {
    const f = await fixture();
    for (const input of [
      {},
      { requestId: "00000000-0000-4000-8000-000000000001", expectedHeadCommit: headCommit },
    ]) {
      await expect(f.invoke("guest", { action: "ready", ...input })).rejects.toThrow();
    }
    expect(f.writes).toEqual([]);
  });
});
