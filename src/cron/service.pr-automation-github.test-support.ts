import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished, vi } from "vitest";
import * as publicationIdentity from "../agents/github-tool-identity.js";
import * as publicationTransport from "../gateway/github-publication-git-transport.js";

export function createNativeGitHubReadFixture(branch: string) {
  const repository = {
    id: 10,
    full_name: "fixture-org/fixture-repo",
    private: false,
    permissions: { push: true },
    archived: false,
    default_branch: "main",
    fork: false,
    owner: { type: "Organization" },
  };
  const pr = {
    number: 41,
    node_id: "PR_fixture_41",
    title: "Repair fixture",
    body: "",
    mergeable: true,
    mergeable_state: "clean",
    merge_commit_sha: null,
    html_url: "https://github.com/fixture-org/fixture-repo/pull/41",
    user: { id: 42, login: "publisher", type: "User" },
    state: "open",
    draft: false,
    merged: false,
    maintainer_can_modify: true,
    base: { repo: repository, ref: "main", sha: "b".repeat(40) },
    head: { repo: repository, ref: branch, sha: "a".repeat(40) },
  };
  const connection = <T>(values: T[], cursor: string | null = null, first = values.length) => {
    const start = cursor === null ? 0 : Number(cursor);
    const end = Math.min(values.length, start + first);
    return {
      nodes: values.slice(start, end),
      totalCount: values.length,
      pageInfo: {
        hasPreviousPage: start > 0,
        hasNextPage: end < values.length,
        endCursor: String(end),
      },
    };
  };
  const finding = {
    id: "review-comment-1",
    body: "Fix the unchecked failure",
    updatedAt: "2026-11-10T10:00:00Z",
    authorAssociation: "COLLABORATOR",
    author: { login: "reviewer", __typename: "User", databaseId: undefined as number | undefined },
  };
  const thread = {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    comments: connection([finding]),
  };
  const graph = {
    headRefOid: pr.head.sha,
    comments: connection<typeof finding>([]),
    reviews: connection<typeof finding>([]),
    reviewThreads: connection([thread]),
    commits: { nodes: [{ commit: { oid: pr.head.sha, statusCheckRollup: null as unknown } }] },
  };
  let readError = false;
  const reads: string[] = [];
  const nativeRead = vi
    .spyOn(publicationTransport, "runPublicationCommand")
    .mockImplementation(async (argv, options) => {
      const endpoint = expectDefined(argv[argv.indexOf("--method") + 2], "GitHub endpoint");
      reads.push(endpoint);
      const value =
        endpoint === "repos/fixture-org/fixture-repo"
          ? repository
          : endpoint.endsWith("/pulls/41") || endpoint.endsWith("/pulls/42")
            ? {
                ...pr,
                number: Number(endpoint.split("/").at(-1)),
                html_url:
                  "https://github.com/fixture-org/fixture-repo/pull/" + endpoint.split("/").at(-1),
              }
            : endpoint === "graphql"
              ? (() => {
                  const input =
                    typeof options?.input === "function" ? options.input() : options?.input;
                  const { query, variables } = JSON.parse(input?.toString() ?? "{}");
                  const page = <T>(field: string, nodes: T[]) => {
                    const first = Number(
                      query.match(new RegExp(field + "\\(first: (\\d+)"))?.[1] ?? nodes.length,
                    );
                    return connection(nodes, variables.cursor ?? null, first);
                  };
                  if (query?.includes("node(id:")) {
                    const selectedThread = graph.reviewThreads.nodes.find(
                      (t) => t.id === variables.id,
                    );
                    return {
                      data: {
                        node: selectedThread
                          ? {
                              ...selectedThread,
                              comments: page("comments", selectedThread.comments.nodes),
                            }
                          : null,
                      },
                    };
                  }
                  const nodes = query?.includes("nodes(ids:")
                    ? {
                        nodes: variables.ids.map((id: string) => {
                          if (id === thread.id) {
                            return { id, isResolved: thread.isResolved };
                          }
                          const selectedThread = graph.reviewThreads.nodes.find((t) => t.id === id);
                          if (selectedThread) {
                            return { id, isResolved: selectedThread.isResolved };
                          }
                          const item = [
                            ...graph.comments.nodes,
                            ...graph.reviews.nodes,
                            ...graph.reviewThreads.nodes.flatMap((t) => t.comments.nodes),
                          ].find((candidate) => candidate.id === id);
                          return item
                            ? {
                                id: item.id,
                                body: item.body,
                                updatedAt: item.updatedAt,
                                authorAssociation: item.authorAssociation,
                                author: item.author,
                                pullRequest: {
                                  number: pr.number,
                                  repository: { nameWithOwner: repository.full_name },
                                },
                              }
                            : null;
                        }),
                      }
                    : {};
                  return {
                    data: {
                      ...nodes,
                      repository: {
                        pullRequest: {
                          ...graph,
                          comments: page("comments", graph.comments.nodes),
                          reviews: page("reviews", graph.reviews.nodes),
                          reviewThreads: page("reviewThreads", graph.reviewThreads.nodes),
                        },
                      },
                    },
                  };
                })()
              : undefined;
      return {
        code: readError || value === undefined ? 1 : 0,
        stdout: Buffer.from(value === undefined ? "" : JSON.stringify(value)),
        stderr: Buffer.alloc(0),
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
  const identity = vi
    .spyOn(publicationIdentity, "prepareGitHubPublicationIdentity")
    .mockResolvedValue({
      source: "system-detected",
      host: "github.com",
      account: { accountId: 42, login: "publisher", avatarUrl: null },
      env: {},
    });
  onTestFinished(() => {
    nativeRead.mockRestore();
    identity.mockRestore();
  });
  return {
    repository,
    pr,
    graph,
    finding,
    thread,
    reads,
    connection,
    nativeRead,
    identity,
    failRead: (fail: boolean) => {
      readError = fail;
    },
  };
}
