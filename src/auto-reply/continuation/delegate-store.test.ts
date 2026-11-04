import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { isSessionRecipientAuthorityCurrentInWorker } from "../../config/sessions/session-recipient-authority-current.js";

// Logger mock for corrupt-payload breadcrumb assertions.
// Mirrors the shape used in sibling delegate-dispatch.test.ts so log.warn
// emissions land in `loggerRecords` for inspection.
const loggerRecords: Array<{ level: string; message: string }> = [];
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const record =
    (level: string) =>
    (message: string): void => {
      loggerRecords.push({ level, message });
    };
  const logger = {
    subsystem: "test",
    isEnabled: () => true,
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    raw: record("raw"),
    child: () => logger,
  };
  return {
    ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
    createSubsystemLogger: () => logger,
  };
});

import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { resetContinuationCustodyProjection } from "./custody/custody-projection.js";
import {
  createContinuationRecord,
  hydrateContinuationCustody,
  updateContinuationRecords,
} from "./custody/custody-store.js";
import type {
  ContinuationRecord,
  ContinuationRecordKind,
  ContinuationRecordPatch,
} from "./custody/custody-store.types.js";
import {
  custodyStateForTest,
  listCustodyRecordsForTest,
  readCustodyRecordForTest,
  useContinuationCustodyTestState,
} from "./custody/custody.test-support.js";
import { createDelegateRecord } from "./delegate-flow-store.js";
import {
  claimStagedPostCompactionDelegates,
  failStagedPostCompactionDelegatesForCleanup,
  listRecoverableStagedPostCompactionDelegates,
  stagePostCompactionCustodyDelegate,
  stagedPostCompactionDelegateCount,
} from "./delegate-store-post-compaction.js";
import {
  cancelPendingDelegates,
  consumePendingDelegates,
  enqueuePendingDelegate,
  listPendingDelegateSessionKeysForRecovery,
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
  pendingDelegateCount,
  resetDelegateStoreForTests,
} from "./delegate-store.js";
import { cancelSessionContinuations } from "./session-reset.js";
import { hasLiveContinuationCustody, listLiveContinuationCustodyOwners } from "./work-store.js";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const custody = useContinuationCustodyTestState();

function payloadTreeFor(record: ContinuationRecord): string {
  expect(typeof record.attachmentId).toBe("string");
  return path.join(
    custody.stateDir(),
    "attachments",
    "continuation-custody",
    record.attachmentId as string,
  );
}

async function readRecord(recordId: string | undefined): Promise<ContinuationRecord> {
  return expectDefined(
    await readCustodyRecordForTest(expectDefined(recordId, "record id")),
    "custody record",
  );
}

async function onlyRecordFor(sessionKey: string): Promise<ContinuationRecord> {
  const records = await listCustodyRecordsForTest({ ownerSessionKey: sessionKey });
  expect(records).toHaveLength(1);
  return expectDefined(records.at(0), "custody record");
}

/** Seed a record exactly as a legacy import or corrupt writer could have left it. */
async function queueRawRecord(
  sessionKey: string,
  state: unknown,
  options: {
    kind?: ContinuationRecordKind;
    status?: "queued" | "running";
    createdAt?: number;
  } = {},
): Promise<string> {
  const recordId = crypto.randomUUID();
  const created = await createContinuationRecord({
    recordId,
    kind: options.kind ?? "delegate",
    ownerSessionKey: sessionKey,
    status: options.status ?? "queued",
    phase: "Queued for continuation dispatch",
    createdAt: options.createdAt ?? Date.now(),
    stateJson: JSON.stringify(state),
  });
  expect(created.outcome).toBe("created");
  return recordId;
}

/** A concurrent writer committing against the record's current revision. */
async function writeConcurrently(recordId: string, patch: ContinuationRecordPatch): Promise<void> {
  const current = await readRecord(recordId);
  const result = await updateContinuationRecords(
    [
      {
        recordId,
        ownerSessionKey: current.ownerSessionKey,
        expectedRevision: current.revision,
        patch,
      },
    ],
    { now: Date.now() },
  );
  expect(result.outcome).toBe("applied");
}

/** Drop process state and re-hydrate from committed rows, as a Gateway restart does. */
async function restartProcessState(): Promise<void> {
  resetDelegateStoreForTests();
  resetContinuationCustodyProjection();
  await closeOpenClawStateDatabaseAsync();
  await hydrateContinuationCustody();
}

beforeEach(() => {
  setRuntimeConfigSnapshot({
    tools: { sessions_spawn: { attachments: { enabled: true } } },
  });
  loggerRecords.length = 0;
  resetDelegateStoreForTests();
});

afterEach(() => {
  resetDelegateStoreForTests();
  vi.useRealTimers();
});

