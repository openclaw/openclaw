import { expect, it, vi } from "vitest";

const { previous, head, baseTree, workspaceTree, run, close, observeHead, push } = vi.hoisted(
  () => {
    const priorOid = "1".repeat(40);
    const publishedOid = "2".repeat(40);
    const sourceTree = "3".repeat(40);
    const acceptedTree = "4".repeat(40);
    const comparisonTree = "5".repeat(40);
    const gitRun = vi.fn(async (args: string[]) => {
      if (args[0] === "check-ref-format") {
        return args[2]!;
      }
      if (args[0] === "fetch") {
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "refs/openclaw-publication/observed") {
        return priorOid;
      }
      if (args[0] === "rev-parse" && args[1] === `${priorOid}^{tree}`) {
        return comparisonTree;
      }
      throw new Error(`Unexpected Git read: ${args.join(" ")}`);
    });
    const closeGit = vi.fn(async () => {});
    const readRemoteHead = vi
      .fn()
      .mockResolvedValueOnce(priorOid)
      .mockResolvedValueOnce(publishedOid);
    const pushBranch = vi.fn(async () => {});
    return {
      previous: priorOid,
      head: publishedOid,
      baseTree: sourceTree,
      workspaceTree: acceptedTree,
      run: gitRun,
      close: closeGit,
      observeHead: readRemoteHead,
      push: pushBranch,
    };
  },
);
vi.mock("./gitlab-publication-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gitlab-publication-git.js")>()),
  prepareGitLabPublicationGit: vi.fn(async () => ({
    headCommit: head,
    directory: "/synthetic/quarantine",
    run,
    close,
  })),
  observeGitLabPublicationHead: observeHead,
  pushGitLabPublicationCommit: push,
}));

import { executeRepositoryGitLabPublication } from "./gitlab-publication-executor.js";

