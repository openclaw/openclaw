import "../test-utils/prepare-compiled-subprocesses.js";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/index.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reportGitHubPublicationTranscript } from "./github-publication-transcript.js";

const reportFault = useSqliteWorkerFault([
  {
    name: "reject_report",
    match: /^insert into transcript_events /,
    sql: `CREATE TEMP TRIGGER reject_report BEFORE INSERT ON main.transcript_events
      WHEN json_extract(NEW.event_json, '$.type') = 'message'
      BEGIN SELECT RAISE(ABORT, 'report insert failed'); END;`,
  },
]);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function createSession(sessionId: string) {
  setRuntimeConfigSnapshot({});
  const identity = { agentId: "main", sessionKey: "agent:main:main", sessionId };
  await upsertSessionEntryCore(identity, { sessionId, updatedAt: 1 });
  return identity;
}

function failedResult(
  requestId: string,
  message = "Publication failed.",
  nextAction = "Retry.",
): SessionGitHubPublicationResult {
  return { requestId, status: "failed", code: "push_rejected", message, nextAction };
}

const publishedResult = {
  requestId: "publication-success",
  status: "published",
  repository: "example/repository",
  branch: "publication",
  url: "https://github.com/example/repository/pull/1",
  headCommit: "a".repeat(40),
} satisfies SessionGitHubPublicationResult;

function report(
  identity: Awaited<ReturnType<typeof createSession>>,
  result: SessionGitHubPublicationResult,
  markReportedAsync: (requestId: string) => Promise<void>,
) {
  return reportGitHubPublicationTranscript(
    () => import("./session-utils.js"),
    { markReportedAsync },
    { ...identity, result },
  );
}

function reportMessages(events: unknown[], requestId: string, assistantOnly = false) {
  return events.filter(
    (event) =>
      isRecord(event) &&
      event.type === "message" &&
      isRecord(event.message) &&
      (!assistantOnly || event.message.role === "assistant") &&
      event.message.responseId === `github-publication:${requestId}`,
  );
}

const rootMessage = () => ({
  type: "message",
  id: "root",
  parentId: null,
  message: { role: "user", content: "Start" },
});
function previousReport(requestId: string, id = "report", content: unknown = "Reported") {
  return {
    type: "message",
    id,
    parentId: "root",
    message: { role: "assistant", responseId: `github-publication:${requestId}`, content },
  };
}

function messageTail(
  role: "assistant" | "user",
  content: string | null,
  fields: { parentId?: string | null; appendMode?: "side" } = {},
) {
  return { type: "message", id: "tail", ...fields, message: { role, content } };
}

const reset = [{ type: "reset", id: "reset", parentId: null, reason: "reset" }];
const danglingLabel = { type: "label", id: "tail", targetId: "absent", label: "Unknown" };
const tails: Array<
  [
    label: string,
    tail: Record<string, unknown>,
    count: number,
    beforeTail?: Record<string, unknown>[],
  ]
> = [
  ["unreadable message", messageTail("assistant", null, { parentId: null }), 1],
  ["missing parent", messageTail("user", "Branch", { parentId: "absent" }), 2],
  ["parentless row", messageTail("user", "Continued"), 1],
  ["unattached label", { ...danglingLabel, parentId: null }, 1],
  ["invalid leaf control", { type: "leaf", id: "tail", parentId: "report", targetId: "absent" }, 1],
  ["side append", messageTail("user", "Side", { parentId: null, appendMode: "side" }), 1],
  ["parentless row after reset", messageTail("user", "Continued"), 2, reset],
  ["parentless dangling label after reset", danglingLabel, 2, reset],
  [
    "parentless side append after reset",
    messageTail("user", "Side", { appendMode: "side" }),
    2,
    reset,
  ],
];

