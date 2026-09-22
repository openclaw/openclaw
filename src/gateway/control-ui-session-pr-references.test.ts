import { copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  appendTranscriptMessage,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
  type SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.js";
import * as transcriptSearch from "../config/sessions/session-transcript-search.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { loadSessionPullRequestReferences } from "./control-ui-session-pr-references.js";
import { loadControlUiSessionPullRequests } from "./control-ui-session-prs.js";
import { githubJson, pullListItem, requestUrl } from "./control-ui-session-prs.test-support.js";
import * as transcriptReaders from "./session-transcript-readers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repository = { owner: "openclaw", repo: "openclaw" };
const pr = (number: number) => `https://github.com/openclaw/openclaw/pull/${number}`;
const text = (value: string) => [{ type: "text", text: value }];

describe("session pull request references", () => {
  let scope: SessionTranscriptReadScope & {
    agentId: string;
    sessionKey: string;
    storePath: string;
  };
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "GH_TOKEN", "GITHUB_TOKEN"]);
    const stateDir = tempDirs.make("openclaw-session-pr-references-");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("GH_TOKEN", "");
    setTestEnvValue("GITHUB_TOKEN", "");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const config = { session: { store: storePath }, agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config, config);
    scope = {
      agentId: "main",
      sessionId: "session-pr-references",
      sessionKey: "agent:main:pr-references",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    envSnapshot.restore();
  });

  async function writeMessages(messages: Array<Record<string, unknown>>) {
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      ...messages.map((message, index) => ({
        type: "message",
        id: `message-${index}`,
        parentId: index > 0 ? `message-${index - 1}` : null,
        message,
      })),
    ]);
  }

  it("shares unchanged transcript searches while keeping append and rewrite results fresh", async () => {
    await writeMessages([{ role: "assistant", content: text(pr(300)) }]);
    const search = vi.spyOn(transcriptSearch, "searchSessionTranscripts");
    const first = await Promise.all([
      loadSessionPullRequestReferences(scope, repository),
      loadSessionPullRequestReferences(scope, repository),
    ]);
    expect(first).toEqual([[300], [300]]);
    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([300]);
    expect(search).toHaveBeenCalledTimes(1);

    await appendTranscriptMessage(scope, {
      message: { role: "assistant", content: text(pr(301)) },
    });
    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([301, 300]);
    expect(search).toHaveBeenCalledTimes(2);

    await writeMessages([{ role: "assistant", content: text(pr(302)) }]);
    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([302]);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("reads PR identity without decoding saved prompt payloads", async () => {
    await writeMessages([{ role: "assistant", content: text(pr(300)) }]);
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      skillsSnapshot: { prompt: "unused-pr-reference-prompt".repeat(10_000), skills: [] },
    });
    const parse = vi.spyOn(JSON, "parse");
    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([300]);
    expect(parse.mock.calls.some(([json]) => json.includes("unused-pr-reference-prompt"))).toBe(
      false,
    );
  });

  it("reuses references when polling cached GitHub facts through the PR loader", async () => {
    await writeMessages([{ role: "assistant", content: text(pr(300)) }]);
    const search = vi.spyOn(transcriptSearch, "searchSessionTranscripts");
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(requestUrl(input));
      return githubJson(
        url.pathname.endsWith("/pulls")
          ? []
          : pullListItem({
              number: 300,
              html_url: pr(300),
              state: "closed",
              merged_at: "2026-09-01T00:00:00Z",
              head: { sha: "a".repeat(40), ref: "reference-poll-fixture" },
            }),
      );
    });
    const deps = {
      fetchImpl,
      resolveGitContext: async () => ({
        ...repository,
        branch: "reference-poll-fixture",
        defaultBranch: "main",
      }),
    };
    const initial = await loadControlUiSessionPullRequests(scope, deps);
    expect(initial.pullRequests.map((pull) => pull.number)).toEqual([300]);
    const fetchCount = fetchImpl.mock.calls.length;
    await expect(loadControlUiSessionPullRequests(scope, deps)).resolves.toEqual(initial);
    expect(fetchImpl).toHaveBeenCalledTimes(fetchCount);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("discards an in-flight result when transcript content is rewritten", async () => {
    await writeMessages([{ role: "assistant", content: text(pr(300)) }]);
    const read = transcriptReaders.readSessionMessageByIdAsync;
    vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync").mockImplementationOnce(
      async (...args) => {
        const result = await read(...args);
        await writeMessages([{ role: "assistant", content: text(pr(301)) }]);
        return result;
      },
    );
    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([]);
    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([301]);
  });

  it("does not reuse references from a database replaced at the same path", async () => {
    await writeMessages([{ role: "assistant", content: text(pr(300)) }]);
    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([300]);
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const replacementPath = path.join(
      tempDirs.make("openclaw-pr-reference-replacement-"),
      "agent.sqlite",
    );
    // Closing the isolated owner checkpoints its committed WAL before copying.
    closeOpenClawAgentDatabasesForTest();
    copyFileSync(database.path, replacementPath);
    const replacement = new DatabaseSync(replacementPath);
    try {
      // A replacement file may carry the same logical watermarks as the old file.
      const db = getNodeSqliteKysely<DB>(replacement);
      executeSqliteQuerySync(
        replacement,
        db
          .updateTable("transcript_events")
          .set((eb) => ({
            event_json: eb.fn<string>("replace", ["event_json", eb.val(pr(300)), eb.val(pr(301))]),
          }))
          .where("session_id", "=", scope.sessionId),
      );
      executeSqliteQuerySync(
        replacement,
        db
          .updateTable("session_transcript_fts")
          .set((eb) => ({
            text: eb.fn<string>("replace", ["text", eb.val(pr(300)), eb.val(pr(301))]),
          }))
          .where("session_id", "=", scope.sessionId),
      );
    } finally {
      replacement.close();
    }
    renameSync(replacementPath, database.path);
    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([301]);
  });

  it("finds the latest assistant PRs across tool activity without promoting other sources", async () => {
    await writeMessages([
      { role: "assistant", content: text(pr(300)) },
      { role: "assistant", content: pr(301) },
      {
        role: "assistant",
        content: text("Merged [PR](https://github.com/OpenClaw/OpenClaw/pull/302/files)."),
      },
      ...Array.from({ length: 150 }, () => ({
        role: "toolResult",
        content: text(`${pr(900)} ${"tool output ".repeat(800)}`),
      })),
      { role: "user", content: text(pr(901)) },
      {
        role: "assistant",
        content: text(pr(902)),
        openclawDisplayContent: [
          ...text(`Open: [PR](${pr(303)}). Again: ${pr(303)}#discussion_r1`),
          { type: "thinking", thinking: pr(903) },
          { type: "image", url: pr(904) },
          {
            type: "text",
            text: [
              "https://github.com/another/repo/pull/905",
              "https://github.com/openclaw/openclaw/issues/906",
              "https://github.com.evil.example/openclaw/openclaw/pull/907",
              "https://github.com@evil.example/openclaw/openclaw/pull/908",
              "https://github.com:444/openclaw/openclaw/pull/909",
              "https://github.com/openclaw/openclaw/pull/0",
              "https://github.com/openclaw/openclaw/pull/03",
            ].join(" "),
          },
        ],
      },
    ]);

    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([
      303, 302, 301,
    ]);
  });

  it("does not recover PR references hidden by a session reset", async () => {
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "old",
        parentId: null,
        message: { role: "assistant", content: text(pr(1)) },
      },
      {
        type: "reset",
        id: "reset",
        parentId: "old",
        reason: "reset",
        timestamp: "2026-09-13T00:00:00.000Z",
      },
      {
        type: "message",
        id: "new",
        parentId: "reset",
        message: { role: "assistant", content: text(pr(2)) },
      },
    ]);

    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([2]);
  });

  it("discards references when the session changes during the history read", async () => {
    await writeMessages([{ role: "assistant", content: text(pr(1)) }]);
    const read = transcriptReaders.readSessionMessageByIdAsync;
    vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync").mockImplementationOnce(
      async (...args) => {
        const page = await read(...args);
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          lifecycleRevision: "replacement",
          updatedAt: 2,
        });
        return page;
      },
    );

    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([]);
  });

  it("keeps a history read failure distinct from an empty reference list", async () => {
    await writeMessages([{ role: "assistant", content: text(pr(1)) }]);
    vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync").mockRejectedValueOnce(
      new Error("history unavailable"),
    );

    await expect(loadSessionPullRequestReferences(scope, repository)).rejects.toThrow(
      "history unavailable",
    );
    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([1]);
  });

  it("bounds total canonical payload hydration while retaining the newest references", async () => {
    await writeMessages([
      { role: "assistant", content: text(`${pr(1)} ${"x".repeat(80 * 1024)}`) },
      { role: "assistant", content: text(`${pr(2)} ${"x".repeat(80 * 1024)}`) },
      { role: "assistant", content: text(`${pr(3)} ${"x".repeat(150 * 1024)}`) },
    ]);

    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([2]);
  });
});
