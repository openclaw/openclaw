import type { GitLabIssueOperation } from "@openclaw/gateway-protocol/gitlab-issues";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeGitLabIssueOperation,
  GitLabIssueOutcomeUnknownError,
} from "./gitlab-issues-api.js";
import type { PersonalGitLabCredential } from "./gitlab-personal-oauth.js";

const issuer = "https://gitlab.example.test";
const projectUrl = `${issuer}/team/app`;
const targetProjectUrl = `${issuer}/team/other`;
const project = { id: 91, path_with_namespace: "team/app", web_url: projectUrl };
const targetProject = { id: 92, path_with_namespace: "team/other", web_url: targetProjectUrl };
const issue = (projectId = 91, iid = 12, fields: Record<string, unknown> = {}) => ({
  id: projectId === 91 ? 501 : 502,
  iid,
  project_id: projectId,
  web_url: `${projectId === 91 ? projectUrl : targetProjectUrl}/-/issues/${iid}`,
  title: "Investigate retry",
  description: "Original description",
  state: "opened",
  updated_at: "2026-10-27T12:00:00.000Z",
  author: { id: 11 },
  labels: ["bug"],
  assignees: [],
  milestone: null,
  due_date: null,
  ...fields,
});
const note = (body: string, fields: Record<string, unknown> = {}) => ({
  id: 701,
  body,
  author: { id: 11 },
  created_at: "2026-10-27T12:01:00.000Z",
  updated_at: "2026-10-27T12:01:00.000Z",
  system: false,
  ...fields,
});
const stats = (spent: number) => ({
  human_time_estimate: null,
  human_total_time_spent: `${spent / 3600}h`,
  time_estimate: 0,
  total_time_spent: spent,
});
const json = (value: unknown, headers?: HeadersInit) => Response.json(value, { headers });
const credential: PersonalGitLabCredential = {
  account: {
    accountId: 11,
    login: "alice",
    name: "Synthetic",
    commitEmail: "synthetic@example.test",
    issuer,
  },
  generation: "synthetic-generation",
  assertCurrent: () => undefined,
  withToken: async (useToken) => await useToken("alice-secret"),
};
const run = (
  operation: GitLabIssueOperation,
  assertProjectAllowed: (id: number) => void = () => undefined,
) =>
  executeGitLabIssueOperation({
    operation,
    credential,
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
    assertProjectAllowed,
  });

afterEach(() => vi.unstubAllGlobals());

