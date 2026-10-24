import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { copyFile, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../../state/openclaw-agent-db-registry-listing.js";
import * as writeAdmission from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";

const sessionId = "terminal-session";
const clientRunId = "terminal-run";

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
    admittedSessionId: sessionId,
    clientRunId,
    startedAt: 1_000,
    status: "killed" as const,
    retryable: false,
  };
}

async function seedTerminalTarget(storePath: string, source = false, lifecycle = false) {
  const target = { agentId: "main", sessionKey: "agent:main:terminal", storePath };
  await upsertSessionEntryCore(target, {
    sessionId,
    updatedAt: 1_000,
    ...(lifecycle ? { lifecycleRevision: "terminal-lifecycle" } : {}),
    restartRecoveryDeliveryRunId: clientRunId,
    ...(source ? { restartRecoveryDeliverySourceRunId: "source-run" } : {}),
  });
  return target;
}

it("settles restart-safe chat claims without caller-thread SQL", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = await seedTerminalTarget(state.statePath("terminal.sqlite"), true);
    await appendTranscriptMessage(
      { ...target, sessionId },
      { message: { role: "user", content: "Synthetic accepted turn" } },
    );
    const terminal = await prepareTerminalTarget(target);
    invalidateRegisteredAgentDatabasesMemo({ env: state.env });
    const sql = observeHostDataSql();
    try {
      await expect(
        terminalizeRestartSafeChatAdmission({
          ...terminal,
          status: "failed",
          error: "Synthetic terminal failure",
        }),
      ).resolves.toBe(true);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(loadSessionEntry(target)).toMatchObject({
      status: "failed",
      lastRunId: clientRunId,
      restartRecoveryTerminalRunIds: ["source-run"],
    });
    expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(loadTranscriptEventsSync({ ...target, sessionId })).toContainEqual(
      expect.objectContaining({
        customType: "run-failed-before-reply",
        details: expect.objectContaining({ runId: "terminal-run" }),
      }),
    );
  }));

it("terminalizes the current source of the same admitted run without tombstoning stale source facts", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = await seedTerminalTarget(state.statePath("terminal.sqlite"), true);
    const terminal = await prepareTerminalTarget(target);
    const foreign = new DatabaseSync(target.storePath);
    const write = writeAdmission.runOpenClawAgentWorkerWrite;
    const changed = vi.fn();
    const spy = vi
      .spyOn(writeAdmission, "runOpenClawAgentWorkerWrite")
      .mockImplementation((options, run, ...rest) =>
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
          ...rest,
        ),
      );
    try {
      await expect(terminalizeRestartSafeChatAdmission(terminal)).resolves.toBe(true);
      expect(changed).toHaveBeenCalledOnce();
      const entry = loadSessionEntry(target);
      expect(entry).toMatchObject({
        status: "killed",
        lastRunId: clientRunId,
        restartRecoveryTerminalRunIds: ["current-source"],
      });
      expect(entry?.restartRecoveryDeliveryRunId).toBeUndefined();
      expect(entry?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    } finally {
      spy.mockRestore();
      foreign.close();
    }
  }));

it("does not terminalize a replacement physical store containing the same claim", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = await seedTerminalTarget(path.join(state.agentDir(), "openclaw-agent.sqlite"));
    const terminal = await prepareTerminalTarget(scope);
    await closeOpenClawAgentDatabasesAsync();
    const original = `${scope.storePath}.original`;
    await rename(scope.storePath, original);
    await copyFile(original, scope.storePath);
    const replacement = await readFile(scope.storePath);
    await expect(terminalizeRestartSafeChatAdmission(terminal)).rejects.toThrow(
      /identity changed/u,
    );
    expect(await readFile(scope.storePath)).toEqual(replacement);
  }));
it.each(["claim", "lifecycle", "authority"] as const)(
  "refuses queued terminal settlement after its %s changes",
  (changed) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const scope = await seedTerminalTarget(
        path.join(state.agentDir(), "openclaw-agent.sqlite"),
        false,
        true,
      );
      const captured = await prepareTerminalTarget(scope);
      const entered = createDeferred();
      const resume = createDeferred();
      let current = true;
      const writer = patchSessionEntryCore(scope, async () => {
        entered.resolve();
        await resume.promise;
        return changed === "claim"
          ? { restartRecoveryDeliveryRunId: "successor-run" }
          : changed === "lifecycle"
            ? { lifecycleRevision: "successor-lifecycle" }
            : null;
      });
      await entered.promise;
      const terminal = terminalizeRestartSafeChatAdmission({
        ...captured,
        assertCurrent() {
          if (!current) {
            throw new Error("terminal owner released");
          }
        },
      });
      const observed = terminal.catch((error: unknown) => error);
      current = changed !== "authority";
      resume.resolve();
      await writer;
      expect(await observed).toEqual(
        changed === "authority"
          ? expect.objectContaining({ message: "terminal owner released" })
          : false,
      );
      expect(loadSessionEntry(scope)?.status).toBeUndefined();
      expect(loadSessionEntry(scope)?.restartRecoveryDeliveryRunId).toBe(
        changed === "claim" ? "successor-run" : clientRunId,
      );
    }),
);