it("extends an existing MR while keeping its original author separate from the current publisher", async () => {
  const target = {
    issuer: "https://gitlab.example.test",
    projectId: 17,
    projectPath: "group/repo",
    gitUrl: "https://gitlab.example.test/group/repo.git",
    webUrl: "https://gitlab.example.test/group/repo",
    baseBranch: "master",
  };
  const identity = {
    issuer: target.issuer,
    accountId: 2,
    login: "second-human",
    name: "Second Human",
    commitEmail: "second@example.test",
  };
  const requests: Array<{ method: string; path: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.href : input,
    );
    requests.push({
      method: String(init?.method),
      path: url.pathname,
      body: typeof init?.body === "string" ? init.body : "",
    });
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
    if (url.pathname.endsWith("/user")) {
      return Response.json({
        id: 2,
        username: "second-human",
        name: "Second Human",
        commit_email: "second@example.test",
      });
    }
    if (url.pathname.endsWith("/projects/17")) {
      return Response.json({
        id: 17,
        path_with_namespace: target.projectPath,
        web_url: target.webUrl,
        http_url_to_repo: target.gitUrl,
        default_branch: "master",
      });
    }
    if (url.pathname.endsWith("/repository/branches/master")) {
      return Response.json({ name: "master", commit: { id: previous } });
    }
    if (url.pathname.endsWith(`/repository/commits/${previous}`)) {
      return Response.json({ id: previous });
    }
    if (url.pathname.endsWith("/merge_requests")) {
      return Response.json([
        {
          iid: 9,
          web_url: `${target.webUrl}/-/merge_requests/9`,
          state: "opened",
          source_project_id: 17,
          target_project_id: 17,
          source_branch: "topic",
          target_branch: "master",
          sha: head,
          author: { id: 1 },
          description: "Original human's MR",
          title: "Original title",
        },
      ]);
    }
    throw new Error(`Unexpected API URL: ${url}`);
  };
  const effects: string[] = [];
  const result = await executeRepositoryGitLabPublication({
    execution: {
      row: {
        requestId: "request-2",
        branch: "topic",
        createdAtMs: Date.UTC(2026, 9, 26),
        sourceHeadCommit: previous,
        sourceIndexTree: baseTree,
        workspaceTree,
        previousHeadCommit: previous,
        headCommit: null,
        lastEffect: null,
        effectState: null,
      },
      ownsExecution: () => true,
      updateHead: async () => {
        effects.push("head");
      },
      recordEffect: async (effect, observed) => {
        effects.push(`${effect}:${observed ? "observed" : "dispatched"}`);
      },
      complete: async (outcome) => outcome,
      interrupt: async () => {
        throw new Error("Unexpected interruption");
      },
    },
    snapshot: { baseCommit: previous, baseTree, workspaceTree },
    repositoryRoot: "/synthetic/owner-worktree",
    target,
    identity,
    credentials: { withToken: async (use) => await use("synthetic-token") },
    assertCurrent: () => {},
    assertWorkflowChangesAllowed: () => {},
    commitLocally: async ({ headCommit, directory }) => {
      expect({ headCommit, directory }).toEqual({
        headCommit: head,
        directory: "/synthetic/quarantine",
      });
      effects.push("local");
    },
    title: "Changed title",
    description: "Changed description",
    draft: false,
    fetchImpl,
  });
  expect(result).toMatchObject({
    status: "published",
    headCommit: head,
    publisherAccountId: 2,
    mergeRequestAuthorId: 1,
  });
  expect(effects).toEqual([
    "head",
    "local",
    "push:dispatched",
    "push:observed",
    "pull_request:observed",
  ]);
  expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "GET", "GET", "GET"]);
  expect(push).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("observes a new MR with a pending SHA through bounded reads without repeating creation", async () => {
  observeHead.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(head);
  push.mockClear();
  close.mockClear();
  const target = {
    issuer: "https://gitlab.example.test",
    projectId: 17,
    projectPath: "group/repo",
    gitUrl: "https://gitlab.example.test/group/repo.git",
    webUrl: "https://gitlab.example.test/group/repo",
    baseBranch: "master",
  };
  const identity = {
    issuer: target.issuer,
    accountId: 2,
    login: "second-human",
    name: "Second Human",
    commitEmail: "second@example.test",
  };
  let postCount = 0;
  let createdReads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.href : input,
    );
    if (url.pathname.endsWith("/user")) {
      return Response.json({
        id: 2,
        username: identity.login,
        name: identity.name,
        commit_email: identity.commitEmail,
      });
    }
    if (url.pathname.endsWith("/projects/17")) {
      return Response.json({
        id: 17,
        path_with_namespace: target.projectPath,
        web_url: target.webUrl,
        http_url_to_repo: target.gitUrl,
        default_branch: "master",
      });
    }
    if (url.pathname.endsWith("/repository/branches/master")) {
      return Response.json({ name: "master" });
    }
    if (url.pathname.endsWith(`/repository/commits/${previous}`)) {
      return Response.json({ id: previous });
    }
    if (url.pathname.endsWith("/merge_requests") && init?.method === "GET") {
      return Response.json([]);
    }
    if (url.pathname.endsWith("/merge_requests") && init?.method === "POST") {
      postCount++;
      return Response.json({ iid: 10 });
    }
    if (url.pathname.endsWith("/merge_requests/10")) {
      createdReads++;
      return Response.json({
        iid: 10,
        web_url: `${target.webUrl}/-/merge_requests/10`,
        state: "opened",
        source_project_id: 17,
        target_project_id: 17,
        source_branch: "topic",
        target_branch: "master",
        sha: createdReads === 1 ? null : head,
        author: { id: 2 },
        description: "New description\n\n<!-- openclaw-publication:request-3 -->",
      });
    }
    throw new Error(`Unexpected API URL: ${url}`);
  };
  const result = await executeRepositoryGitLabPublication({
    execution: {
      row: {
        requestId: "request-3",
        branch: "topic",
        createdAtMs: Date.UTC(2026, 9, 26),
        sourceHeadCommit: previous,
        sourceIndexTree: baseTree,
        workspaceTree,
        previousHeadCommit: null,
        headCommit: null,
        lastEffect: null,
        effectState: null,
      },
      ownsExecution: () => true,
      updateHead: async () => {},
      recordEffect: async () => {},
      complete: async (outcome) => outcome,
      interrupt: async () => {
        throw new Error("Unexpected interruption");
      },
    },
    snapshot: { baseCommit: previous, baseTree, workspaceTree },
    repositoryRoot: "/synthetic/owner-worktree",
    target,
    identity,
    credentials: { withToken: async (use) => await use("synthetic-token") },
    assertCurrent: () => {},
    assertWorkflowChangesAllowed: () => {},
    commitLocally: async () => {},
    title: "New title",
    description: "New description",
    draft: false,
    fetchImpl,
  });
  expect(result).toMatchObject({
    status: "published",
    publisherAccountId: 2,
    mergeRequestAuthorId: 2,
  });
  expect(postCount).toBe(1);
  expect(createdReads).toBe(2);
  expect(push).toHaveBeenCalledOnce();
});
