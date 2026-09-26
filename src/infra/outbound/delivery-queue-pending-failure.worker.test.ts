import fs from "node:fs/promises";
import path from "node:path";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { SqliteWorkerRequest } from "../sqlite-worker-contract.js";
import { createQueuedDeliveryOwner } from "./deliver-queue-state.js";
import { failPendingDelivery } from "./delivery-queue-ack.js";
import {
  claimDeliveryPlatformSendAttempt,
  enqueueDelivery,
  loadPendingDelivery,
} from "./delivery-queue-storage.js";
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
    const sql = observeHostDataSql(env);
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
    let requestId: number | undefined;
    let threadId: number | undefined;
    let stopped: Promise<number> | undefined;
    let attempts = 0;
    let dropped = false;
    // oxlint-disable-next-line typescript/unbound-method -- call restores the worker receiver.
    const originalPost = Worker.prototype.postMessage;
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply restores the worker receiver.
    const originalEmit = Worker.prototype.emit;
    const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      if (request.type === "execute") {
        const command: unknown = deserialize(request.input);
        if (
          command &&
          typeof command === "object" &&
          "type" in command &&
          command.type === "deliveryQueue.failPending"
        ) {
          requestId = request.id;
          threadId = this.threadId;
          attempts++;
        }
      }
      return originalPost.call(this, request, transferList);
    });
    const emit = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const reply = args[0];
      if (
        !dropped &&
        this.threadId === threadId &&
        event === "message" &&
        reply &&
        typeof reply === "object" &&
        "id" in reply &&
        reply.id === requestId &&
        "ok" in reply &&
        reply.ok === true
      ) {
        dropped = true;
        stopped = this.terminate();
        return false;
      }
      return Reflect.apply(originalEmit, this, [event, ...args]);
    });
    try {
      const outcomes = await Promise.allSettled([owner.retire()]);
      expect(outcomes[0]?.status).toBe("rejected");
      if (outcomes[0]?.status === "rejected") {
        expect(collectNestedErrorCandidates(outcomes[0].reason).map(extractErrorCode)).toContain(
          "outcome-unknown",
        );
      }
    } finally {
      post.mockRestore();
      emit.mockRestore();
      await stopped;
    }
    expect(dropped).toBe(true);
    expect(attempts).toBe(1);
    expect(owner.custody).toBe("held");
    await closeOpenClawStateDatabaseAsync();
    expect(await loadPendingDelivery(id, stateDir)).toBeNull();
    expect(await fs.readFile(artifact, "utf8")).toBe("synthetic media");
  });
});
