import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import { replaceTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { createSessionCompoundWorkerFixture } from "../config/sessions/session-compound-worker.test-support.js";
import { createManualCompactRecords } from "../config/sessions/transcript-message.test-support.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionCompactHandlers } from "./server-methods/sessions-compact.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { authority: "prepared", revoke: false },
  { authority: "prepared", revoke: true },
  { authority: "opaque", revoke: false },
])(
  "keeps in-process manual compaction authority at its worker commit ($authority, revoked=$revoke)",
  async ({ authority, revoke }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      const f = createSessionCompoundWorkerFixture();
      const records = createManualCompactRecords(f.scope.sessionId);
      replaceTranscriptEventsSync(f.scope, records);
      const before = f.read();
      const rawBefore = readTranscriptEventRows(f.database, f.scope.sessionId);
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "sessions.compact",
            scope: "operator.admin",
            owner: { kind: "core", area: "sessions" },
            handler: sessionCompactHandlers["sessions.compact"]!,
          },
        ]);
      let current = true;
      let atCommit = false;
      let commits = 0;
      let commitChecks = 0;
      const assertCurrent = () => {
        if (atCommit) {
          commitChecks++;
        }
        if (!current) {
          throw new Error("manual compaction request authority revoked");
        }
      };
      const guard =
        authority === "prepared"
          ? Object.assign(assertCurrent, {
              prepareSessionSource: async () => ({ assertCurrent, checks: [] }),
            })
          : assertCurrent;
      probe.admission(admission, (request, grant, callback) => {
        if (
          request.stage !== "commit" ||
          !isRecord(request.facts) ||
          !isRecord(request.facts.publication) ||
          request.facts.publication.kind !== "session-entry-patch-committed"
        ) {
          callback(request, grant);
          return;
        }
        commits++;
        current = !revoke;
        atCommit = true;
        try {
          callback(request, grant);
        } finally {
          atCommit = false;
        }
      });
      const sql = observeHostDataSql();
      try {
        const compact = withPluginRuntimeGatewayRequestScope(
          { context, isWebchatConnect: () => false },
          () =>
            dispatchGatewayMethodInProcess(
              "sessions.compact",
              { key: f.scope.sessionKey, maxLines: 3 },
              {
                forceSyntheticClient: true,
                syntheticScopes: ["operator.admin"],
                sessionMutationCommitGuard: guard,
              },
            ),
        );
        if (authority === "opaque") {
          await expect(compact).rejects.toThrow(
            "Manual compaction requires worker-prepared request authority",
          );
        } else if (revoke) {
          await expect(compact).rejects.toThrow("manual compaction request authority revoked");
        } else {
          await expect(compact).resolves.toMatchObject({ compacted: true, kept: 3 });
        }
        if (authority === "prepared") {
          expect(commits).toBe(1);
          expect(commitChecks).toBe(1);
        } else {
          expect(commitChecks).toBe(0);
        }
        expect(sql.queries.filter((query) => /\btranscript_events\b/i.test(query))).toEqual([]);
      } finally {
        sql.restore();
      }
      if (revoke || authority === "opaque") {
        expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toEqual(rawBefore);
        expect(f.read()).toEqual(before);
      } else {
        expect(
          readTranscriptEventRows(f.database, f.scope.sessionId).map((row) => row.eventJson),
        ).toEqual([
          rawBefore[0]!.eventJson,
          JSON.stringify({ ...records[3], parentId: null }),
          rawBefore[4]!.eventJson,
        ]);
      }
    });
  },
);
