import { afterEach, describe, expect, it } from "vitest";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildAgentRunProjectionIndex } from "../infra/agent-run-projection.js";
import type { AgentRunContext } from "../infra/agent-run-registry.types.js";
import type { ControlUiSessionPullRequestSnapshot } from "./control-ui-contract.js";
import { resolvePublicSessionCardFacts } from "./control-ui-public-session-card-facts.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

const NOW = 1_000_000;
const SESSION_KEY = "agent:main:dashboard:public-card";
const BRANCH = "feature/public-preview";
const projections: ReturnType<typeof createSessionRowProjectionFixture>[] = [];

afterEach(() => {
  for (const projection of projections.splice(0)) {
    projection.dispose();
  }
});

function fixture(entry: Partial<InternalSessionEntry> = {}, runs: AgentRunContext[] = []) {
  const cfg: OpenClawConfig = {
    agents: {
      entries: { main: { workspace: "/synthetic/workspace", identity: { name: "Build agent" } } },
    },
  };
  const rowContext = buildSessionListRowMetadataContext({
    now: NOW,
    subagentRuns: buildSubagentSessionListReadIndex(NOW, [], new Map()),
    projectedAgentRuns: buildAgentRunProjectionIndex({
      contexts: runs,
      lifecycleGeneration: "test",
    }),
  });
  const projection = createSessionRowProjectionFixture({
    cfg,
    rowContext,
    storePath: "/synthetic/sessions.sqlite",
    store: {
      [SESSION_KEY]: {
        sessionId: "public-card-session",
        updatedAt: NOW,
        status: "done",
        runtimeMs: 120_000,
        spawnedCwd: "/synthetic/worktree",
        projectId: "synthetic-project",
        worktree: { id: "synthetic-worktree", branch: BRANCH, repoRoot: "/synthetic/repository" },
        createdActor: {
          type: "human",
          source: "profile",
          id: "private-person",
          label: "Private owner",
        },
        model: "private-model",
        ...entry,
      },
    },
  });
  projections.push(projection);
  const record = projection.describe({ key: SESSION_KEY, agentId: "main" });
  if (!record) {
    throw new Error("Synthetic card session was not materialized");
  }
  return { cfg, rowContext, record, now: NOW };
}

function cachedOwner(snapshot?: ControlUiSessionPullRequestSnapshot) {
  let refreshes = 0;
  const owner: NonNullable<Parameters<typeof resolvePublicSessionCardFacts>[0]["pullRequests"]> = {
    readPrepared(_target, admitLoad) {
      if (!admitLoad || admitLoad()) {
        refreshes++;
      }
      return snapshot;
    },
  };
  return { owner, refreshes: () => refreshes };
}

describe("public session card facts", () => {
  it("keeps cold reads cache-only and omits private identity and unknown work facts", () => {
    const cached = cachedOwner();
    expect(resolvePublicSessionCardFacts({ ...fixture(), pullRequests: cached.owner })).toEqual({
      agentName: "Build agent",
      status: "Done",
      durationMinutes: 2,
      worktree: { branch: BRANCH },
    });
    expect(cached.refreshes()).toBe(0);
  });

  it("omits an unnamed agent instead of substituting the session owner", () => {
    const input = fixture();
    const agent = input.cfg.agents?.entries?.main;
    if (!agent) {
      throw new Error("Synthetic agent was not configured");
    }
    delete agent.identity;
    expect(resolvePublicSessionCardFacts(input)).toEqual({
      status: "Done",
      durationMinutes: 2,
      worktree: { branch: BRANCH },
    });
  });

  it("projects only the selected branch's recorded work and check summary", () => {
    const cached = cachedOwner({
      status: "ready",
      rateLimited: false,
      repository: { owner: "example", repo: "project" },
      branch: {
        owner: "example",
        repo: "project",
        branch: BRANCH,
        additions: 24,
        deletions: 8,
        changedFiles: 3,
      },
      pullRequests: [
        {
          owner: "example",
          repo: "project",
          number: 42,
          branch: BRANCH,
          title: "A private PR title",
          author: { login: "private-author" },
          url: "https://github.com/example/project/pull/42",
          state: "merged",
          checks: { state: "passing", passed: 8, failed: 0, running: 0, skipped: 1 },
        },
      ],
    });
    expect(resolvePublicSessionCardFacts({ ...fixture(), pullRequests: cached.owner })).toEqual({
      agentName: "Build agent",
      status: "Done",
      durationMinutes: 2,
      repoSlug: "example/project",
      worktree: {
        branch: BRANCH,
        additions: 24,
        deletions: 8,
        files: 3,
        prState: "Merged",
        checks: "8 passed · 1 skipped",
      },
    });
    expect(cached.refreshes()).toBe(0);
  });

  it("does not attribute a sibling branch's work or pull request to this session", () => {
    const cached = cachedOwner({
      status: "ready",
      rateLimited: false,
      branch: {
        owner: "other",
        repo: "project",
        branch: "other-branch",
        additions: 99,
        deletions: 2,
        changedFiles: 7,
      },
      pullRequests: [
        {
          owner: "other",
          repo: "project",
          number: 43,
          branch: "other-branch",
          title: "Sibling work",
          url: "https://github.com/other/project/pull/43",
          state: "open",
          checks: { state: "failing", passed: 0, failed: 2, running: 0, skipped: 0 },
        },
      ],
    });
    const facts = resolvePublicSessionCardFacts({ ...fixture(), pullRequests: cached.owner });
    expect(facts.worktree).toEqual({ branch: BRANCH });
    expect(facts.repoSlug).toBeUndefined();
  });

  it.each([
    ["done", "Done"],
    ["failed", "Failed"],
    ["interrupted", "Failed"],
    ["killed", "Failed"],
    ["timeout", "Failed"],
    [undefined, undefined],
  ] as const)("projects recorded %s status as %s", (status, expected) => {
    expect(resolvePublicSessionCardFacts(fixture({ status })).status).toBe(expected);
  });

  it.each([false, true])("shows a live run ahead of prior failure (queued: %s)", (queued) => {
    const input = fixture({ status: "failed" }, [
      {
        agentId: "main",
        sessionKey: SESSION_KEY,
        sessionId: "public-card-session",
        lifecycleGeneration: "test",
        projectSessionActive: true,
        ...(queued ? { capacityWaits: new Set([Symbol("queued")]) } : {}),
      },
    ]);
    expect(resolvePublicSessionCardFacts(input).status).toBe("Running");
  });
});
