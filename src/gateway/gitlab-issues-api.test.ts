import { parseGitLabIssueOperation } from "@openclaw/gateway-protocol/gitlab-issues";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeGitLabIssueOperation,
  GitLabIssueOutcomeUnknownError,
} from "./gitlab-issues-api.js";
import type { PersonalGitLabCredential } from "./gitlab-personal-oauth.js";

const issuer = "https://gitlab.example.test";
const projectUrl = `${issuer}/team/app`;
const project = { id: 91, path_with_namespace: "team/app", web_url: projectUrl };
const issue = (overrides: Record<string, unknown> = {}) => ({
  id: 501,
  iid: 12,
  project_id: 91,
  web_url: `${projectUrl}/-/issues/12`,
  title: "Investigate retry",
  description: "Observed behavior",
  state: "opened",
  updated_at: "2026-10-27T12:00:00.000Z",
  author: { id: 11 },
  labels: ["bug"],
  assignees: [{ id: 11 }],
  milestone: null,
  due_date: null,
  ...overrides,
});
const note = (authorId: number, overrides: Record<string, unknown> = {}) => ({
  id: 701,
  body: "I reproduced it.",
  author: { id: authorId },
  created_at: "2026-10-27T12:01:00.000Z",
  updated_at: "2026-10-27T12:01:00.000Z",
  system: false,
  ...overrides,
});
const json = (value: unknown, headers?: HeadersInit) => Response.json(value, { headers });
function credential(accountId = 11, token = "alice-secret"): PersonalGitLabCredential {
  return {
    account: {
      accountId,
      login: accountId === 11 ? "alice" : "bob",
      name: "Synthetic",
      commitEmail: "synthetic@example.test",
      issuer,
    },
    generation: "synthetic-generation",
    assertCurrent: () => undefined,
    withToken: async (useToken) => await useToken(token),
  };
}
function run(
  operation: Parameters<typeof executeGitLabIssueOperation>[0]["operation"],
  selected = credential(),
  assertCurrent = () => undefined,
  assertProjectAllowed = (_projectId: number) => undefined,
) {
  return executeGitLabIssueOperation({
    operation,
    credential: selected,
    signal: new AbortController().signal,
    assertCurrent,
    assertProjectAllowed,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("requester-bound GitLab issue API", () => {
  it("rejects noncanonical and foreign project URLs before a token-bearing request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const url of [
      "https://gitlab.example.test.evil.test/team/app",
      `${projectUrl}/`,
      `${projectUrl}?x=1`,
      `${issuer}/team/%61pp`,
      `${issuer}/user:pass@team/app`,
    ]) {
      await expect(run({ action: "issue.list", projectUrl: url })).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["issues", "work_items"])("accepts the exact GitLab %s issue route", async (route) => {
    const webUrl = `${projectUrl}/-/${route}/12`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) =>
        input.pathname.includes("/projects/team%2Fapp")
          ? json(project)
          : json(issue({ web_url: webUrl })),
      ),
    );
    await expect(run({ action: "issue.get", projectUrl, iid: 12 })).resolves.toMatchObject({
      item: { iid: 12, webUrl },
    });
  });

  it.each([
    `${issuer}/other/project/-/work_items/12`,
    `${projectUrl}/-/work_items/13`,
    `${projectUrl}/-/work_items/12?redirect=1`,
    `https://foreign.example.test/team/app/-/work_items/12`,
  ])("rejects a mismatched issue work-item URL %s", async (webUrl) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) =>
        input.pathname.includes("/projects/team%2Fapp")
          ? json(project)
          : json(issue({ web_url: webUrl })),
      ),
    );
    await expect(run({ action: "issue.get", projectUrl, iid: 12 })).rejects.toThrow(
      "GitLab issue URL changed",
    );
  });

  it("uses only the selected person's token and verifies the project before issue creation", async () => {
    const calls: { url: string; authorization: string | null; method: string; body: unknown }[] =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        if (init.body !== undefined && typeof init.body !== "string") {
          throw new Error("Expected a JSON request body");
        }
        calls.push({
          url: input.toString(),
          authorization: new Headers(init.headers).get("authorization"),
          method: init.method ?? "GET",
          body: init.body ? JSON.parse(init.body) : null,
        });
        return input.pathname.includes("/projects/team%2Fapp")
          ? json(project)
          : json(
              issue({
                author: {
                  id:
                    init.headers &&
                    new Headers(init.headers).get("authorization") === "Bearer bob-secret"
                      ? 22
                      : 11,
                },
              }),
            );
      }),
    );
    const alice = await run({
      action: "issue.create",
      projectUrl,
      title: "Investigate retry",
      labels: ["bug"],
    });
    const bob = await run(
      { action: "issue.create", projectUrl, title: "Investigate retry", labels: ["bug"] },
      credential(22, "bob-secret"),
    );
    expect(alice).toMatchObject({
      actor: { accountId: 11 },
      effect: { authorId: 11, remoteId: 501, outcome: "observed" },
    });
    expect(bob).toMatchObject({
      actor: { accountId: 22 },
      effect: { authorId: 22, remoteId: 501, outcome: "observed" },
    });
    expect(calls.map((entry) => entry.authorization)).toEqual([
      "Bearer alice-secret",
      "Bearer alice-secret",
      "Bearer bob-secret",
      "Bearer bob-secret",
    ]);
    expect(calls.filter((entry) => entry.method === "POST").map((entry) => entry.body)).toEqual([
      { title: "Investigate retry", labels: "bug" },
      { title: "Investigate retry", labels: "bug" },
    ]);
    expect(calls.every((entry) => entry.url.startsWith(`${issuer}/api/v4/`))).toBe(true);
  });

  it("returns bounded issue search pages and exact next-page evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) =>
        input.pathname.includes("/projects/team%2Fapp")
          ? json(project)
          : json([issue()], { "x-next-page": "2" }),
      ),
    );
    const result = await run({
      action: "issue.list",
      projectUrl,
      query: "retry",
      state: "all",
      page: 1,
    });
    expect(result).toMatchObject({
      action: "issue.list",
      nextPage: 2,
      truncated: false,
      items: [{ iid: 12, title: "Investigate retry" }],
    });
  });

  it("checks observed issue version before a partial metadata change", async () => {
    const fetcher = vi.fn(async (input: URL, init: RequestInit) => {
      if (input.pathname.includes("/projects/team%2Fapp")) {
        return json(project);
      }
      if (init.method === "GET") {
        return json(issue({ updated_at: "later" }));
      }
      return json(issue());
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      run({
        action: "issue.update",
        projectUrl,
        iid: 12,
        expectedUpdatedAt: "earlier",
        addLabels: ["priority"],
      }),
    ).rejects.toThrow("changed");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("posts issue notes under the requester and refuses a mismatched author", async () => {
    const fetcher = vi.fn(async (input: URL) =>
      input.pathname.includes("/projects/team%2Fapp") ? json(project) : json(note(11)),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await run({
      action: "note.create",
      projectUrl,
      target: "issue",
      iid: 12,
      body: "I reproduced it.",
    });
    expect(result).toMatchObject({ effect: { remoteId: 701, authorId: 11 } });
    fetcher.mockImplementation(async (input: URL) =>
      input.pathname.includes("/projects/team%2Fapp") ? json(project) : json(note(22)),
    );
    await expect(
      run({
        action: "note.create",
        projectUrl,
        target: "issue",
        iid: 12,
        body: "I reproduced it.",
      }),
    ).rejects.toBeInstanceOf(GitLabIssueOutcomeUnknownError);
  });

  it("refuses redirects, and reports an uncertain post without retrying", async () => {
    const fetcher = vi.fn(async (input: URL, _init: RequestInit) =>
      input.pathname.includes("/projects/team%2Fapp")
        ? json(project)
        : Response.redirect("https://other.example.test/leak", 302),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      run({ action: "note.create", projectUrl, target: "issue", iid: 12, body: "A note" }),
    ).rejects.toBeInstanceOf(GitLabIssueOutcomeUnknownError);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every((call) => call[1]?.redirect === "error")).toBe(true);
    fetcher.mockImplementation(async (input: URL) => {
      if (input.pathname.includes("/projects/team%2Fapp")) {
        return json(project);
      }
      throw new Error("connection lost");
    });
    await expect(
      run({ action: "note.create", projectUrl, target: "issue", iid: 12, body: "A note" }),
    ).rejects.toMatchObject({ operationKind: "note.create", projectUrl, iid: 12 });
  });

  it("prevents a revoked requester from dispatching a write after project lookup", async () => {
    let current = true;
    const fetcher = vi.fn(async () => {
      current = false;
      return json(project);
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      run({ action: "issue.create", projectUrl, title: "Denied" }, credential(), () => {
        if (!current) {
          throw new Error("requester revoked");
        }
      }),
    ).rejects.toThrow("requester revoked");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("checks the live configured project policy after lookup and before a write", async () => {
    let allowed = true;
    const fetcher = vi.fn(async (input: URL) => {
      if (input.pathname.includes("/projects/team%2Fapp")) {
        return json(project);
      }
      allowed = false;
      return json(issue());
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      run(
        {
          action: "issue.update",
          projectUrl,
          iid: 12,
          expectedUpdatedAt: issue().updated_at as string,
          title: "Updated",
        },
        credential(),
        () => undefined,
        (id) => {
          if (id !== 91 || !allowed) {
            throw new Error("project policy revoked");
          }
        },
      ),
    ).rejects.toThrow("project policy revoked");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a project excluded by the live allowlist before reading an issue", async () => {
    const fetcher = vi.fn(async () => json(project));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      run(
        { action: "issue.get", projectUrl, iid: 12 },
        credential(),
        () => undefined,
        () => {
          throw new Error("project not allowed");
        },
      ),
    ).rejects.toThrow("project not allowed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports malformed successful create results as unknown rather than inviting a retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) =>
        input.pathname.includes("/projects/team%2Fapp") ? json(project) : json({ id: 501 }),
      ),
    );
    await expect(
      run({ action: "issue.create", projectUrl, title: "Investigate retry" }),
    ).rejects.toBeInstanceOf(GitLabIssueOutcomeUnknownError);
  });

  it("pins a diff discussion to the observed MR head and requester author", async () => {
    const head = "a".repeat(40);
    const fetcher = vi.fn(async (input: URL, init: RequestInit) => {
      if (input.pathname.includes("/projects/team%2Fapp")) {
        return json(project);
      }
      if (init.method === "GET") {
        return json({
          id: 801,
          iid: 9,
          project_id: 91,
          web_url: `${projectUrl}/-/merge_requests/9`,
          sha: head,
          state: "opened",
          diff_refs: { base_sha: "b".repeat(40), start_sha: "c".repeat(40), head_sha: head },
        });
      }
      return json({
        id: "d".repeat(40),
        notes: [note(11, { id: 702, resolved: false, body: "Check this line" })],
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await run({
      action: "discussion.create_diff",
      projectUrl,
      target: "merge_request",
      iid: 9,
      body: "Check this line",
      expectedHeadSha: head,
      position: { oldPath: "src/a.ts", newPath: "src/a.ts", newLine: 4 },
    });
    expect(result).toMatchObject({ effect: { remoteId: "d".repeat(40), authorId: 11 } });
    const sentBody = fetcher.mock.calls[2]?.[1]?.body;
    if (typeof sentBody !== "string") {
      throw new Error("Expected a JSON discussion request");
    }
    const sent = JSON.parse(sentBody);
    expect(sent.position).toMatchObject({
      base_sha: "b".repeat(40),
      start_sha: "c".repeat(40),
      head_sha: head,
      new_line: 4,
    });
  });

  it("replies to an existing issue discussion under the selected author", async () => {
    const discussionId = "d".repeat(40);
    const fetcher = vi.fn(async (input: URL, init: RequestInit) => {
      if (input.pathname.includes("/projects/team%2Fapp")) {
        return json(project);
      }
      if (init.method === "GET") {
        return json({ id: discussionId, notes: [note(22)] });
      }
      return json(note(11, { id: 703, body: "Follow-up" }));
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await run({
      action: "discussion.reply",
      projectUrl,
      target: "issue",
      iid: 12,
      discussionId,
      body: "Follow-up",
    });
    expect(result).toMatchObject({ effect: { remoteId: 703, authorId: 11 } });
    expect(fetcher.mock.calls[2]?.[0].pathname).toBe(
      `/api/v4/projects/91/issues/12/discussions/${discussionId}/notes`,
    );
  });

  it("edits and deletes an own thread note at its exact discussion path, accepting stored whitespace normalization", async () => {
    const discussionId = "d".repeat(40);
    const path = `/api/v4/projects/91/issues/12/discussions/${discussionId}/notes/701`;
    let body = "Original";
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        if (input.pathname.includes("/projects/team%2Fapp")) {
          return json(project);
        }
        requests.push(init.method!);
        if (init.method === "GET") {
          expect(input.pathname).toBe(path.slice(0, -"/notes/701".length));
          return json({ id: discussionId, notes: [note(11, { body })] });
        }
        expect(input.pathname).toBe(path);
        if (init.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (init.method === "PUT") {
          body = "Edited";
        }
        return json(note(11, { body }));
      }),
    );
    expect(
      await run({
        action: "discussion.note.update",
        projectUrl,
        target: "issue",
        iid: 12,
        discussionId,
        noteId: 701,
        expectedBody: "Original",
        body: "Edited\r\n  ",
      }),
    ).toMatchObject({
      item: { body: "Edited" },
      effect: { remoteId: 701, outcome: "observed" },
    });
    expect(
      await run({
        action: "discussion.note.delete",
        projectUrl,
        target: "issue",
        iid: 12,
        discussionId,
        noteId: 701,
        expectedBody: "Edited",
      }),
    ).toMatchObject({ deletedNoteId: 701 });
    expect(requests).toEqual(["GET", "PUT", "GET", "DELETE"]);
  });

  it("does not confirm a metadata edit whose successful response left the requested field unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) =>
        input.pathname.includes("/projects/team%2Fapp") ? json(project) : json(issue()),
      ),
    );
    await expect(
      run({
        action: "issue.update",
        projectUrl,
        iid: 12,
        expectedUpdatedAt: "2026-10-27T12:00:00.000Z",
        title: "Changed",
      }),
    ).rejects.toBeInstanceOf(GitLabIssueOutcomeUnknownError);
  });

  it("exposes a next page when a full page lacks GitLab pagination headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) =>
        input.pathname.includes("/projects/team%2Fapp")
          ? json(project)
          : json(Array.from({ length: 50 }, () => issue())),
      ),
    );
    expect(await run({ action: "issue.list", projectUrl })).toMatchObject({ nextPage: 2 });
  });
});

describe("GitLab operation schema", () => {
  it("rejects ambiguous CSV labels and executable comment quick actions, while accepting literal quoted text", () => {
    expect(
      parseGitLabIssueOperation({
        action: "issue.create",
        projectUrl,
        title: "Valid",
        labels: ["a,b"],
      }),
    ).toBeUndefined();
    expect(
      parseGitLabIssueOperation({
        action: "note.create",
        projectUrl,
        target: "issue",
        iid: 12,
        body: "A comment\n/close",
      }),
    ).toBeUndefined();
    expect(
      parseGitLabIssueOperation({
        action: "note.create",
        projectUrl,
        target: "issue",
        iid: 12,
        body: "Literal command:\n> /close",
      }),
    ).toBeDefined();
  });
  it("accepts closed supported operations and rejects arbitrary targets or methods", () => {
    expect(parseGitLabIssueOperation({ action: "issue.get", projectUrl, iid: 12 })).toBeDefined();
    expect(
      parseGitLabIssueOperation({ action: "issue.get", projectUrl, iid: 12, token: "secret" }),
    ).toBeUndefined();
    expect(
      parseGitLabIssueOperation({
        action: "request",
        projectUrl,
        path: "/api/v4/user",
        method: "POST",
      }),
    ).toBeUndefined();
    expect(
      parseGitLabIssueOperation({
        action: "note.update",
        projectUrl,
        target: "issue",
        iid: 12,
        noteId: 2,
        body: "new",
      }),
    ).toBeUndefined();
  });
});

it("unassigns a milestone using GitLab's zero sentinel and confirms the cleared result", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === "/api/v4/projects/team%2Fapp") {
        return json(project);
      }
      if (init.method === "GET") {
        return json(issue({ milestone: { id: 31 } }));
      }
      expect(JSON.parse(typeof init.body === "string" ? init.body : "{}")).toEqual({
        milestone_id: 0,
      });
      return json(issue({ milestone: null }));
    }),
  );
  expect(
    await run({
      action: "issue.update",
      projectUrl,
      iid: 12,
      expectedUpdatedAt: "2026-10-27T12:00:00.000Z",
      milestoneId: null,
    }),
  ).toMatchObject({ item: { milestoneId: null } });
});
