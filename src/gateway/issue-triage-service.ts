import { randomUUID } from "node:crypto";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import {
  ISSUE_TRIAGE_COMMENT_MARKER,
  type IssueTriageIssue,
  type IssueTriageService,
} from "./issue-triage.js";

const GITHUB_API = "https://api.github.com";
const DEFAULT_TRIAGE_TIMEOUT_SECONDS = 120;

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error("invalid repo");
  }
  return { owner, name };
}

function resolveGithubToken(config: OpenClawConfig): string | undefined {
  const envName = config.hooks?.issueTriage?.githubTokenEnv?.trim();
  if (envName) {
    return process.env[envName]?.trim() || undefined;
  }
  return (
    process.env.OPENCLAW_ISSUE_TRIAGE_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    undefined
  );
}

function normalizeGithubLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => {
      if (typeof label === "string") {
        return label.trim();
      }
      if (label && typeof label === "object") {
        const name = (label as { name?: unknown }).name;
        return typeof name === "string" ? name.trim() : "";
      }
      return "";
    })
    .filter(Boolean);
}

async function githubJson<T>(params: {
  token: string;
  path: string;
  method?: string;
  body?: unknown;
}): Promise<T> {
  const response = await fetch(`${GITHUB_API}${params.path}`, {
    method: params.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
      "User-Agent": "OpenClaw-Issue-Triage",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: params.body === undefined ? undefined : JSON.stringify(params.body),
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function buildClassifierPrompt(issue: IssueTriageIssue): string {
  return `You are OpenClaw's GitHub issue triage classifier.

Decide whether this issue should be delegated to an automatic code-changing PR workflow or declined.

Return ONLY a JSON object with this exact shape:
{"decision":"delegate"|"close","reason":"one-line reason","details":"2-4 sentences for maintainers"}

Decision guidance:
- delegate: actionable bug/feature/change request with enough reproduction, scope, or implementation clue for an agent to attempt a PR.
- close: duplicate, support question, vague/insufficient info, won't-fix, policy/product decision, not code-changing, spam, or unsafe.
- If uncertain or missing key information, choose close.

Issue:
repo: ${issue.repo}
number: ${issue.number}
title: ${issue.title}
url: ${issue.html_url ?? ""}
labels: ${issue.labels.join(", ") || "(none)"}
state: ${issue.state ?? "unknown"}
locked: ${issue.locked === true ? "true" : "false"}
body_preview:
${issue.body_preview ?? ""}`;
}

async function classifyWithOpenClawAgent(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  issue: IssueTriageIssue;
}): Promise<string> {
  const triageConfig = params.cfg.hooks?.issueTriage;
  const jobId = randomUUID();
  const now = Date.now();
  const message = buildClassifierPrompt(params.issue);
  const job: CronJob = {
    id: jobId,
    agentId: triageConfig?.agentId,
    name: `Issue triage ${params.issue.repo}#${params.issue.number}`,
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message,
      model: triageConfig?.model,
      thinking: triageConfig?.thinking,
      timeoutSeconds: triageConfig?.timeoutSeconds ?? DEFAULT_TRIAGE_TIMEOUT_SECONDS,
      externalContentSource: "webhook",
    },
    delivery: { mode: "none" },
    state: { nextRunAtMs: now },
  };
  const { runCronIsolatedAgentTurn } = await import("../cron/isolated-agent.js");
  const result = await runCronIsolatedAgentTurn({
    cfg: params.cfg,
    deps: params.deps,
    job,
    message,
    sessionKey: `hook:issue-triage:${params.issue.repo}#${params.issue.number}`,
    lane: "hook:issue-triage",
  });
  if (result.status !== "ok") {
    throw new Error(result.error ?? result.summary ?? "classifier failed");
  }
  return result.outputText ?? result.summary ?? "";
}

export function createIssueTriageService(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
}): IssueTriageService | undefined {
  if (params.cfg.hooks?.issueTriage?.enabled !== true) {
    return undefined;
  }
  const token = resolveGithubToken(params.cfg);
  if (!token) {
    return undefined;
  }

  return {
    async getIssue(repo, issueNumber) {
      const { owner, name } = splitRepo(repo);
      const issue = await githubJson<Record<string, unknown>>({
        token,
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${issueNumber}`,
      });
      return {
        repo,
        number: issueNumber,
        title: typeof issue.title === "string" ? issue.title : "(untitled)",
        html_url: typeof issue.html_url === "string" ? issue.html_url : undefined,
        labels: normalizeGithubLabels(issue.labels),
        body_preview: typeof issue.body === "string" ? issue.body.slice(0, 4_000) : undefined,
        state: typeof issue.state === "string" ? issue.state.toLowerCase() : undefined,
        locked: issue.locked === true,
      };
    },
    async classifyIssue(issue) {
      return await classifyWithOpenClawAgent({ cfg: params.cfg, deps: params.deps, issue });
    },
    async addLabels(repo, issueNumber, labels) {
      const { owner, name } = splitRepo(repo);
      await githubJson({
        token,
        method: "POST",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${issueNumber}/labels`,
        body: { labels },
      });
    },
    async createComment(repo, issueNumber, body) {
      const { owner, name } = splitRepo(repo);
      await githubJson({
        token,
        method: "POST",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${issueNumber}/comments`,
        body: { body },
      });
    },
    async hasExistingTriageComment(repo, issueNumber) {
      const { owner, name } = splitRepo(repo);
      const comments = await githubJson<Array<Record<string, unknown>>>({
        token,
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${issueNumber}/comments?per_page=100`,
      });
      return comments.some(
        (comment) =>
          typeof comment.body === "string" && comment.body.includes(ISSUE_TRIAGE_COMMENT_MARKER),
      );
    },
  };
}
