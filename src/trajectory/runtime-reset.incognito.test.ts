import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createSessionResetCleanupGuard,
  SessionResetCleanupError,
} from "../auto-reply/reply/session-reset-cleanup.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { createSqliteTrajectoryRuntimeSink } from "./runtime-store-writer.js";
import type { TrajectoryEvent } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };

describe("incognito trajectory and reset continuation sources", () => {
  it("settles selected absence without native discovery or actor creation", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-runtime-reset-absent-") };
    const scope = {
      agentId: "main",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      sessionKey: "agent:main:dashboard:incognito-absent",
    };
    const sql = observeHostDataSql();
    try {
      await withIncognitoSessionBinding(
        { kind: "absent", agentId: "main", env, authority },
        async () => {
          expect(
            await createSqliteTrajectoryRuntimeSink({
              env,
              maxRuntimeFileBytes: 1024,
              sessionId: "absent",
              sessionKey: scope.sessionKey,
              sessionTarget: { ...scope, sessionId: "absent" },
            }),
          ).toBeNull();
          expect(
            createSessionResetCleanupGuard({ ...scope, expectedSession: undefined }),
          ).not.toThrow();
          expect(
            createSessionResetCleanupGuard({
              ...scope,
              expectedSession: { sessionId: "absent", lifecycleRevision: "original" },
            }),
          ).toThrow(SessionResetCleanupError);
        },
      );
      expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toHaveLength(0);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it("keeps retained actor loss terminal for trajectory writes and reset cleanup", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-runtime-reset-ended-") };
    const actor = await openIncognitoTestActor(env, authority);
    const scope = {
      agentId: "main",
      storePath: actor.path,
      sessionKey: "agent:main:dashboard:incognito-ended",
    };
    const entry = {
      sessionId: "ended",
      lifecycleRevision: "original",
      updatedAt: 1,
      incognito: true,
    };
    const sql = observeHostDataSql();
    try {
      await actor.sessions.create(authority, { sessionKey: scope.sessionKey, entry });
      const input = {
        env,
        maxRuntimeFileBytes: 1024,
        sessionId: entry.sessionId,
        sessionKey: scope.sessionKey,
        sessionTarget: { ...scope, sessionId: entry.sessionId },
      };
      const { sink, cleanup } = await withIncognitoSessionActor(actor, async () => {
        const retainedSink = await createSqliteTrajectoryRuntimeSink(input);
        assert(retainedSink);
        const retainedCleanup = createSessionResetCleanupGuard({
          ...scope,
          expectedSession: entry,
        });
        expect(retainedCleanup).not.toThrow();
        expect(
          await createSqliteTrajectoryRuntimeSink({
            ...input,
            sessionId: "missing",
            sessionKey: "agent:main:dashboard:incognito-missing",
            sessionTarget: {
              ...scope,
              sessionId: "missing",
              sessionKey: "agent:main:dashboard:incognito-missing",
            },
          }),
        ).toBeNull();
        return { sink: retainedSink, cleanup: retainedCleanup };
      });
      const event: TrajectoryEvent = {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "incognito-ended",
        source: "runtime",
        type: "runtime.test",
        ts: "2026-10-10T00:00:00.000Z",
        seq: 0,
        sessionId: entry.sessionId,
        sessionKey: scope.sessionKey,
      };
      sink.write(event, JSON.stringify(event));
      await actor.close();
      await expect(sink.flush()).rejects.toBeInstanceOf(IncognitoSessionEndedError);
      expect(cleanup).toThrow(IncognitoSessionEndedError);
      await expect(
        withIncognitoSessionBinding({ actor }, () => createSqliteTrajectoryRuntimeSink(input)),
      ).rejects.toBeInstanceOf(IncognitoSessionEndedError);
      expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toHaveLength(0);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      await actor.close();
    }
  });
});
