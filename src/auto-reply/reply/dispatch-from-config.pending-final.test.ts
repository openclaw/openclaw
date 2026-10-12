import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntryTargetPatchScope } from "../../config/sessions/session-accessor.types.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
import {
  clearPendingFinalDeliveryAfterSuccess,
  suppressPendingFinalDelivery,
} from "./dispatch-from-config.pending-final.js";
import { retireTerminalRestartRecoverySourceClaim } from "./restart-recovery-source.js";

// Fixture writes must not schedule retention work into the cleanup request census.
// mock-isolation: Fixture seed writes must not schedule retention requests into this census.
vi.mock("../../config/sessions/session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));

describe("pending final delivery restart proof", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-pending-final-");
  let storePath: string;
  const sessionKey = "agent:main:discord:direct:123";

  beforeEach(() => {
    storePath = path.join(sessionDirs.make(), "sessions.json");
  });

  async function writePendingFinal(
    beforeAgentReplyState: "handled-reply" | undefined,
    state: "prepared" | "delivered" = "delivered",
    updatedAt = Date.now(),
  ): Promise<void> {
    const entry: SessionEntry = {
      sessionId: "session",
      startedAt: 10,
      lifecycleRunId: "active-run",
      updatedAt,
      pendingFinalDelivery: {
        kind: "replayable",
        text: "hook reply",
        createdAt: 1,
        intentId: "intent-1",
        deliveries: [{ id: "delivery-1", state }],
      },
      restartRecoveryBeforeAgentReplyState: beforeAgentReplyState,
      restartRecoveryForceSafeTools: beforeAgentReplyState === "handled-reply" ? true : undefined,
      restartRecoverySourceIngress: "channel",
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
  }

  function pendingFinalPayload(deliveryId = "delivery-1"): ReplyPayload {
    const payload: ReplyPayload = { text: "hook reply" };
    setReplyPayloadMetadata(payload, {
      pendingFinalDeliveryCompletion: {
        deliveryId,
        intentId: "intent-1",
        sessionId: "session",
        sessionKey,
        storePath,
      },
    });
    return payload;
  }

  it("clears hook provenance after its exact intent succeeds without changing user activity", async () => {
    await writePendingFinal("handled-reply", "delivered", 1);
    const identity = getReplyPayloadMetadata(pendingFinalPayload())?.pendingFinalDeliveryCompletion;

    const sql = observeHostDataSql();
    try {
      await clearPendingFinalDeliveryAfterSuccess(identity, { preserveActivity: true });
      expect(
        sql.queries.filter((query) =>
          /session_nodes|session_entry_snapshots|\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }

    const entry = loadSessionEntry({ sessionKey, storePath }) as SessionEntry | undefined;
    expect(entry?.pendingFinalDelivery).toBeUndefined();
    expect(entry?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
    expect(entry?.restartRecoveryForceSafeTools).toBeUndefined();
    expect(entry?.restartRecoverySourceIngress).toBeUndefined();
    expect(entry?.status).toBe("done");
    expect(entry?.lifecycleRunId).toBeUndefined();
    expect(entry?.abortedLastRun).toBe(false);
    expect(entry?.endedAt).toBeTypeOf("number");
    expect(entry?.runtimeMs).toBeGreaterThanOrEqual(0);
    expect(entry?.updatedAt).toBe(1);
  });

  it("clears a skipped turn only after every sendable final is suppressed", async () => {
    await writePendingFinal(undefined, "prepared", 1);
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        ...(loadSessionEntry({ sessionKey, storePath }) as SessionEntry),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "hook reply",
          createdAt: 1,
          intentId: "intent-1",
          deliveries: [
            { id: "delivery-1", state: "prepared" },
            { id: "delivery-2", state: "prepared" },
          ],
        },
      },
    );

    await suppressPendingFinalDelivery(pendingFinalPayload("delivery-1"), {
      preserveActivity: true,
    });

    expect(
      (loadSessionEntry({ sessionKey, storePath }) as SessionEntry).pendingFinalDelivery
        ?.deliveries,
    ).toEqual([
      { id: "delivery-1", state: "suppressed" },
      { id: "delivery-2", state: "prepared" },
    ]);

    await suppressPendingFinalDelivery(pendingFinalPayload("delivery-2"), {
      preserveActivity: true,
    });

    const entry = loadSessionEntry({ sessionKey, storePath }) as SessionEntry;
    expect(entry.pendingFinalDelivery).toBeUndefined();
    expect(entry.restartRecoverySourceIngress).toBeUndefined();
    expect(entry.status).toBeUndefined();
    expect(entry.lifecycleRunId).toBe("active-run");
    expect(entry.updatedAt).toBe(1);
  });

  it("cleans only the current completed intent in one worker request after a foreign commit", async () => {
    await writePendingFinal("handled-reply", "delivered", 1);
    const scope = { sessionKey, storePath };
    const original = loadSessionEntry(scope) as SessionEntry;
    const identity = getReplyPayloadMetadata(pendingFinalPayload())?.pendingFinalDeliveryCompletion;
    const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
    const commands: string[] = [];
    let beforeCommit: (() => void) | undefined;
    const observer = vi
      .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
      .mockImplementation((...args) => {
        const owner = capture(...args);
        return {
          ...owner,
          get fileIdentity() {
            return owner.fileIdentity;
          },
          runExisting: (source, run, options) =>
            owner.runExisting(
              source,
              (worker) =>
                run({
                  execute: (command, commandOptions) => {
                    commands.push(command.type);
                    if (command.type === "session.entry.patch.commit") {
                      const change = beforeCommit;
                      beforeCommit = undefined;
                      change?.();
                    }
                    return worker.execute(command, commandOptions);
                  },
                }),
              options,
            ),
        };
      });
    try {
      for (const change of [
        { label: "foreign metadata" },
        { sessionId: "replacement" },
        { pendingFinalDelivery: { ...original.pendingFinalDelivery!, intentId: "new-intent" } },
        { restartRecoveryDeliveryRunId: "new-recovery" },
        {
          pendingFinalDelivery: {
            ...original.pendingFinalDelivery!,
            deliveries: [{ id: "delivery-1", state: "unknown" as const }],
          },
        },
      ]) {
        replaceSessionEntrySync(scope, original);
        const foreign = { ...original, ...change };
        beforeCommit = () => replaceSessionEntrySync(scope, foreign);
        commands.length = 0;
        await expect(
          clearPendingFinalDeliveryAfterSuccess(identity, { preserveActivity: true }),
        ).resolves.toBeUndefined();
        expect(commands).toEqual(["session.entry.patch.commit"]);
        const persisted = loadSessionEntry(scope) as SessionEntry;
        if ("label" in change) {
          expect(persisted.label).toBe("foreign metadata");
          expect(persisted.pendingFinalDelivery).toBeUndefined();
          expect(persisted.status).toBe("done");
        } else {
          expect(persisted).toMatchObject(foreign);
          expect(persisted.pendingFinalDelivery).toEqual(foreign.pendingFinalDelivery);
          expect(persisted.status).toBeUndefined();
        }
        expect(persisted.updatedAt).toBe(1);
      }
    } finally {
      observer.mockRestore();
    }
  });

  it("does not retire a source while its terminal provider outcome is unknown", async () => {
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "session",
        status: "done",
        updatedAt: Date.now(),
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: "message-call-1",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: "source-1",
      },
    );

    let target: SessionEntryTargetPatchScope | undefined;
    await readSessionEntryInWorker(
      { agentId: "main", storePath, sessionKey },
      () => {},
      undefined,
      (prepared) => {
        target = prepared;
      },
    );
    assert(target);
    await expect(
      retireTerminalRestartRecoverySourceClaim({
        target,
        assertCurrent: () => {},
        sessionId: "session",
        sourceTurnId: "source-1",
      }),
    ).resolves.toBeUndefined();

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "message-call-1",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
    });
    expect(
      loadSessionEntry({ sessionKey, storePath })?.restartRecoveryTerminalRunIds,
    ).toBeUndefined();
  });
});
