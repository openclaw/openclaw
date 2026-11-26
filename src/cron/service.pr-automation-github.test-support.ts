import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { onTestFinished, vi } from "vitest";
import { commandResult } from "../agents/github-identity.test-support.js";
import * as publicationIdentity from "../agents/github-tool-identity.js";
import * as publicationTransport from "../gateway/github-publication-git-transport.js";

export function createNativeGitHubReadFixture(branch: string, sourceHead: string) {
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
    mergeable: true,
    mergeable_state: "clean",
    merge_commit_sha: null,
    title: "Repair fixture",
    body: "",
    html_url: "https://github.com/fixture-org/fixture-repo/pull/41",
    user: { id: 42, login: "publisher", type: "User" },
    state: "open",
    draft: false,
    merged: false,
    maintainer_can_modify: true,
    base: { repo: repository, ref: "main", sha: sourceHead },
    head: { repo: repository, ref: branch, sha: sourceHead },
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
      options?.beforeRun?.();
      const endpoint = expectDefined(argv[argv.indexOf("--method") + 2], "GitHub endpoint");
      reads.push(endpoint);
      const respond = (value: unknown, replacer?: (key: string, value: unknown) => unknown) =>
        commandResult(JSON.stringify(value, replacer), readError || value === undefined ? 1 : 0);
      if (endpoint === "repos/fixture-org/fixture-repo") {
        return respond(repository);
      }
      if (endpoint.endsWith("/pulls/41") || endpoint.endsWith("/pulls/42")) {
        const number = Number(endpoint.split("/").at(-1));
        return respond({
          ...pr,
          number,
          html_url: "https://github.com/fixture-org/fixture-repo/pull/" + number,
        });
      }
      if (endpoint !== "graphql") {
        return respond(undefined);
      }
      const input = typeof options?.input === "function" ? options.input() : options?.input;
      const { query, variables } = JSON.parse(input?.toString() ?? "{}");
      const nodes = [
        ...graph.reviewThreads.nodes,
        thread,
        ...graph.comments.nodes,
        ...graph.reviews.nodes,
        ...graph.reviewThreads.nodes.flatMap((t) => t.comments.nodes),
      ];
      const pullRequest = {
        number: pr.number,
        repository: { nameWithOwner: repository.full_name },
      };
      const lookup = (id: string) => {
        const node = nodes.find((candidate) => candidate.id === id);
        return node ? Object.assign({}, node, { pullRequest }) : null;
      };
      const selected = query.includes("node(id:") ? lookup(variables.id) : graph;
      const data =
        selected === graph
          ? { nodes: (variables.ids ?? []).map(lookup), repository: { pullRequest: graph } }
          : { node: selected };
      // Outer and nested comments have independent cursors. Only the selected
      // owner (or the query's sole check rollup) receives the requested page.
      return respond({ data }, function (this: unknown, key, value: unknown) {
        const first =
          (this === selected || key === "contexts") &&
          query.match(new RegExp(key + "\\(first: (\\d+), after: \\$cursor"))?.[1];
        return first && isRecord(value) && Array.isArray(value.nodes) && isRecord(value.pageInfo)
          ? connection(value.nodes, variables.cursor ?? null, Number(first))
          : value;
      });
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
    checkRuns: (count = 1, conclusion = "FAILURE", app = "github-actions") => {
      const check = {
        __typename: "CheckRun",
        id: "run-1",
        name: "unit",
        status: "COMPLETED",
        conclusion,
        completedAt: "2026-11-10T10:00:00Z",
        checkSuite: { app: { slug: app }, repository: { nameWithOwner: repository.full_name } },
      };
      expectDefined(graph.commits.nodes[0], "head commit").commit.statusCheckRollup = {
        state: conclusion,
        contexts: connection([
          check,
          ...Array.from({ length: count - 1 }, (_, index) => ({
            ...check,
            id: "matrix-" + index,
            conclusion: "SUCCESS",
          })),
        ]),
      };
      return check;
    },
    nativeRead,
    identity,
    failRead: (fail: boolean) => {
      readError = fail;
    },
  };
}
