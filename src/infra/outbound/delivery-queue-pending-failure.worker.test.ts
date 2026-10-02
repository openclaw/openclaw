import fs from "node:fs/promises";
import path from "node:path";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createQueuedDeliveryOwner } from "./deliver-queue-state.js";
import { failPendingDelivery } from "./delivery-queue-ack.js";
import {
  claimDeliveryPlatformSendAttempt,
  enqueueDelivery,
  loadPendingDelivery,
} from "./delivery-queue-storage.js";
import { holdDeliveryQueueReply } from "./delivery-queue-worker-reply.test-support.js";
import {
  installDeliveryQueueTmpDirHooks,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

describe("pending delivery failure worker", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function fixture() {
    const stateDir = tmpDir();
    const artifact = path.join(
      stateDir,
      "delivery-queue-media",
      "00000000-0000-4000-8000-000000000001.ogg",
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "synthetic media");
    const id = await enqueueDelivery(
      { channel: "directchat", to: "synthetic", payloads: [{ mediaUrl: artifact }] },
      stateDir,
    );
    const entry = await loadPendingDelivery(id, stateDir);
    if (!entry) {
      throw new Error("Expected pending fixture");
    }
    return { stateDir, artifact, id, entry };
  }

  it("settles pending custody and releases its media without host data SQL", async () => {
    const { stateDir, artifact, id, entry } = await fixture();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sql = observeHostDataSql();
    try {
      openOpenClawStateDatabase({ env }).db.prepare("SELECT 1").get();
      expect(sql.calls.some((call) => call.mock.calls.length > 0)).toBe(true);
      sql.calls.forEach((call) => call.mockClear());
      await expect(failPendingDelivery({ id, entry }, stateDir)).resolves.toEqual({
        status: "failed",
      });
      expect(sql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      sql.restore();
    }
    expect(await loadPendingDelivery(id, stateDir)).toBeNull();
    await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures entry, cleanup preference, media, and selected state before admission", async () => {
    const { stateDir, artifact, id, entry } = await fixture();
    const otherStateDir = path.join(stateDir, "other-state");
    const otherArtifact = path.join(
      path.dirname(artifact),
      "00000000-0000-4000-8000-000000000002.ogg",
    );
    await fs.writeFile(otherArtifact, "unrelated media");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const params = { id, entry, retainSpoolArtifacts: false };
    const failure = failPendingDelivery(params);
    params.id = "changed-after-admission";
    entry.id = params.id;
    params.retainSpoolArtifacts = true;
    acceptedPreparedOutboundEntries(entry.preparedBatch)[0]!.payload.mediaUrl = otherArtifact;
    vi.stubEnv("OPENCLAW_STATE_DIR", otherStateDir);
    await expect(failure).resolves.toEqual({ status: "failed" });
    expect(await loadPendingDelivery(id, stateDir)).toBeNull();
    await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(otherArtifact, "utf8")).toBe("unrelated media");
    await expect(fs.stat(otherStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps renewed claim custody and media when its captured row changes before execution", async () => {
    const { stateDir, artifact, id } = await fixture();
    const claimId = await claimDeliveryPlatformSendAttempt(id, stateDir);
    const entry = await loadPendingDelivery(id, stateDir);
    if (!claimId || !entry) {
      throw new Error("Expected claimed fixture");
    }
    const failure = failPendingDelivery(
      { id, entry, expectedPlatformSendAttemptId: claimId },
      stateDir,
    );
    setQueuedEntryState(stateDir, id, {
      retryCount: 1,
      producerClaimId: claimId,
      availableAt: Date.now() + 120_000,
    });
    await expect(failure).resolves.toEqual({ status: "not_pending" });
    expect(await loadPendingDelivery(id, stateDir)).toMatchObject({
      retryCount: 1,
      producerClaimId: claimId,
    });
    expect(await fs.readFile(artifact, "utf8")).toBe("synthetic media");
  });

  it("validates an explicit undefined claim before opening missing storage", async () => {
    const { entry } = await fixture();
    const unopened = path.join(tmpDir(), "unopened");
    await expect(
      failPendingDelivery(
        { id: "different-id", entry, expectedPlatformSendAttemptId: undefined },
        unopened,
      ),
    ).rejects.toThrow("Delivery queue entry id mismatch");
    await expect(fs.stat(unopened)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains media after a confirmed failure when its caller owns cleanup", async () => {
    const { stateDir, artifact, id, entry } = await fixture();
    await expect(
      failPendingDelivery({ id, entry, retainSpoolArtifacts: true }, stateDir),
    ).resolves.toEqual({ status: "failed" });
    expect(await loadPendingDelivery(id, stateDir)).toBeNull();
    expect(await fs.readFile(artifact, "utf8")).toBe("synthetic media");
  });

  it("does not replay or unlink when the committed worker reply is lost", async () => {
    const { stateDir, artifact, id } = await fixture();
    const owner = createQueuedDeliveryOwner({ queueId: id, stateDir });
    const reply = holdDeliveryQueueReply("deliveryQueue.failPending", id, (value) =>
      isRecord(value) ? value : undefined,
    );
    const outcome = owner.retire().then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        reply.held,
        outcome.then((error) => {
          throw new Error("Retirement settled before its committed worker reply", { cause: error });
        }),
      ]);
      await reply.lose();
      const failure = await outcome;
      expect(collectNestedErrorCandidates(failure).map(extractErrorCode)).toContain(
        "outcome-unknown",
      );
      expect(reply.attempts()).toBe(1);
    } finally {
      reply.restore();
      reply.release();
      await outcome;
    }
    expect(owner.custody).toBe("held");
    await closeOpenClawStateDatabaseAsync();
    expect(await loadPendingDelivery(id, stateDir)).toBeNull();
    expect(await fs.readFile(artifact, "utf8")).toBe("synthetic media");
  });
});