describe("delegate store — continuation custody", () => {
  it("enqueues and consumes a pending delegate", async () => {
    await enqueuePendingDelegate("session-1", { task: "check CI" });

    expect(pendingDelegateCount("session-1")).toBe(1);
    const delegates = await consumePendingDelegates("session-1");
    expect(delegates).toHaveLength(1);
    expect(expectDefined(delegates.at(0), "delegate").task).toBe("check CI");
    expect(pendingDelegateCount("session-1")).toBe(0);
  });

  it("does not recover or claim a cancel-requested pending delegate; reset releases its payload", async () => {
    const sessionKey = "session-cancel-requested-pending";
    const secret = "CANCEL_REQUESTED_PENDING_SECRET";
    await enqueuePendingDelegate(sessionKey, {
      task: "must not spawn",
      attachments: [{ name: "brief.md", content: secret }],
      attachAs: { mountPath: "handoff" },
    });
    const queued = await onlyRecordFor(sessionKey);
    const payloadTree = payloadTreeFor(queued);
    expect(fs.existsSync(payloadTree)).toBe(true);
    await writeConcurrently(queued.recordId, { cancelRequestedAt: Date.now() });

    expect(await listPendingDelegateSessionKeysForRecovery()).toEqual([]);
    expect(await hasLiveContinuationCustody(sessionKey)).toBe(false);
    expect(listLiveContinuationCustodyOwners()).toEqual([]);
    expect(await consumePendingDelegates(sessionKey)).toEqual([]);
    const fenced = await readRecord(queued.recordId);
    expect(fenced.status).toBe("queued");
    expect(fenced.cancelRequestedAt).toBeDefined();
    expect(custodyStateForTest(fenced)).toMatchObject({
      kind: "continuation_delegate",
      task: "must not spawn",
    });
    expect(custodyStateForTest(fenced)).not.toHaveProperty("attachments");
    expect(custodyStateForTest(fenced)).not.toHaveProperty("attachAs");
    expect(fenced.stateJson).not.toContain(secret);

    // The fence alone never drives the record; reset terminalizes it and the
    // same commit releases the payload (RFC §5.4.4 "Reset at any boundary").
    await cancelSessionContinuations(sessionKey, () => {});
    const cancelled = await readRecord(queued.recordId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.attachmentId).toBeUndefined();
    expect(fs.existsSync(payloadTree)).toBe(false);
  });

  it("uses only regular queued/running pending delegates for cleanup deferral", async () => {
    const regularSession = "session-cleanup-regular";
    const postCompactionSession = "session-cleanup-post-compaction";

    await enqueuePendingDelegate(regularSession, { task: "regular cleanup blocker" });
    expect(await hasLiveContinuationCustody(regularSession)).toBe(true);
    await consumePendingDelegates(regularSession);
    expect(await hasLiveContinuationCustody(regularSession)).toBe(true);

    await stagePostCompactionCustodyDelegate(postCompactionSession, {
      task: "post-compaction cleanup non-blocker",
      stagedAt: Date.now(),
    });
    expect(await hasLiveContinuationCustody(postCompactionSession)).toBe(false);
    await claimStagedPostCompactionDelegates(postCompactionSession);
    expect(await hasLiveContinuationCustody(postCompactionSession)).toBe(false);
    // Session maintenance keeps the same owners, read from the hot-path projection.
    expect(listLiveContinuationCustodyOwners()).toEqual([regularSession]);
  });

  it("fails queued and running post-compaction delegates for completed child cleanup", async () => {
    const sessionKey = "session-cleanup-post-compaction-fail";
    await enqueuePendingDelegate(sessionKey, { task: "regular cleanup blocker" });
    await stagePostCompactionCustodyDelegate(sessionKey, {
      task: "post-compaction queued",
      stagedAt: Date.now(),
    });
    await stagePostCompactionCustodyDelegate(sessionKey, {
      task: "post-compaction running",
      stagedAt: Date.now(),
    });
    const [running] = await claimStagedPostCompactionDelegates(sessionKey);
    expect(running).toBeDefined();

    expect(
      await failStagedPostCompactionDelegatesForCleanup(
        sessionKey,
        "completed delete-mode child has no future compaction seam",
      ),
    ).toBe(2);

    expect(await listCustodyRecordsForTest({ statuses: ["failed"] })).toHaveLength(2);
    expect(await hasLiveContinuationCustody(sessionKey)).toBe(true);
    expect(pendingDelegateCount(sessionKey)).toBe(1);
  });

  it("logs when acceptance cannot be committed after a claim", async () => {
    await enqueuePendingDelegate("session-accept-conflict", { task: "accept conflict" });
    const delegate = expectDefined(
      (await consumePendingDelegates("session-accept-conflict")).at(0),
      "delegate",
    );
    await writeConcurrently(delegate.flowId!, { phase: "Concurrent writer" });

    expect(await markPendingDelegateSpawnAccepted(delegate, "agent:main:subagent:child")).toBe(
      false,
    );
    expect(loggerRecords).toContainEqual({
      level: "warn",
      message: `[continuation:delegate-accept-not-committed] flowId=${delegate.flowId} expectedRevision=${delegate.expectedRevision} acceptance was not committed`,
    });
  });

  it("does not treat a stale failed row as an accepted spawn commit", async () => {
    await enqueuePendingDelegate("session-accept-failed", { task: "accept failed" });
    const delegate = expectDefined(
      (await consumePendingDelegates("session-accept-failed")).at(0),
      "delegate",
    );
    await writeConcurrently(delegate.flowId!, {
      status: "failed",
      failureReason: "failed elsewhere",
    });

    expect(await markPendingDelegateSpawnAccepted(delegate, "agent:main:subagent:child")).toBe(
      false,
    );
    expect(loggerRecords).toContainEqual({
      level: "warn",
      message: `[continuation:delegate-accept-not-committed] flowId=${delegate.flowId} expectedRevision=${delegate.expectedRevision} acceptance was not committed`,
    });
  });

  it("hands an accepted claim to subagent_runs permanently and refuses a second child", async () => {
    await enqueuePendingDelegate("session-accept-handoff", { task: "hand off" });
    const delegate = expectDefined(
      (await consumePendingDelegates("session-accept-handoff")).at(0),
      "claimed delegate",
    );
    const childRunId = expectDefined(delegate.spawnAttempt, "spawn attempt").childRunId;
    expect(childRunId).toBe(`continuation:${delegate.flowId}:1`);

    expect(await markPendingDelegateSpawnAccepted(delegate, "agent:main:subagent:first")).toBe(
      true,
    );
    const handedOff = await readRecord(delegate.flowId);
    expect(handedOff).toMatchObject({
      status: "succeeded",
      revision: delegate.expectedRevision! + 1,
      handoff: {
        target: "subagent_runs",
        childRunId,
        childSessionKey: "agent:main:subagent:first",
        handedOffAt: expect.any(Number),
      },
    });

    // A replay of the same acceptance is idempotent; a different child is refused.
    expect(await markPendingDelegateSpawnAccepted(delegate, "agent:main:subagent:first")).toBe(
      true,
    );
    expect(await markPendingDelegateSpawnAccepted(delegate, "agent:main:subagent:second")).toBe(
      false,
    );
    expect(await readRecord(delegate.flowId)).toEqual(handedOff);
  });

  it("handles multi-delegate fan-out (FIFO order)", async () => {
    await enqueuePendingDelegate("session-1", { task: "task A" });
    await enqueuePendingDelegate("session-1", { task: "task B" });
    await enqueuePendingDelegate("session-1", { task: "task C" });

    const delegates = await consumePendingDelegates("session-1");
    expect(delegates).toHaveLength(3);
    expect(delegates.map((d) => d.task)).toEqual(["task A", "task B", "task C"]);
  });

  it("isolates delegates by session", async () => {
    await enqueuePendingDelegate("session-1", { task: "for session 1" });
    await enqueuePendingDelegate("session-2", { task: "for session 2" });

    expect(pendingDelegateCount("session-1")).toBe(1);
    expect(pendingDelegateCount("session-2")).toBe(1);
    expect(await consumePendingDelegates("session-1")).toHaveLength(1);
    expect(await consumePendingDelegates("session-2")).toHaveLength(1);
  });

  it("returns empty array when no delegates queued", async () => {
    expect(await consumePendingDelegates("empty-session")).toEqual([]);
  });

  it("preserves mode flags through the custody round-trip", async () => {
    await enqueuePendingDelegate("session-1", {
      task: "silent task",
      mode: "silent-wake",
    });

    const delegates = await consumePendingDelegates("session-1");
    expect(delegates[0]).toMatchObject({
      task: "silent task",
      mode: "silent-wake",
    });
  });

  it("preserves attachments and mount options through the custody round-trip", async () => {
    await enqueuePendingDelegate("session-1", {
      task: "attachment task",
      attachments: [
        { name: "  brief.md  ", content: "read me", mimeType: "  text/markdown  " },
        { name: "data.bin", content: "AQID", encoding: "base64" },
      ],
      attachAs: { mountPath: "  handoff/path  " },
    });

    expect((await consumePendingDelegates("session-1"))[0]).toMatchObject({
      task: "attachment task",
      attachments: [
        { name: "brief.md", content: "read me", mimeType: "text/markdown" },
        { name: "data.bin", content: "AQID", encoding: "base64" },
      ],
      attachAs: { mountPath: "handoff/path" },
    });
    const stored = custodyStateForTest(await onlyRecordFor("session-1"));
    expect(stored).toMatchObject({ attachmentCount: 2 });
    expect(stored).not.toHaveProperty("attachments");
    expect(stored).not.toHaveProperty("attachAs");
  });

  it("restores the complete attachment payload after process restart", async () => {
    const attachments = [
      { name: "brief.md", content: "private handoff", mimeType: "text/markdown" },
      { name: "data.bin", content: "AQID", encoding: "base64" as const },
    ];
    await enqueuePendingDelegate("session-restart-attachment", {
      task: "attachment task after restart",
      attachments,
      attachAs: { mountPath: "handoff" },
    });
    const queued = await onlyRecordFor("session-restart-attachment");
    expect(custodyStateForTest(queued)).toMatchObject({ attachmentCount: 2 });
    expect(queued.attachmentId).toEqual(expect.any(String));
    expect(fs.existsSync(payloadTreeFor(queued))).toBe(true);

    await restartProcessState();

    expect(await consumePendingDelegates("session-restart-attachment")).toMatchObject([
      {
        task: "attachment task after restart",
        attachments,
        attachAs: { mountPath: "handoff" },
      },
    ]);
    const stored = await onlyRecordFor("session-restart-attachment");
    expect(stored.status).toBe("running");
    expect(stored.stateJson).not.toContain("private handoff");
  });

  it("normalizes empty attachment state to absence", async () => {
    await enqueuePendingDelegate("session-empty-attachments", {
      task: "no attachment snapshot",
      attachments: [],
      attachAs: { mountPath: "unused" },
    });

    const delegate = expectDefined(
      (await consumePendingDelegates("session-empty-attachments")).at(0),
      "delegate",
    );
    expect(delegate).not.toHaveProperty("attachments");
    expect(delegate).not.toHaveProperty("attachAs");
    const stored = await readRecord(delegate.flowId);
    expect(stored.attachmentId).toBeUndefined();
    expect(custodyStateForTest(stored)).not.toHaveProperty("attachments");
    expect(custodyStateForTest(stored)).not.toHaveProperty("attachAs");
  });

  it("rejects unsafe mount hints before custody persistence", async () => {
    await expect(
      enqueuePendingDelegate("session-invalid-mount", {
        task: "unsafe mount",
        attachAs: { mountPath: "unsafe\npath" },
      }),
    ).rejects.toThrow("invalid continuation delegate attachment mount path");
    expect(await listCustodyRecordsForTest({ ownerSessionKey: "session-invalid-mount" })).toEqual(
      [],
    );
  });

  it("dead-letters widened recovered attachment state and scrubs raw bytes", async () => {
    const content = "RECOVERY_ATTACHMENT_CONTENT_MUST_NOT_RETAIN";
    const secret = "RECOVERY_ATTACHMENT_UNKNOWN_MEMBER_MUST_NOT_RETAIN";
    const recordId = await queueRawRecord("session-widened-attachment", {
      kind: "continuation_delegate",
      task: "reject widened attachment member",
      attachments: [
        {
          name: "brief.md",
          content,
          extra: secret,
        },
      ],
    });

    expect(await consumePendingDelegates("session-widened-attachment")).toEqual([]);
    const failed = await readRecord(recordId);
    expect(failed.status).toBe("failed");
    expect(custodyStateForTest(failed)).not.toHaveProperty("attachments");
    expect(failed.stateJson).not.toContain(content);
    expect(failed.stateJson).not.toContain(secret);
  });

  it("dead-letters widened recovered mount state and scrubs raw bytes", async () => {
    const secret = "RECOVERY_MOUNT_UNKNOWN_MEMBER_MUST_NOT_RETAIN";
    const recordId = await queueRawRecord("session-widened-mount", {
      kind: "continuation_delegate",
      task: "reject widened mount member",
      attachAs: {
        mountPath: "receipts",
        extra: secret,
      },
    });

    expect(await consumePendingDelegates("session-widened-mount")).toEqual([]);
    const failed = await readRecord(recordId);
    expect(failed.status).toBe("failed");
    expect(custodyStateForTest(failed)).not.toHaveProperty("attachAs");
    expect(failed.stateJson).not.toContain(secret);
    expect(failed.stateJson).not.toContain("receipts");
  });

  it("dead-letters unsafe or noncanonical recovered mount paths", async () => {
    const mountPaths = ["/absolute", "handoff/../outside", "handoff//nested", " handoff/path "];

    for (const [index, mountPath] of mountPaths.entries()) {
      const sessionKey = `session-invalid-recovered-mount-${index}`;
      const recordId = await queueRawRecord(sessionKey, {
        kind: "continuation_delegate",
        task: "reject invalid recovered mount path",
        attachAs: { mountPath },
      });

      expect(await consumePendingDelegates(sessionKey), mountPath).toEqual([]);
      const failed = await readRecord(recordId);
      expect(failed.status, mountPath).toBe("failed");
      expect(custodyStateForTest(failed), mountPath).not.toHaveProperty("attachAs");
      expect(failed.stateJson, mountPath).not.toContain(mountPath);
    }
  });

  it("dead-letters semantically invalid recovered attachment snapshots and scrubs raw bytes", async () => {
    const corruptions = [
      {
        sessionKey: "session-noncanonical-base64",
        content: "Z g==",
        attachment: { name: "brief.bin", content: "Z g==", encoding: "base64" },
      },
      {
        sessionKey: "session-invalid-attachment-name",
        content: "RECOVERY_INVALID_NAME_CONTENT_MUST_NOT_RETAIN",
        attachment: {
          name: "../escape.txt",
          content: "RECOVERY_INVALID_NAME_CONTENT_MUST_NOT_RETAIN",
        },
      },
    ];

    for (const corruption of corruptions) {
      const recordId = await queueRawRecord(corruption.sessionKey, {
        kind: "continuation_delegate",
        task: "reject semantically invalid recovered attachment",
        attachments: [corruption.attachment],
      });

      expect(await consumePendingDelegates(corruption.sessionKey)).toEqual([]);
      const failed = await readRecord(recordId);
      expect(failed.status).toBe("failed");
      expect(custodyStateForTest(failed)).not.toHaveProperty("attachments");
      expect(failed.stateJson).not.toContain(corruption.content);
    }
  });

  it("dead-letters stale corrupt running post-compaction recovery state and scrubs raw bytes", async () => {
    const content = "RUNNING_POST_COMPACTION_CONTENT_MUST_NOT_RETAIN";
    const secret = "RUNNING_POST_COMPACTION_UNKNOWN_MEMBER_MUST_NOT_RETAIN";
    const recordId = await queueRawRecord(
      "session-running-post-compaction-corrupt",
      {
        kind: "continuation_delegate",
        task: "reject corrupt crash orphan",
        postCompaction: true,
        attachments: [{ name: "brief.md", content, extra: secret }],
      },
      { kind: "post_compaction", status: "running", createdAt: 100 },
    );
    expect((await readRecord(recordId)).updatedAt).toBe(100);

    expect(
      await listRecoverableStagedPostCompactionDelegates({ runningUpdatedAtOrBefore: 100 }),
    ).toEqual([]);
    const failed = await readRecord(recordId);
    expect(failed.status).toBe("failed");
    expect(custodyStateForTest(failed)).not.toHaveProperty("attachments");
    expect(failed.stateJson).not.toContain(content);
    expect(failed.stateJson).not.toContain(secret);
  });

  it("dead-letters otherwise valid stale running post-compaction state widened at the root", async () => {
    const secret = "RUNNING_POST_COMPACTION_ROOT_SECRET_MUST_NOT_RETAIN";
    const recordId = await queueRawRecord(
      "session-running-post-compaction-root-extra",
      {
        kind: "continuation_delegate",
        task: "reject root-widened crash orphan",
        postCompaction: true,
        extra: secret,
      },
      { kind: "post_compaction", status: "running", createdAt: 100 },
    );

    expect(
      await listRecoverableStagedPostCompactionDelegates({ runningUpdatedAtOrBefore: 100 }),
    ).toEqual([]);
    const failed = await readRecord(recordId);
    expect(failed.status).toBe("failed");
    expect(custodyStateForTest(failed)).toEqual({});
    expect(failed.stateJson).not.toContain(secret);
  });

  it("terminalizes invalid root-widened pending state without retaining the secret", async () => {
    const secret = "PENDING_ROOT_SECRET_MUST_NOT_RETAIN";
    const recordId = await queueRawRecord("session-pending-root-extra", {
      kind: "continuation_delegate",
      task: "reject invalid root-widened pending flow",
      delayMs: "not a number",
      extra: secret,
    });

    expect(await consumePendingDelegates("session-pending-root-extra")).toEqual([]);
    const failed = await readRecord(recordId);
    expect(failed.status).toBe("failed");
    expect(custodyStateForTest(failed)).toEqual({});
    expect(failed.stateJson).not.toContain(secret);
  });

  it("replaces corrupt non-record recovered state with a minimal scrubbed value", async () => {
    for (const secret of [
      "RECOVERY_ARRAY_SECRET_MUST_NOT_RETAIN",
      "RECOVERY_PRIMITIVE_SECRET_MUST_NOT_RETAIN",
    ]) {
      const state = secret.includes("ARRAY") ? [secret] : secret;
      const recordId = await queueRawRecord(`session-corrupt-state-${secret}`, state);

      expect(await consumePendingDelegates(`session-corrupt-state-${secret}`)).toEqual([]);
      const failed = await readRecord(recordId);
      expect(failed.status).toBe("failed");
      expect(custodyStateForTest(failed)).toEqual({});
      expect(failed.stateJson).not.toContain(secret);
    }
  });

  it("rejects invalid attachment snapshots at every direct custody writer before persistence", async () => {
    const enabled = {
      tools: {
        sessions_spawn: {
          attachments: { enabled: true, maxFiles: 1, maxFileBytes: 4, maxTotalBytes: 4 },
        },
      },
    };
    const disabled = { tools: { sessions_spawn: { attachments: { enabled: false } } } };
    const attempts: Array<{
      name: string;
      write: () => Promise<unknown>;
      expected: string;
      secret: string;
    }> = [
      {
        name: "disabled policy through enqueuePendingDelegate",
        secret: "DISABLED_POLICY_SECRET",
        expected: "attachments are disabled",
        write: () =>
          enqueuePendingDelegate(
            "direct-disabled",
            {
              task: "disabled",
              attachments: [{ name: "brief.md", content: "DISABLED_POLICY_SECRET" }],
            },
            { attachmentConfig: disabled },
          ),
      },
      {
        name: "oversized utf8 through stagePostCompactionCustodyDelegate",
        secret: "OVERSIZED_ATTACHMENT_SECRET",
        expected: "attachments_file_bytes_exceeded",
        write: () =>
          stagePostCompactionCustodyDelegate(
            "direct-oversized",
            {
              task: "oversized",
              stagedAt: Date.now(),
              attachments: [{ name: "brief.md", content: "OVERSIZED_ATTACHMENT_SECRET" }],
            },
            { attachmentConfig: enabled },
          ),
      },
      {
        name: "malformed base64 through createDelegateRecord",
        secret: "%%%NOT_BASE64%%",
        expected: "attachments_invalid_base64_or_too_large",
        write: () =>
          createDelegateRecord({
            ownerKey: "direct-base64",
            controller: "pending",
            delegate: {
              task: "base64",
              attachments: [{ name: "brief.bin", content: "%%%NOT_BASE64%%", encoding: "base64" }],
            },
            phase: "test",
            attachmentConfig: enabled,
          }),
      },
      {
        name: "duplicate names",
        secret: "DUPLICATE_NAME_SECRET",
        expected: "attachments_duplicate_name",
        write: () =>
          enqueuePendingDelegate(
            "direct-duplicate",
            {
              task: "duplicate",
              attachments: [
                { name: "brief.md", content: "one" },
                { name: "brief.md", content: "DUPLICATE_NAME_SECRET" },
              ],
            },
            {
              attachmentConfig: {
                tools: {
                  sessions_spawn: {
                    attachments: {
                      enabled: true,
                      maxFiles: 2,
                      maxFileBytes: 64,
                      maxTotalBytes: 64,
                    },
                  },
                },
              },
            },
          ),
      },
      {
        name: "unsafe names",
        secret: "UNSAFE_NAME_SECRET",
        expected: "attachments_invalid_name",
        write: () =>
          enqueuePendingDelegate(
            "direct-unsafe-name",
            {
              task: "unsafe",
              attachments: [{ name: "../brief.md", content: "UNSAFE_NAME_SECRET" }],
            },
            { attachmentConfig: enabled },
          ),
      },
      {
        name: "invalid attachAs",
        secret: "INVALID_ATTACH_AS_SECRET",
        expected: "invalid continuation delegate attachment mount path",
        write: () =>
          stagePostCompactionCustodyDelegate(
            "direct-unsafe-mount",
            {
              task: "unsafe mount",
              stagedAt: Date.now(),
              attachments: [{ name: "brief.md", content: "INVALID_ATTACH_AS_SECRET" }],
              attachAs: { mountPath: "../outside" },
            },
            {
              attachmentConfig: {
                tools: {
                  sessions_spawn: {
                    attachments: {
                      enabled: true,
                      maxFiles: 1,
                      maxFileBytes: 64,
                      maxTotalBytes: 64,
                    },
                  },
                },
              },
            },
          ),
      },
    ];

    for (const attempt of attempts) {
      await expect(attempt.write(), attempt.name).rejects.toThrow(attempt.expected);
      expect(JSON.stringify(await listCustodyRecordsForTest())).not.toContain(attempt.secret);
    }
    expect(await listCustodyRecordsForTest()).toHaveLength(0);
    // No payload file was written ahead of a rejected record either.
    expect(
      fs.existsSync(path.join(custody.stateDir(), "attachments", "continuation-custody")),
    ).toBe(false);
  });

  it("scrubs attachment bytes when a delegate reaches a terminal state", async () => {
    await enqueuePendingDelegate("session-terminal-success", {
      task: "successful attachment task",
      attachments: [{ name: "success.txt", content: "SUCCESS_SECRET" }],
      attachAs: { mountPath: "handoff" },
    });
    const accepted = expectDefined(
      (await consumePendingDelegates("session-terminal-success")).at(0),
      "accepted delegate",
    );
    const acceptedTree = payloadTreeFor(await readRecord(accepted.flowId));
    expect(fs.existsSync(acceptedTree)).toBe(true);
    expect(await markPendingDelegateSpawnAccepted(accepted, "agent:main:subagent:child")).toBe(
      true,
    );
    const acceptedRecord = await readRecord(accepted.flowId);
    expect(custodyStateForTest(acceptedRecord)).not.toHaveProperty("attachments");
    expect(custodyStateForTest(acceptedRecord)).not.toHaveProperty("attachAs");
    expect(custodyStateForTest(acceptedRecord)).not.toHaveProperty("attachmentId");
    expect(acceptedRecord.attachmentId).toBeUndefined();
    expect(fs.existsSync(acceptedTree)).toBe(false);

    await enqueuePendingDelegate("session-terminal-failure", {
      task: "failed attachment task",
      attachments: [{ name: "failure.txt", content: "FAILURE_SECRET" }],
      attachAs: { mountPath: "handoff" },
    });
    const failed = expectDefined(
      (await consumePendingDelegates("session-terminal-failure")).at(0),
      "failed delegate",
    );
    const failedTree = payloadTreeFor(await readRecord(failed.flowId));
    expect(fs.existsSync(failedTree)).toBe(true);
    await markPendingDelegateFailed(failed, "spawn rejected");
    const failedRecord = await readRecord(failed.flowId);
    expect(custodyStateForTest(failedRecord)).not.toHaveProperty("attachments");
    expect(custodyStateForTest(failedRecord)).not.toHaveProperty("attachAs");
    expect(custodyStateForTest(failedRecord)).not.toHaveProperty("attachmentId");
    expect(failedRecord.attachmentId).toBeUndefined();
    expect(fs.existsSync(failedTree)).toBe(false);
  });

  it("confirms only a failed terminal row when failure races another terminal outcome", async () => {
    await enqueuePendingDelegate("session-terminal-race-success", { task: "accepted elsewhere" });
    const accepted = expectDefined(
      (await consumePendingDelegates("session-terminal-race-success")).at(0),
      "accepted race delegate",
    );
    expect(await markPendingDelegateSpawnAccepted(accepted, "agent:main:subagent:child")).toBe(
      true,
    );
    expect(await markPendingDelegateFailed(accepted, "stale rejection")).toBe(false);

    await enqueuePendingDelegate("session-terminal-race-failed", { task: "rejected elsewhere" });
    const failed = expectDefined(
      (await consumePendingDelegates("session-terminal-race-failed")).at(0),
      "failed race delegate",
    );
    expect(await markPendingDelegateFailed(failed, "first rejection")).toBe(true);
    expect(await markPendingDelegateFailed(failed, "replayed rejection")).toBe(true);
  });

  it("preserves cross-session target metadata through the custody round-trip", async () => {
    await enqueuePendingDelegate("session-1", {
      task: "targeted task",
      targetSessionKey: "agent:main:root",
      targetSessionKeys: ["agent:main:sibling", "agent:main:root"],
    });

    const delegates = await consumePendingDelegates("session-1");
    expect(delegates[0]).toMatchObject({
      task: "targeted task",
      targetSessionKey: "agent:main:root",
      targetSessionKeys: ["agent:main:sibling", "agent:main:root"],
      recipientAuthorityBinding: {
        version: 1,
        selection: "selected",
        recipients: [
          {
            sessionKey: "agent:main:root",
            authority: expect.objectContaining({ state: "bound", epoch: expect.any(String) }),
          },
          {
            sessionKey: "agent:main:sibling",
            authority: expect.objectContaining({ state: "bound", epoch: expect.any(String) }),
          },
        ],
      },
    });
  });

  it("binds every explicit recipient to its current durable authority before commit", async () => {
    // The root already holds an epoch; the sibling is captured for the first time.
    await enqueuePendingDelegate("session-0", {
      task: "earlier capture",
      targetSessionKey: "agent:main:root",
    });
    const record = await enqueuePendingDelegate("session-1", {
      task: "bound task",
      targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });
    const binding = (await consumePendingDelegates("session-1"))[0]?.recipientAuthorityBinding;
    expect(binding?.selection).toBe("selected");
    const recipients = binding?.selection === "selected" ? binding.recipients : [];
    expect(recipients.map((recipient) => recipient.sessionKey)).toEqual([
      "agent:main:root",
      "agent:main:sibling",
    ]);
    for (const { sessionKey, authority } of recipients) {
      expect(
        await isSessionRecipientAuthorityCurrentInWorker(
          { agentId: "main", sessionKey },
          authority,
        ),
      ).toBe(true);
    }
    expect(record.recordId).toEqual(expect.any(String));
  });

  it("commits no delegate record when a recipient authority cannot be captured", async () => {
    await enqueuePendingDelegate("session-1", {
      task: "first capture",
      targetSessionKey: "agent:main:root",
    });
    const database = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }));
    try {
      database
        .prepare("UPDATE session_recipient_authority SET epoch = ? WHERE session_key = ?")
        .run("not-a-uuid", "agent:main:root");
    } finally {
      database.close();
    }

    await expect(
      enqueuePendingDelegate("session-2", {
        task: "unbound capture",
        targetSessionKey: "agent:main:root",
      }),
    ).rejects.toThrow("Invalid recipient authority epoch for session agent:main:root");
    expect(await listCustodyRecordsForTest({ ownerSessionKey: "session-2" })).toEqual([]);
  });

  it("preserves fanoutMode through the custody round-trip", async () => {
    await enqueuePendingDelegate("session-1", {
      task: "tree task",
      fanoutMode: "tree",
    });

    expect((await consumePendingDelegates("session-1"))[0]).toMatchObject({
      task: "tree task",
      fanoutMode: "tree",
      recipientAuthorityBinding: {
        version: 1,
        selection: "pending",
        fanoutMode: "tree",
      },
    });
  });

  it("fails closed when a persisted authority binding is malformed", async () => {
    const recordId = await queueRawRecord("session-1", {
      kind: "continuation_delegate",
      task: "malformed authority",
      recipientAuthorityBinding: {
        version: 1,
        selection: "selected",
        recipients: [
          {
            sessionKey: "agent:main:root",
            authority: { state: "bound", epoch: "not-a-uuid" },
          },
        ],
      },
    });

    expect(await consumePendingDelegates("session-1")).toEqual([]);
    expect((await readRecord(recordId)).status).toBe("failed");
  });

  it("preserves traceparent through the custody round-trip", async () => {
    await enqueuePendingDelegate("session-1", {
      task: "traced task",
      traceparent: VALID_TRACEPARENT,
    });

    expect((await consumePendingDelegates("session-1"))[0]).toMatchObject({
      task: "traced task",
      traceparent: VALID_TRACEPARENT,
    });
  });

  it("ignores an unmarked persisted traceparent", async () => {
    await queueRawRecord("session-1", {
      kind: "continuation_delegate",
      task: "attacker traced task",
      traceparent: VALID_TRACEPARENT,
    });

    const delegate = expectDefined((await consumePendingDelegates("session-1")).at(0), "delegate");
    expect(delegate.task).toBe("attacker traced task");
    expect(delegate.traceparent).toBeUndefined();
  });

  it("omits traceparent when the custody record has no carrier", async () => {
    await enqueuePendingDelegate("session-1", { task: "untraced task" });

    const delegate = expectDefined((await consumePendingDelegates("session-1")).at(0), "delegate");
    expect(delegate.task).toBe("untraced task");
    expect(delegate.traceparent).toBeUndefined();
  });

  it("preserves model override through the custody round-trip", async () => {
    await enqueuePendingDelegate("session-1", {
      task: "model task",
      model: "github-copilot/claude-sonnet-4.6",
    });

    expect((await consumePendingDelegates("session-1"))[0]).toMatchObject({
      task: "model task",
      model: "github-copilot/claude-sonnet-4.6",
    });
  });

  it("omits model when the custody record has no override", async () => {
    await enqueuePendingDelegate("session-1", { task: "modelless task" });

    const delegate = expectDefined((await consumePendingDelegates("session-1")).at(0), "delegate");
    expect(delegate.task).toBe("modelless task");
    expect(delegate.model).toBeUndefined();
  });

  it("decodes legacy silent and silentWake dual-flag rows as silent-wake", async () => {
    const recordId = await queueRawRecord("session-1", {
      kind: "continuation_delegate",
      task: "legacy silent wake task",
      silent: true,
      silentWake: true,
    });

    const delegates = await consumePendingDelegates("session-1");
    expect(delegates).toEqual([
      expect.objectContaining({
        task: "legacy silent wake task",
        mode: "silent-wake",
      }),
    ]);
    expect((await readRecord(recordId)).status).toBe("running");
  });

  it("rejects malformed multi-flag rows instead of choosing precedence", async () => {
    const recordId = await queueRawRecord("session-1", {
      kind: "continuation_delegate",
      task: "malformed mode task",
      silent: true,
      postCompaction: true,
    });

    expect(await consumePendingDelegates("session-1")).toEqual([]);
    expect((await readRecord(recordId)).status).toBe("failed");
  });

  it("rejects rows that combine explicit targets with fanoutMode", async () => {
    const recordId = await queueRawRecord("session-1", {
      kind: "continuation_delegate",
      task: "malformed targeting task",
      targetSessionKey: "agent:main:root",
      fanoutMode: "tree",
    });

    expect(await consumePendingDelegates("session-1")).toEqual([]);
    expect((await readRecord(recordId)).status).toBe("failed");
  });

  it("cancels all delegates (regular + post-compaction)", async () => {
    await enqueuePendingDelegate("session-1", { task: "regular" });
    await stagePostCompactionCustodyDelegate("session-1", {
      task: "post-compact",
      stagedAt: Date.now(),
    });

    expect(pendingDelegateCount("session-1")).toBe(1);
    expect(stagedPostCompactionDelegateCount("session-1")).toBe(1);

    await cancelPendingDelegates("session-1");

    expect(pendingDelegateCount("session-1")).toBe(0);
    expect(stagedPostCompactionDelegateCount("session-1")).toBe(0);
  });

  it("records the delegate kind of each producer", async () => {
    await enqueuePendingDelegate("session-1", { task: "regular" });
    await stagePostCompactionCustodyDelegate("session-1", {
      task: "post-compact",
      stagedAt: Date.now(),
    });

    const records = await listCustodyRecordsForTest({ ownerSessionKey: "session-1" });
    expect(expectDefined(records.at(0), "first record").kind).toBe("delegate");
    expect(expectDefined(records.at(1), "second record").kind).toBe("post_compaction");
  });
});
