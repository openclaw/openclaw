import path from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { AcpSessionManager } from "../acp/control-plane/manager.core.js";
import { disposeAcpSessionManagerInstance } from "../acp/control-plane/manager.lifecycle.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import {
  closeAdmittedRunDelegatedAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agents/agent-run-terminal-outcome.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { finishAcpSourceTurn, prepareAcpSourceTurnInput } from "./acp-source-turn.js";
import { createUserTurnTranscriptRecorder } from "./user-turn-transcript.js";
import { createSqliteTranscriptTarget } from "./user-turn-transcript.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-acp-source-turn-");

test("admits a canonical source routed to legacy ACP metadata without inventing a target incarnation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const source = {
      agentId: "main",
      sessionId: "legacy-acp-source",
      sessionKey: "agent:main:webchat:legacy-acp-source",
      storePath: path.join(state.sessionsDir("main"), "sessions.json"),
    };
    await replaceSessionEntry(source, { sessionId: source.sessionId, updatedAt: 1 });
    const cfg = { session: { store: source.storePath } };
    const sessionKey = "agent:main:acp:legacy-target";
    writeAcpSessionMetaForMigration({
      env: state.env,
      sessionKey,
      meta: {
        backend: "acpx",
        agent: "main",
        runtimeSessionName: "legacy-runtime",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
      },
    });
    const manager = new AcpSessionManager();
    try {
      const target = await manager.resolveSessionAsync({ cfg, sessionKey });
      expect(target).toMatchObject({ kind: "ready", sessionKey, entry: undefined });
      if (target.kind !== "ready") {
        throw new Error("Legacy ACP metadata was not resolved");
      }
      const recorder = createUserTurnTranscriptRecorder({
        target: { ...source, sessionEntry: undefined },
        input: { text: "Continue through the existing legacy ACP target" },
      });
      await prepareAcpSourceTurnInput(
        recorder,
        target,
        "legacy-source-run",
        () => {},
        async () => {},
      );
      const running = loadSessionEntryReadOnly(source);
      expect(running).toMatchObject({
        status: "running",
        activeWriterRunId: "legacy-source-run",
        acpSourceTurn: {
          sourceSessionId: source.sessionId,
          runId: "legacy-source-run",
          targetAgentId: "main",
          targetSessionKey: sessionKey,
          targetSessionId: null,
        },
      });
      await finishAcpSourceTurn(
        recorder,
        "legacy-source-run",
        buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase: "end",
          data: { status: "completed" },
        }),
        undefined,
      );
      expect(loadSessionEntryReadOnly(source)).toMatchObject({ status: "done" });
      expect(loadSessionEntryReadOnly(source)?.acpSourceTurn).toBeUndefined();
    } finally {
      await disposeAcpSessionManagerInstance(manager, "test-complete");
    }
  });
});

