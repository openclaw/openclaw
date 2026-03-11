import type { LinearIssueRef } from "./types.js";

const LINEAR_URL = "https://api.linear.app/graphql";

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

export class LinearClient {
  constructor(private readonly apiKey: string) {}

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
    const response = await fetch(LINEAR_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await response.json()) as GraphqlResponse<T>;
    if (!response.ok || json.errors?.length) {
      const message = json.errors?.map((error) => error.message).join("; ") || response.statusText;
      throw new Error(`Linear API request failed: ${message}`);
    }
    if (!json.data) {
      throw new Error("Linear API returned no data");
    }
    return json.data;
  }

  async listTeamIssues(teamKey: string, limit = 50) {
    const data = await this.graphql<{
      issues: {
        nodes: Array<{
          id: string;
          identifier: string;
          title: string;
          description: string | null;
          url: string;
          priority: number;
          createdAt: string;
          updatedAt: string;
          state: { id: string; name: string; type: string };
          labels: { nodes: Array<{ name: string }> };
          project: { name: string } | null;
        }>;
      };
    }>(
      `
        query TeamIssues($teamKey: String!, $limit: Int!) {
          issues(first: $limit, filter: { team: { key: { eq: $teamKey } } }) {
            nodes {
              id
              identifier
              title
              description
              url
              priority
              createdAt
              updatedAt
              state { id name type }
              labels { nodes { name } }
              project { name }
            }
          }
        }
      `,
      { teamKey, limit },
    );
    return data.issues.nodes.map(
      (issue) =>
        ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description ?? "",
          url: issue.url,
          priority: issue.priority,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          state: issue.state,
          labels: issue.labels.nodes.map((label) => label.name),
          projectName: issue.project?.name ?? null,
        }) satisfies LinearIssueRef,
    );
  }

  async getIssueByIdentifier(teamKey: string, identifier: string, limit = 100) {
    const issues = await this.listTeamIssues(teamKey, limit);
    const issue = issues.find(
      (candidate) => candidate.identifier.toUpperCase() === identifier.toUpperCase(),
    );
    if (!issue) {
      throw new Error(`Linear issue not found: ${identifier}`);
    }
    return issue;
  }
}

export function requireLinearApiKey() {
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is required for operator intake");
  }
  return apiKey;
}

export function extractNotionUrlsFromText(text: string) {
  const notionHost = "(?:[\\w-]+\\.)?notion\\.(?:so|site)";
  const urls = new Set<string>();
  const markdownLinkPattern = new RegExp(
    `\\[[^\\]]*]\\((?:<)?(https?:\\/\\/${notionHost}\\/[^)\\s>\\]]+)(?:>)?\\)`,
    "gi",
  );
  const plainUrlPattern = new RegExp(`https?:\\/\\/${notionHost}\\/[^\\s)\\]>,]+`, "gi");

  const normalize = (value: string) => value.replace(/^<+/, "").replace(/[)>.,>\]]+$/, "");

  for (const match of text.matchAll(markdownLinkPattern)) {
    const url = match[1]?.trim();
    if (url) {
      urls.add(normalize(url));
    }
  }

  for (const match of text.matchAll(plainUrlPattern)) {
    const url = match[0]?.trim();
    if (url) {
      urls.add(normalize(url));
    }
  }

  return Array.from(urls);
}