describe("requester issue workflows against documented GitLab response shapes", () => {
  it("carries a selected-human issue from list and metadata edit through close, reopen, and notes", async () => {
    let current = issue();
    const rootNotes: ReturnType<typeof note>[] = [];
    const writes: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        if (input.pathname === "/api/v4/projects/team%2Fapp") {
          return json(project);
        }
        if (input.pathname === "/api/v4/projects/91/issues" && init.method === "GET") {
          return json([current], { "x-next-page": "2" });
        }
        if (input.pathname === "/api/v4/projects/91/issues/12" && init.method === "GET") {
          return json(current);
        }
        if (input.pathname === "/api/v4/projects/91/issues/12" && init.method === "PUT") {
          const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<
            string,
            unknown
          >;
          writes.push({ path: input.pathname, body });
          const next = String(writes.length);
          current = issue(91, 12, {
            ...current,
            title: body.title ?? current.title,
            labels: body.add_labels ? ["bug", "priority"] : current.labels,
            state:
              body.state_event === "close"
                ? "closed"
                : body.state_event === "reopen"
                  ? "opened"
                  : current.state,
            updated_at: next,
          });
          return json(current);
        }
        if (input.pathname === "/api/v4/projects/91/issues/12/notes" && init.method === "POST") {
          const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
            body: string;
          };
          rootNotes.push(note(body.body));
          return json(rootNotes.at(-1));
        }
        if (input.pathname === "/api/v4/projects/91/issues/12/notes" && init.method === "GET") {
          return json(rootNotes, { "x-next-page": "2" });
        }
        throw new Error(`Unexpected ${init.method} ${input.pathname}`);
      }),
    );
    expect(await run({ action: "issue.list", projectUrl, page: 1 })).toMatchObject({
      nextPage: 2,
      items: [{ iid: 12 }],
    });
    expect(await run({ action: "issue.get", projectUrl, iid: 12 })).toMatchObject({
      item: { description: "Original description" },
    });
    const edited = await run({
      action: "issue.update",
      projectUrl,
      iid: 12,
      expectedUpdatedAt: "2026-10-27T12:00:00.000Z",
      title: "Investigate retry deeply",
      addLabels: ["priority"],
    });
    expect(edited).toMatchObject({
      actor: { accountId: 11 },
      item: {
        title: "Investigate retry deeply",
        description: "Original description",
        labels: ["bug", "priority"],
        updatedAt: "1",
      },
    });
    expect(writes[0]?.body).toEqual({ title: "Investigate retry deeply", add_labels: "priority" });
    expect(
      await run({ action: "issue.close", projectUrl, iid: 12, expectedUpdatedAt: "1" }),
    ).toMatchObject({ item: { state: "closed", updatedAt: "2" } });
    expect(
      await run({ action: "issue.reopen", projectUrl, iid: 12, expectedUpdatedAt: "2" }),
    ).toMatchObject({ item: { state: "opened", updatedAt: "3" } });
    expect(
      await run({
        action: "note.create",
        projectUrl,
        target: "issue",
        iid: 12,
        body: "Retested with Alice's account",
      }),
    ).toMatchObject({ effect: { authorId: 11, remoteId: 701 } });
    expect(await run({ action: "note.list", projectUrl, target: "issue", iid: 12 })).toMatchObject({
      nextPage: 2,
      items: [{ id: 701, authorId: 11 }],
    });
  });

  it("creates and resolves a merge-request thread, then reopens it under current authority", async () => {
    const discussionId = "d".repeat(40);
    let resolved = false;
    const requestBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        if (input.pathname === "/api/v4/projects/team%2Fapp") {
          return json(project);
        }
        if (
          input.pathname === "/api/v4/projects/91/merge_requests/9/discussions" &&
          init.method === "POST"
        ) {
          const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<
            string,
            unknown
          >;
          requestBodies.push(body);
          return json({ id: discussionId, notes: [note(String(body.body), { resolved })] });
        }
        if (input.pathname === `/api/v4/projects/91/merge_requests/9/discussions/${discussionId}`) {
          if (init.method === "PUT") {
            const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
              resolved: boolean;
            };
            requestBodies.push(body);
            resolved = body.resolved;
          }
          return json({ id: discussionId, notes: [note("Review this case", { resolved })] });
        }
        throw new Error(`Unexpected ${init.method} ${input.pathname}`);
      }),
    );
    expect(
      await run({
        action: "discussion.create",
        projectUrl,
        target: "merge_request",
        iid: 9,
        body: "Review this case",
      }),
    ).toMatchObject({ effect: { remoteId: discussionId, authorId: 11 } });
    expect(
      await run({
        action: "discussion.resolve",
        projectUrl,
        target: "merge_request",
        iid: 9,
        discussionId,
        expectedResolved: false,
      }),
    ).toMatchObject({ item: { resolved: true } });
    expect(
      await run({
        action: "discussion.reopen",
        projectUrl,
        target: "merge_request",
        iid: 9,
        discussionId,
        expectedResolved: true,
      }),
    ).toMatchObject({ item: { resolved: false } });
    expect(requestBodies).toEqual([
      { body: "Review this case" },
      { resolved: true },
      { resolved: false },
    ]);
  });

  it.each(["issues", "work_items"])(
    "lists and creates %s links only after both canonical projects and issues pass live policy",
    async (route) => {
      const calls: { path: string; method: string; body?: unknown; auth: string | null }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: URL, init: RequestInit) => {
          const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
          calls.push({
            path: input.pathname,
            method: init.method ?? "GET",
            body,
            auth: new Headers(init.headers).get("authorization"),
          });
          if (input.pathname === "/api/v4/projects/team%2Fapp") {
            return json(project);
          }
          if (
            input.pathname === "/api/v4/projects/team%2Fother" ||
            input.pathname === "/api/v4/projects/92"
          ) {
            return json(targetProject);
          }
          if (input.pathname === "/api/v4/projects/91/issues/12") {
            return json(issue());
          }
          if (input.pathname === "/api/v4/projects/92/issues/5") {
            return json(issue(92, 5));
          }
          if (input.pathname === "/api/v4/projects/91/issues/12/links" && init.method === "POST") {
            return json({
              id: 7,
              source_issue: { id: 501, iid: 12, project_id: 91 },
              target_issue: { id: 502, iid: 5, project_id: 92 },
              link_type: "blocks",
            });
          }
          if (input.pathname === "/api/v4/projects/91/issues/12/links" && init.method === "GET") {
            return json([
              {
                id: 502,
                iid: 5,
                project_id: 92,
                web_url: `${targetProjectUrl}/-/${route}/5`,
                issue_link_id: 7,
                link_type: "blocks",
                title: "Investigate retry",
                state: "opened",
              },
            ]);
          }
          throw new Error(`Unexpected ${init.method} ${input.pathname}`);
        }),
      );
      const allowed: number[] = [];
      const policy = (id: number) => {
        allowed.push(id);
        expect([91, 92]).toContain(id);
      };
      expect(
        await run(
          {
            action: "issue.link.create",
            projectUrl,
            iid: 12,
            targetProjectUrl,
            targetIid: 5,
            relation: "blocks",
          },
          policy,
        ),
      ).toMatchObject({
        actor: { accountId: 11 },
        item: {
          sourceIssueId: 501,
          targetIssueId: 502,
          targetProjectId: 92,
          linkId: 7,
          relation: "blocks",
        },
        effect: { remoteId: 7 },
      });
      expect(await run({ action: "issue.link.list", projectUrl, iid: 12 }, policy)).toMatchObject({
        items: [{ targetIssueId: 502, targetProjectId: 92, targetIid: 5, linkId: 7 }],
      });
      expect(allowed).toContain(92);
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        target_project_id: 92,
        target_issue_iid: 5,
        link_type: "blocks",
      });
      expect(calls.every((call) => call.auth === "Bearer alice-secret")).toBe(true);
    },
  );

  it("rejects foreign linked origins before fetch and hides links excluded by target policy", async () => {
    const fetcher = vi.fn(async (input: URL) => {
      if (input.pathname === "/api/v4/projects/team%2Fapp") {
        return json(project);
      }
      if (input.pathname === "/api/v4/projects/91/issues/12") {
        return json(issue());
      }
      if (input.pathname === "/api/v4/projects/91/issues/12/links") {
        return json([
          {
            id: 502,
            iid: 5,
            project_id: 92,
            web_url: `${targetProjectUrl}/-/issues/5`,
            issue_link_id: 7,
            link_type: "blocks",
          },
        ]);
      }
      throw new Error("Target project should not be fetched");
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      run({
        action: "issue.link.create",
        projectUrl,
        iid: 12,
        targetProjectUrl: "https://other.example.test/team/other",
        targetIid: 5,
        relation: "blocks",
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      run({ action: "issue.link.list", projectUrl, iid: 12 }, (id) => {
        if (id === 92) {
          throw new Error("target project denied");
        }
      }),
    ).rejects.toThrow("target project denied");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("retains target-project policy through the final issue lookup before linking", async () => {
    let targetAllowed = true;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        calls.push(`${init.method} ${input.pathname}`);
        if (input.pathname === "/api/v4/projects/team%2Fapp") {
          return json(project);
        }
        if (input.pathname === "/api/v4/projects/91/issues/12") {
          return json(issue());
        }
        if (input.pathname === "/api/v4/projects/team%2Fother") {
          return json(targetProject);
        }
        if (input.pathname === "/api/v4/projects/92/issues/5") {
          targetAllowed = false;
          return json(issue(92, 5));
        }
        throw new Error("A link write must not be dispatched");
      }),
    );
    await expect(
      run(
        {
          action: "issue.link.create",
          projectUrl,
          iid: 12,
          targetProjectUrl,
          targetIid: 5,
          relation: "blocks",
        },
        (id) => {
          if (id === 92 && !targetAllowed) {
            throw new Error("target policy revoked");
          }
        },
      ),
    ).rejects.toThrow("target policy revoked");
    expect(calls.some((call) => call.startsWith("POST "))).toBe(false);
  });

  it("adds native time as the selected human and reports only actual aggregate totals", async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        calls.push({
          path: input.pathname,
          method: init.method ?? "GET",
          body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        });
        if (input.pathname === "/api/v4/projects/team%2Fapp") {
          return json(project);
        }
        if (input.pathname === "/api/v4/projects/91/issues/12") {
          return json(issue());
        }
        if (input.pathname.endsWith("/time_stats")) {
          return json(stats(3600));
        }
        if (input.pathname.endsWith("/add_spent_time")) {
          return json(stats(5400));
        }
        throw new Error("Unexpected time request");
      }),
    );
    expect(await run({ action: "issue.time.get", projectUrl, iid: 12 })).toMatchObject({
      item: { issueId: 501, totalTimeSpentSeconds: 3600 },
    });
    const added = await run({
      action: "issue.time.add",
      projectUrl,
      iid: 12,
      duration: "30m",
      summary: "Investigated retry",
    });
    expect(added).toMatchObject({
      actor: { accountId: 11 },
      item: { issueId: 501, totalTimeSpentSeconds: 5400 },
    });
    expect(added.effect).toBeUndefined();
    expect(calls.find((call) => call.path.endsWith("/add_spent_time"))?.body).toEqual({
      duration: "30m",
      summary: "Investigated retry",
    });
  });

  it("treats a lost link/time write response as unknown and never retries it", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        calls.push(`${init.method} ${input.pathname}`);
        if (input.pathname === "/api/v4/projects/team%2Fapp") {
          return json(project);
        }
        if (input.pathname === "/api/v4/projects/team%2Fother") {
          return json(targetProject);
        }
        if (input.pathname === "/api/v4/projects/91/issues/12") {
          return json(issue());
        }
        if (input.pathname === "/api/v4/projects/92/issues/5") {
          return json(issue(92, 5));
        }
        if (input.pathname.endsWith("/time_stats")) {
          return json(stats(3600));
        }
        throw new Error("connection lost after dispatch");
      }),
    );
    await expect(
      run({
        action: "issue.link.create",
        projectUrl,
        iid: 12,
        targetProjectUrl,
        targetIid: 5,
        relation: "relates_to",
      }),
    ).rejects.toBeInstanceOf(GitLabIssueOutcomeUnknownError);
    await expect(
      run({ action: "issue.time.add", projectUrl, iid: 12, duration: "30m" }),
    ).rejects.toBeInstanceOf(GitLabIssueOutcomeUnknownError);
    expect(calls.filter((call) => call.startsWith("POST "))).toHaveLength(2);
  });
});

