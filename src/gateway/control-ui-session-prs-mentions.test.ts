import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as sessionPrRead from "./control-ui-session-pr-read.js";
import {
  githubJson,
  loadTestSessionPullRequests,
  pullListItem,
  requestUrl,
} from "./control-ui-session-prs.test-support.js";

describe("session PR mention isolation", () => {
  let state: OpenClawTestState;
  const sessionKey = "agent:main:pr-mentions";
  const scope = { agentId: "main", sessionKey, sessionId: "pr-mentions" };

  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it("retains accepted issue links from older history when GitHub identity fails", async () => {
    const issue = "https://github.com/openclaw/openclaw/issues/101";
    await appendTranscriptMessage(scope, {
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: `Read ${issue} and https://github.com/other/repository/issues/102`,
          },
        ],
      },
    });
    for (let index = 0; index < 30; index++) {
      await appendTranscriptMessage(scope, {
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Accepted update ${index}` }],
        },
      });
    }
    vi.spyOn(sessionPrRead, "prepareControlUiSessionGitHubIdentity").mockRejectedValueOnce(
      new Error("identity unavailable"),
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const snapshot = await loadTestSessionPullRequests(scope, {
      resolveGitContext: async () => ({ owner: "openclaw", repo: "openclaw", branch: "feature" }),
      fetchImpl,
    });
    expect(snapshot).toMatchObject({
      issues: [{ number: 101, url: issue }],
      pullRequests: [],
      repository: { owner: "openclaw", repo: "openclaw" },
      status: "unavailable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      await loadTestSessionPullRequests(scope, {
        resolveGitContext: async () => ({
          owner: "other",
          repo: "repository",
          branch: "main",
          defaultBranch: "main",
        }),
        fetchImpl,
      }),
    ).toMatchObject({
      issues: [{ number: 102, url: "https://github.com/other/repository/issues/102" }],
    });
  });

  it.each(["feature", "main", null])(
    "does not promote assistant links on checkout %s",
    async (branch) => {
      const workingPull = pullListItem({
        number: 41,
        html_url: "https://github.com/openclaw/openclaw/pull/41",
        state: "closed",
        merged_at: "2026-09-01T00:00:00Z",
        head: { ref: "feature", sha: "a".repeat(40) },
      });
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(requestUrl(input));
        if (url.pathname.endsWith("/pulls")) {
          return githubJson([workingPull]);
        }
        return githubJson(
          pullListItem({
            number: 42,
            html_url: "https://github.com/openclaw/openclaw/pull/42",
            state: "closed",
            merged_at: "2026-09-01T00:00:00Z",
            head: { ref: "unrelated-work", sha: "b".repeat(40) },
          }),
        );
      });
      const load = () =>
        loadTestSessionPullRequests(
          { sessionKey, refresh: true },
          {
            fetchImpl,
            resolveGitContext: async () => ({
              owner: "openclaw",
              repo: "openclaw",
              branch,
              defaultBranch: "main",
            }),
          },
        );
      const initial = await load();
      expect(initial.pullRequests.map((pull) => pull.number)).toEqual(
        branch === "feature" ? [41] : [],
      );

      await appendTranscriptMessage(scope, {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "For comparison only: https://github.com/openclaw/openclaw/pull/42",
            },
          ],
        },
      });
      const afterMention = await load();
      expect(afterMention.pullRequests).toEqual(initial.pullRequests);
      expect((await load()).pullRequests).toEqual(initial.pullRequests);
      expect(
        fetchImpl.mock.calls.every(([input]) =>
          new URL(requestUrl(input)).pathname.endsWith("/pulls"),
        ),
      ).toBe(true);
    },
  );
});
