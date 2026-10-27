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
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionCompactHandlers } from "./server-methods/sessions-compact.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["prepared", false],
  ["prepared", true],
  ["opaque", false],
] as const)(
  "keeps in-process manual compaction authority at its worker commit (%s, revoked=%s)",
  (authority, revoke) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      const f = createSessionCompoundWorkerFixture();
      const records = createManualCompactRecords(f.scope.sessionId);
      replaceTranscriptEventsSync(f.scope, records);
      const readEvents = () => readTranscriptEventRows(f.database, f.scope.sessionId);
      const before = { entry: f.read(), events: readEvents() };
      const handler = sessionCompactHandlers["sessions.compact"]!;
      const context = createDirectChatContext({
        getRuntimeConfig: () => cfg,
        getGatewayMethodRegistry: createContext([
          ["sessions.compact", "operator.admin", "sessions", handler],
        ]).getGatewayMethodRegistry,
      });
      const commit = { current: true, active: false, checks: 0 };
      const assertCurrent = () => {
        commit.checks += Number(commit.active);
        if (!commit.current) {
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
        commit.current = !revoke;
        commit.active = true;
        try {
          callback(request, grant);
        } finally {
          commit.active = false;
        }
      });
      {
        const sql = observeHostDataSql();
        using observation = { [Symbol.dispose]: sql.restore, queries: sql.queries };
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
        if (authority === "prepared" && !revoke) {
          await expect(compact).resolves.toMatchObject({ compacted: true, kept: 3 });
        } else {
          await expect(compact).rejects.toThrow(
            authority === "opaque"
              ? "Manual compaction requires worker-prepared request authority"
              : "manual compaction request authority revoked",
          );
        }
        expect(commit.checks).toBe(authority === "prepared" ? 1 : 0);
        expect(observation.queries.join("\n")).not.toMatch(/\btranscript_events\b/i);
      }
      if (revoke || authority === "opaque") {
        expect({ entry: f.read(), events: readEvents() }).toEqual(before);
      } else {
        expect(readEvents().map((row) => row.eventJson)).toEqual([
          before.events[0]!.eventJson,
          JSON.stringify({ ...records[3], parentId: null }),
          before.events[4]!.eventJson,
        ]);
      }
    }),
);
