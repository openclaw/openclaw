import { z } from "zod";
import type { createGitHubPublicationJsonReader } from "./github-publication-json-read.js";

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const contributor = z.object({
  user: z.object({ databaseId: z.number().int().positive().nullable() }).nullable(),
});
const authors = z.object({ nodes: z.array(contributor), pageInfo });
const commitSchema = z.object({ id: z.string(), authors, committer: contributor.nullable() });
const pullRequestResponse = z.object({
  errors: z.never().optional(),
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: z.string(),
        commits: z.object({ nodes: z.array(z.object({ commit: commitSchema })), pageInfo }),
      }),
    }),
  }),
});
const authorsResponse = z.object({
  errors: z.never().optional(),
  data: z.object({ node: z.object({ authors }) }),
});
const authorsSelection = `authors(first: 100, after: $authorCursor) {
  nodes { user { databaseId } }
  pageInfo { hasNextPage endCursor }
}`;

/** Credit on the remote PR grants continuation, not local trailers or PR-body mentions. */
export async function findGitHubPullRequestContributor(params: {
  read: ReturnType<typeof createGitHubPublicationJsonReader>;
  repository: string;
  number: number;
  headCommit: string;
  accountIds: readonly number[];
}): Promise<number | undefined> {
  const [owner, name] = params.repository.split("/");
  const linked = (value: z.infer<typeof contributor> | null) => {
    const id = value?.user?.databaseId;
    return typeof id === "number" && params.accountIds.includes(id) ? id : undefined;
  };
  let after: string | null = null;
  do {
    const parsed = pullRequestResponse.safeParse(
      await params.read("graphql", {
        query: `query($owner: String!, $name: String!, $number: Int!, $after: String, $authorCursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            headRefOid
            commits(first: 100, after: $after) {
              nodes { commit { id ${authorsSelection} committer { user { databaseId } } } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
        variables: { owner, name, number: params.number, after, authorCursor: null },
      }),
    );
    if (!parsed.success) {
      return undefined;
    }
    const pr = parsed.data.data.repository.pullRequest;
    // Never combine credit from a different head with the branch being admitted.
    if (pr.headRefOid !== params.headCommit) {
      return undefined;
    }
    for (const { commit } of pr.commits.nodes) {
      const committer = linked(commit.committer);
      if (committer !== undefined) {
        return committer;
      }
      let page = commit.authors;
      let authorCursor: string | null = null;
      for (;;) {
        for (const author of page.nodes) {
          const id = linked(author);
          if (id !== undefined) {
            return id;
          }
        }
        const next = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        if (!next || next === authorCursor) {
          break;
        }
        authorCursor = next;
        const more = authorsResponse.safeParse(
          await params.read("graphql", {
            query: `query($id: ID!, $authorCursor: String) {
            node(id: $id) { ... on Commit { ${authorsSelection} } }
          }`,
            variables: { id: commit.id, authorCursor },
          }),
        );
        if (!more.success) {
          return undefined;
        }
        page = more.data.data.node.authors;
      }
    }
    const next = pr.commits.pageInfo.hasNextPage ? pr.commits.pageInfo.endCursor : null;
    if (!next || next === after) {
      return undefined;
    }
    after = next;
  } while (after);
  return undefined;
}
