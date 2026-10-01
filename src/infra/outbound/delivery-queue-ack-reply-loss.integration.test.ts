import fs from "node:fs/promises";
import path from "node:path";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import {
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { holdAcknowledgementReply } from "./delivery-queue-ack.worker.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import * as queueStorage from "./delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("outbound ACK reply loss", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each(["pre-send fallback", "post-send settlement"] as const)(
    "does not replay a committed %s or release unacknowledged media",
    async (phase) => {
      const stateDir = fixtures.tmpDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const artifact = path.join(
        stateDir,
        "delivery-queue-media",
        "00000000-0000-4000-8000-000000000001.txt",
      );
      await fs.mkdir(path.dirname(artifact), { recursive: true });
      await fs.writeFile(artifact, "synthetic queued audio");
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "matrix",
              outbound: matrixOutboundForQueueTest,
            }),
          },
        ]),
      );
      if (phase === "pre-send fallback") {
        vi.spyOn(queueStorage, "markDeliveryPlatformSendAttemptStarted").mockRejectedValueOnce(
          new Error("synthetic marker failure"),
        );
      }
      const send = vi.fn(async () => ({ messageId: "synthetic-sent" }));
      const queued = createDeferredCore<{
        id: string;
        reply: ReturnType<typeof holdAcknowledgementReply>;
      }>();
      const outcome = deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ text: "synthetic delivery", mediaUrl: artifact }],
        queuePolicy: phase === "pre-send fallback" ? "best_effort" : "required",
        requireUnknownSendReconciliation: false,
        deps: { matrix: send },
        onDeliveryIntent: ({ id }) => queued.resolve({ id, reply: holdAcknowledgementReply(id) }),
      }).then(
        (results) => ({ results }),
        (error: unknown) => ({ error }),
      );
      const { id, reply } = await Promise.race([
        queued.promise,
        outcome.then((result) => {
          throw "error" in result
            ? result.error
            : new Error("Delivery settled before queue custody");
        }),
      ]);
      let failure: unknown;
      let committedArtifact = "";
      try {
        const committedPaths = await Promise.race([
          reply.held,
          outcome.then((result) => {
            throw "error" in result
              ? result.error
              : new Error("Delivery settled before committed ACK reply");
          }),
        ]);
        expect(committedPaths).toHaveLength(1);
        committedArtifact = committedPaths[0]!;
        expect(path.dirname(committedArtifact)).toBe(path.join(stateDir, "delivery-queue-media"));
        expect(send).toHaveBeenCalledTimes(phase === "pre-send fallback" ? 0 : 1);
        await expect(fs.readFile(committedArtifact, "utf8")).resolves.toBe(
          "synthetic queued audio",
        );
        await reply.lose();
        const result = await outcome;
        expect(result).toHaveProperty("error");
        failure = "error" in result ? result.error : undefined;
        expect(collectNestedErrorCandidates(failure).map(extractErrorCode)).toContain(
          "outcome-unknown",
        );
        expect(reply.attempts()).toBe(1);
      } finally {
        reply.restore();
        reply.release();
        await outcome;
      }
      expect(send).toHaveBeenCalledTimes(phase === "pre-send fallback" ? 0 : 1);
      await closeOpenClawStateDatabaseAsync();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir),
      ).toBeUndefined();
      await expect(fs.readFile(committedArtifact, "utf8")).resolves.toBe("synthetic queued audio");
      const recover = vi.fn(deliverOutboundPayloads);
      await drainMatrixReconnect({ stateDir, deliver: recover });
      expect(recover).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(phase === "pre-send fallback" ? 0 : 1);
    },
  );
});
