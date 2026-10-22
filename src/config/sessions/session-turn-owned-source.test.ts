import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";
import { captureSessionEntrySourceAssertion } from "./session-entry-source-authority.js";
import { withSessionTranscriptWriteAssertion } from "./transcript-write-context.js";

vi.mock("./session-accessor.sqlite-maintenance-kick.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-accessor.sqlite-maintenance-kick.js")>()),
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("./session-history-eviction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-history-eviction.js")>()),
  kickSessionHistoryDiskBudgetMaintenance() {},
}));

afterEach(() => vi.restoreAllMocks());

it.each([
  { replay: false, revoke: true, fallback: false },
  { replay: true, revoke: true, fallback: false },
  { replay: false, revoke: false, fallback: false },
  { replay: false, revoke: false, fallback: true },
])(
  "retains owned authority (replay $replay, revoke $revoke, native $fallback)",
  ({ replay, revoke, fallback }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const scope = {
        ...f.scope,
        storePath: path.resolve(f.scope.storePath, "../../sessions/sessions.json"),
      };
      const nativeGuard = Object.assign(() => {}, {
        async prepareSessionSource() {
          return { nativeSource: true, assertCurrent() {}, checks: [] };
        },
      });
      const options = {
        expectedSessionId: f.scope.sessionId,
        sessionFile: "synthetic-session.jsonl",
        touchSessionEntry: true,
        messages: [
          {
            eventId: "owned-source-turn",
            message: { role: "assistant", content: "owned completion" },
            ...(fallback ? { workerPreparation: { beforeFreshMessageCommit: nativeGuard } } : {}),
          },
        ],
      };
      if (replay) {
        await appendExpectedSessionTranscriptTurn(f.scope, options);
      }
      const before = f.read();
      const eventsBefore = f.events();
      let current = true;
      const refusal = new Error("original transcript source revoked");
      const refuse = (): never => {
        throw refusal;
      };
      const assertCurrent = () => {
        if (!current) {
          refuse();
        }
      };
      const source = captureSessionEntrySourceAssertion({
        scope,
        expected: before,
        fields: ["sessionId", "lifecycleRevision"],
        assertCurrent,
        assertHostCurrent: assertCurrent,
        refuse,
      });
      const releases: ReturnType<typeof vi.fn>[] = [];
      const prepare = source.prepareSessionSource;
      source.prepareSessionSource = async () => {
        const prepared = await prepare();
        const release = vi.fn(() => prepared.release?.());
        releases.push(release);
        return { ...prepared, release };
      };
      let reachedGrant = false;
      probe.admission(admission, (request, grant, callback) => {
        if (request.stage === "commit") {
          reachedGrant = true;
          current = !revoke;
        }
        callback(request, grant);
      });
      const committed = vi.fn(() => {
        expect(releases.every((release) => release.mock.calls.length === 0)).toBe(true);
      });
      const sql = observeHostDataSql();
      try {
        const work = withSessionTranscriptWriteAssertion(scope, source, () =>
          appendExpectedSessionTranscriptTurn(scope, { ...options, onMessageCommitted: committed }),
        );
        if (fallback) {
          await expect(work).rejects.toThrow("requires worker-compatible message preparation");
        } else if (revoke) {
          await expect(work).rejects.toBe(refusal);
        } else {
          expect((await work).appendedMessages[0]).toMatchObject({ appended: true });
        }
        expect(committed).toHaveBeenCalledTimes(fallback || revoke ? 0 : 1);
        expect(reachedGrant).toBe(!fallback);
        if (!fallback) {
          expect(sql.queries).toEqual([]);
        }
        expect(releases).toHaveLength(1);
        expect(releases[0]).toHaveBeenCalledOnce();
      } finally {
        sql.restore();
      }
      if (revoke || fallback) {
        expect(f.read()).toEqual(before);
        expect(f.events()).toEqual(eventsBefore);
      }
    }),
);