it("discovers assignment metadata through the same requester-bound project", async () => {
  const fetcher = vi.fn(async (url: URL) => {
    const path = url.pathname;
    if (path === "/api/v4/projects/team%2Fapp") {
      return json(project);
    }
    if (path.endsWith("/members/all")) {
      return json([{ id: 11, username: "alice", name: "Alice", email: "private@example.test" }]);
    }
    if (path.endsWith("/labels")) {
      return json([{ id: 21, name: "bug", description: "Defect" }]);
    }
    if (path.endsWith("/milestones")) {
      return json([{ id: 31, title: "Release", state: "active" }]);
    }
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetcher);
  const allowed = vi.fn();
  expect(
    (await run({ action: "project.members", projectUrl, query: "alice" }, allowed)).items,
  ).toEqual([{ id: 11, username: "alice", name: "Alice" }]);
  expect((await run({ action: "project.labels", projectUrl }, allowed)).items).toEqual([
    { id: 21, name: "bug", description: "Defect" },
  ]);
  expect((await run({ action: "project.milestones", projectUrl }, allowed)).items).toEqual([
    { id: 31, title: "Release", state: "active" },
  ]);
  expect(allowed).toHaveBeenCalledWith(91);
  expect(fetcher.mock.calls.some(([url]) => url.searchParams.get("query") === "alice")).toBe(true);
});
