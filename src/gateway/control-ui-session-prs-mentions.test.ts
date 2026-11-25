import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textAssistant } from "../agents/test-helpers/sparse-transcript.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  githubJson,
  loadTestSessionPullRequests,
  pullListItem,
  requestUrl,
} from "./control-ui-session-prs.test-support.js";

function mergedPull(number: number, ref: string, sha: string) {
  return pullListItem({
    number,
    html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
    state: "closed",
    merged_at: "2026-09-01T00:00:00Z",
    head: { ref, sha: sha.repeat(40) },
  });
}

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
    vi.unstubAllEnvs();
    await state.cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["feature", "main", null])(
    "does not promote assistant links on checkout %s",
    async (branch) => {
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(requestUrl(input));
        return githubJson(
          url.pathname.endsWith("/pulls")
            ? [mergedPull(41, "feature", "a")]
            : mergedPull(42, "unrelated-work", "b"),
        );
      });
      vi.stubGlobal("fetch", fetchImpl);
      const load = () =>
        loadTestSessionPullRequests(
          { sessionKey, refresh: true },
          {
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
        message: textAssistant("For comparison only: https://github.com/openclaw/openclaw/pull/42"),
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