test("channel ACP claim and settlement use the database worker and fresh lifecycle state", async () => {
  const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
  const prior: InternalSessionEntry = {
    sessionId: target.sessionId,
    updatedAt: 2,
    activeWriterRunId: "previous-native-run",
    lastRunId: "previous-native-run",
    lastRunError: "previous native failure",
    status: "failed",
    startedAt: 1,
    endedAt: 2,
    runtimeMs: 1,
  };
  await replaceSessionEntry(target, prior);
  const recorder = createUserTurnTranscriptRecorder({
    target: { ...target, sessionEntry: prior },
    input: { text: "Run this request through ACP" },
  });
  await recorder.persistApproved();
  const beforeAdmission = Date.now();
  // Channel ACP can be audit-only; no Gateway lifecycle event supplies this state.
  const claimSql = observeHostDataSql();
  try {
    await prepareAcpSourceTurnInput(
      recorder,
      { agentId: "main", sessionKey: "agent:main:acp:target", entry: { sessionId: "acp-target" } },
      "channel-acp-run",
      () => {},
      async () => {},
    );
  } finally {
    claimSql.restore();
  }
  expect.soft(claimSql.queries).toEqual([]);
  const running = loadSessionEntryReadOnly(target);
  expect(running).toMatchObject({
    status: "running",
    activeWriterRunId: "channel-acp-run",
    lifecycleRunId: "channel-acp-run",
    acpSourceTurn: { sourceSessionId: target.sessionId, runId: "channel-acp-run" },
  });
  expect(running?.startedAt).toBeGreaterThanOrEqual(beforeAdmission);
  expect(running?.endedAt).toBeUndefined();
  expect(running?.runtimeMs).toBeUndefined();
  expect(running?.lastRunError).toBeUndefined();
  expect(running?.lastRunId).toBeUndefined();
  if (!running?.startedAt) {
    throw new Error("missing ACP source start");
  }
  const settlementSql = observeHostDataSql();
  try {
    await finishAcpSourceTurn(
      recorder,
      "channel-acp-run",
      buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase: "end",
        data: {
          status: "completed",
          startedAt: running.startedAt,
          endedAt: running.startedAt + 25,
        },
        endedAt: running.startedAt + 25,
      }),
      undefined,
    );
  } finally {
    settlementSql.restore();
  }
  expect(settlementSql.queries).toEqual([]);
  const completed = loadSessionEntryReadOnly(target);
  expect(completed).toMatchObject({ status: "done", runtimeMs: 25, lastRunId: "channel-acp-run" });
  expect(completed?.acpSourceTurn).toBeUndefined();
  expect(completed?.activeWriterRunId).toBeUndefined();
});

test.each(["claim", "settlement"] as const)(
  "retains ACP %s authority until the worker commit barrier",
  async (phase) => {
    const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
    const prior = { sessionId: target.sessionId, updatedAt: 1 };
    await replaceSessionEntry(target, prior);
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...target, sessionEntry: prior },
      input: { text: "Keep this source claim fenced until commit" },
    });
    await recorder.persistApproved();
    const runId = `acp-worker-guard-${phase}`;
    const context = await prepareAgentRunAdmission({
      cfg: {},
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", state: "present", boundary: "test.acp-source-guard" },
      },
      operationalRunInstance: createOperationalRunInstanceRef(runId),
    }).admit("acp");
    const assertCurrent = resolveAdmittedRunActiveAssertion(context);
    if (!assertCurrent) {
      throw new Error("Missing admitted ACP authority");
    }
    const prepare = () =>
      prepareAcpSourceTurnInput(
        recorder,
        { agentId: "main", sessionKey: "agent:main:acp:target" },
        runId,
        assertCurrent,
        async () => {},
      );
    if (phase === "settlement") {
      await prepare();
    }
    let reachedCommit = false;
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    const revoke = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            reachedCommit = true;
            closeAdmittedRunDelegatedAuthority(context);
          }
          callback(request, grant);
        }, attachment),
      );
    try {
      if (phase === "claim") {
        await expect(prepare()).rejects.toThrow("admitted run authority is no longer active");
      } else {
        await expect(
          finishAcpSourceTurn(
            recorder,
            runId,
            buildAgentRunTerminalOutcomeFromLifecycleEvent({
              phase: "end",
              data: { status: "completed" },
            }),
            context,
          ),
        ).resolves.toBeUndefined();
      }
      expect(reachedCommit).toBe(true);
      const entry = loadSessionEntryReadOnly(target);
      if (phase === "claim") {
        expect(entry?.acpSourceTurn).toBeUndefined();
        expect(entry?.activeWriterRunId).toBeUndefined();
      } else {
        expect(entry).toMatchObject({
          status: "running",
          activeWriterRunId: runId,
          acpSourceTurn: { sourceSessionId: target.sessionId, runId },
        });
      }
    } finally {
      revoke.mockRestore();
      closeAdmittedRunDelegatedAuthority(context);
    }
  },
);