describe("GitHub publication transcript reporting", () => {
  it("commits one memory-only private report before marking its publication receipt", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const session = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:incognito-publication-transcript",
        sessionId: "private-publication",
      };
      const location = {
        agentId: session.agentId,
        path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: session.agentId, env: state.env }),
      };
      await upsertSessionEntryCore(
        { ...session, env: state.env },
        {
          sessionId: session.sessionId,
          updatedAt: Date.now(),
        },
      );
      const result = { ...publishedResult, requestId: "private-result" };
      const loadRuntime = vi.fn(async () => {
        throw new Error("Private reports must not select native storage");
      });
      const markReportedAsync = vi.fn().mockResolvedValue(undefined);
      const sql = observeHostDataSql();
      try {
        await reportGitHubPublicationTranscript(
          loadRuntime,
          { markReportedAsync },
          { ...session, result },
        );
        await reportGitHubPublicationTranscript(
          loadRuntime,
          { markReportedAsync },
          { ...session, result },
        );
        const events = await loadTranscriptEvents({
          ...session,
          storePath: location.path,
          env: state.env,
        });
        const reports = reportMessages(events, result.requestId);
        expect(reports).toHaveLength(1);
        expect(JSON.stringify(reports[0])).toContain(
          "https://github.com/example/repository/pull/1",
        );
        expect(markReportedAsync).toHaveBeenCalledTimes(2);
        expect(loadRuntime).not.toHaveBeenCalled();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        memorySessionActorOwners.closeDatabase(location);
      }
    });
  });

  it.each(
    tails.flatMap(([label, tail, count, beforeTail]) =>
      ["identity", "compressed"].map((encoding) => ({ label, tail, count, beforeTail, encoding })),
    ),
  )(
    "preserves canonical report visibility after $label ($encoding)",
    async ({ tail, count, encoding, beforeTail = [] }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const identity = await createSession("publication-codec");
        const result = failedResult("codec-publication");
        const events = [
          { type: "session", id: identity.sessionId, version: CURRENT_SESSION_VERSION },
          rootMessage(),
          previousReport(result.requestId),
          ...beforeTail,
          tail,
        ];
        await replaceTranscriptEvents(
          identity,
          encoding === "compressed"
            ? events.map((event) => ({ ...event, padding: "x".repeat(4096) }))
            : events,
        );
        const { db } = openOpenClawAgentDatabase({ agentId: identity.agentId });
        const encoded = db
          .prepare(
            "SELECT count(*) AS count FROM transcript_events WHERE session_id = ? AND event_zstd IS NOT NULL",
          )
          .get(identity.sessionId);
        expect(encoded?.count).toBe(encoding === "compressed" ? 3 + beforeTail.length : 0);
        await report(identity, result, vi.fn().mockResolvedValue(undefined));
        const reports = reportMessages(await loadTranscriptEvents(identity), result.requestId);
        expect(reports).toHaveLength(count);
      });
    },
  );

  it.each(["missing", "legacy"])(
    "keeps the %s header migration boundary before reporting",
    async (header) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const identity = await createSession("publication-header");
        const events = [
          ...(header === "legacy" ? [{ type: "session", id: identity.sessionId, version: 1 }] : []),
          { type: "provider_event", id: "opaque", parentId: null },
        ];
        await replaceTranscriptEvents(identity, events);
        const markReportedAsync = vi.fn().mockResolvedValue(undefined);
        await expect(
          report(
            identity,
            failedResult("header-publication", "Failed", "Retry"),
            markReportedAsync,
          ),
        ).rejects.toThrow("doctor/import migration");
        expect(markReportedAsync).not.toHaveBeenCalled();
        expect(await loadTranscriptEvents(identity)).toEqual(events);
      });
    },
  );
  it("marks a publication reported only after the transcript commits and allows retry after failure", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const identity = await createSession("publication-failure");
      const result = failedResult("retry-publication");
      const database = openOpenClawAgentDatabase({ agentId: identity.agentId });
      const markReportedAsync = vi.fn(async () => {
        const reader = new DatabaseSync(database.path, { readOnly: true });
        try {
          expect(
            reader
              .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
              .get(identity.sessionId),
          ).toMatchObject({ count: 2 });
        } finally {
          reader.close();
        }
      });
      reportFault.enable();
      try {
        await expect(report(identity, result, markReportedAsync)).rejects.toThrow(
          "report insert failed",
        );
        expect(markReportedAsync).not.toHaveBeenCalled();
        expect(await loadTranscriptEvents(identity)).toEqual([]);
      } finally {
        reportFault.disable();
      }
      await report(identity, result, markReportedAsync);
      expect(markReportedAsync).toHaveBeenCalledOnce();
    });
  });
  it("reports on the active branch while preserving large unrelated evidence", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const identity = await createSession("publication-branch");
      const result = failedResult("inactive-publication");
      await replaceTranscriptEvents(identity, [
        { type: "session", id: identity.sessionId, version: CURRENT_SESSION_VERSION },
        rootMessage(),
        previousReport(result.requestId, "old-report", [{ type: "text", text: "Previous report" }]),
        {
          type: "provider_event",
          id: "opaque",
          parentId: "old-report",
          payload: "large-evidence".repeat(350_000),
        },
        {
          type: "leaf",
          id: "selected",
          parentId: "opaque",
          targetId: "root",
          appendParentId: "opaque",
        },
      ]);
      const database = openOpenClawAgentDatabase({ agentId: identity.agentId });
      const readEvidence = () =>
        database.db
          .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
          .all(identity.sessionId);
      const before = readEvidence();
      const markReportedAsync = vi.fn().mockResolvedValue(undefined);
      await report(identity, result, markReportedAsync);
      await report(identity, result, markReportedAsync);
      expect(readEvidence().slice(0, before.length)).toEqual(before);
      const reports = reportMessages(await loadTranscriptEvents(identity), result.requestId);
      expect(reports).toHaveLength(2);
      expect(reports[1]).toMatchObject({ parentId: "opaque" });
      expect(markReportedAsync).toHaveBeenCalledTimes(2);
    });
  });
  it.each([
    {
      label: "published",
      result: publishedResult,
      visibleText: "https://github.com/example/repository/pull/1",
    },
    {
      label: "failed",
      result: failedResult(
        "publication-failure",
        "GitHub publication failed.",
        "Check repository write access and retry.",
      ),
      visibleText: '"text":"GitHub publication failed. Check repository write access and retry.',
    },
  ])(
    "appends one projected assistant message for a $label result",
    async ({ result, visibleText }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const identity = await createSession("publication-transcript");
        const markReportedAsync = vi.fn().mockResolvedValue(undefined);
        await report(identity, result, markReportedAsync);
        await report(identity, result, markReportedAsync);

        const events = await loadTranscriptEvents(identity);
        const messages = reportMessages(events, result.requestId, true);
        expect(messages).toHaveLength(1);
        expect(JSON.stringify(messages[0])).toContain(visibleText);
        expect(markReportedAsync).toHaveBeenCalledWith(result.requestId);
      });
    },
  );
});
