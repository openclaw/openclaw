import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../../state/openclaw-agent-db-registry-listing.js";
import * as writeAdmission from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";

async function prepareTerminalTarget(scope: { sessionKey: string; storePath: string }) {
  const read = await readSessionEntriesFromStoreInWorker({
    agentId: "main",
    storePath: scope.storePath,
    sessionKeys: [scope.sessionKey],
    projection: "exact",
  });
  assert(read.source);
  return {
    target: {
      agentId: "main",
      storePath: scope.storePath,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      readSource: read.source,
    },
    expectedLifecycleRevision: read.entries[0]?.entry.lifecycleRevision,
    assertCurrent: vi.fn(),
  };
}

it("settles restart-safe chat claims without caller-thread SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      sessionKey: "agent:main:terminal-worker",
      storePath: state.statePath("terminal.sqlite"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: "terminal-session",
      updatedAt: 1_000,
      restartRecoveryDeliveryRunId: "terminal-run",
      restartRecoveryDeliverySourceRunId: "source-run",
    });
    await appendTranscriptMessage(
      { ...target, sessionId: "terminal-session" },
      { message: { role: "user", content: "Synthetic accepted turn" } },
    );
    const terminalTarget = await prepareTerminalTarget(target);
    invalidateRegisteredAgentDatabasesMemo({ env: state.env });
    const sql = observeHostDataSql();
    try {
      await expect(
        terminalizeRestartSafeChatAdmission({
          ...terminalTarget,
          admittedSessionId: "terminal-session",
          clientRunId: "terminal-run",
          controlUiVisible: false,
          startedAt: 1_000,
          status: "failed",
          error: "Synthetic terminal failure",
          retryable: false,
        }),
      ).resolves.toBe(true);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(loadSessionEntry(target)).toMatchObject({
      status: "failed",
      lastRunId: "terminal-run",
      restartRecoveryTerminalRunIds: ["source-run"],
    });
    expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(loadTranscriptEventsSync({ ...target, sessionId: "terminal-session" })).toContainEqual(
      expect.objectContaining({
        customType: "run-failed-before-reply",
        details: expect.objectContaining({ runId: "terminal-run" }),
      }),
    );
  });
});

it("terminalizes the current source of the same admitted run without tombstoning stale source facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      sessionKey: "agent:main:terminal-current-source",
      storePath: state.statePath("terminal.sqlite"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: "terminal-session",
      updatedAt: 1_000,
      restartRecoveryDeliveryRunId: "terminal-run",
      restartRecoveryDeliverySourceRunId: "source-run",
    });
    const terminalTarget = await prepareTerminalTarget(target);
    const foreign = new DatabaseSync(target.storePath);
    const write = writeAdmission.runOpenClawAgentWorkerWrite;
    const changed = vi.fn();
    const spy = vi
      .spyOn(writeAdmission, "runOpenClawAgentWorkerWrite")
      .mockImplementation((options, run, timing, signal) =>
        write(
          options,
          async () => {
            if (
              !("target" in options) &&
              options.path === target.storePath &&
              !changed.mock.calls.length
            ) {
              foreign
                .prepare(
                  "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.restartRecoveryDeliverySourceRunId', ?) WHERE session_key = ?",
                )
                .run("current-source", target.sessionKey);
              changed();
            }
            return run();
          },
          timing,
          signal,
        ),
      );
    try {
      await expect(
        terminalizeRestartSafeChatAdmission({
          ...terminalTarget,
          admittedSessionId: "terminal-session",
          clientRunId: "terminal-run",
          controlUiVisible: false,
          startedAt: 1_000,
          status: "killed",
          retryable: false,
        }),
      ).resolves.toBe(true);
      expect(changed).toHaveBeenCalledOnce();
      const entry = loadSessionEntry(target);
      expect(entry).toMatchObject({
        status: "killed",
        lastRunId: "terminal-run",
        restartRecoveryTerminalRunIds: ["current-source"],
      });
      expect(entry?.restartRecoveryDeliveryRunId).toBeUndefined();
      expect(entry?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    } finally {
      spy.mockRestore();
      foreign.close();
    }
  });
});
