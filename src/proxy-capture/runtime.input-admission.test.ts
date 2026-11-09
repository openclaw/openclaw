import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { SqliteWorkerRequest } from "../infra/sqlite-worker-contract.js";
import { reserveSqliteWorkerInputPreparation as reserveInput } from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveDebugProxySettings } from "./env.js";
import { captureWsEventAsync, finalizeDebugProxyCaptureAsync } from "./runtime.js";
import { acquireDebugProxyCaptureStoreAsync } from "./store.async.js";

const MIB = 1024 * 1024;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function holdCaptureReply(boundary: "cold" | "write") {
  const held = createDeferredCore();
  let publish: (() => void) | undefined;
  let restoreReply = () => {};
  // oxlint-disable-next-line typescript/unbound-method -- The original receiver is restored below.
  const nativePost = Worker.prototype.postMessage;
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  posts.mockImplementation(function (this: Worker, request: SqliteWorkerRequest, transferList) {
    const command: unknown = request.type === "execute" ? deserialize(request.input) : undefined;
    if (
      boundary === "cold"
        ? request.type === "open"
        : isRecord(command) && command.type === "capture.recordEventWithPayload"
    ) {
      posts.mockRestore();
      const emit = this.emit.bind(this);
      const replies = vi.spyOn(this, "emit");
      restoreReply = () => replies.mockRestore();
      replies.mockImplementation((event: string | symbol, ...args: unknown[]) => {
        if (event === "message" && isRecord(args[0]) && args[0].id === request.id) {
          restoreReply();
          publish = () => emit(event, ...args);
          held.resolve();
          return true;
        }
        return emit(event, ...args);
      });
    }
    return nativePost.call(this, request, transferList);
  });
  return {
    held: held.promise,
    release() {
      posts.mockRestore();
      restoreReply();
      publish?.();
      publish = undefined;
    },
  };
}

it.each(["cold", "write"] as const)("reserves bytes during %s admission", async (boundary) =>
  withOpenClawTestState(
    { scenario: "external-service", label: "capture-input-admission" },
    async (state) => {
      const settings = resolveDebugProxySettings(state.env);
      Object.assign(settings, { enabled: true, sessionId: "input-admission" });
      const finalize = () => finalizeDebugProxyCaptureAsync(settings);
      // Leave 5 MiB for two 2 MiB inputs and their metadata; reservations allocate no payload.
      const otherInputs = [64, 64, 64, 59].map((size) => reserveInput(size * MIB));
      const releaseInputs = () => otherInputs.forEach((input) => input.release());
      const data =
        boundary === "cold" ? Buffer.alloc(2 * MIB, "a") : "a".repeat(MIB - 1) + "\u0100";
      const expectedDigest = digest(data);
      const hold = holdCaptureReply(boundary);
      const pending: Promise<void>[] = [];
      const overloaded = { code: "overloaded" };
      const frame = {
        url: "wss://synthetic.invalid/capture",
        direction: "outbound" as const,
        kind: "ws-frame" as const,
        payload: data,
      };
      const capture = (flowId: string) => {
        const writing = captureWsEventAsync({ ...frame, flowId }, settings);
        pending.push(writing);
        return writing;
      };
      try {
        const first = capture("first");
        await Promise.race([
          hold.held,
          first.then(() => assert.fail("Capture completed before its reply was held")),
        ]);
        const second = capture("second");
        expect(() => reserveInput(MIB).release()).toThrow(expect.objectContaining(overloaded));
        await expect(capture("refused")).rejects.toMatchObject(overloaded);
        if (Buffer.isBuffer(data)) {
          data.fill("b");
        }
        hold.release();
        await Promise.all([first, second]);
        await expect(finalize()).rejects.toBeInstanceOf(AggregateError);
        reserveInput(5 * MIB).release();
        releaseInputs();
        const reader = await acquireDebugProxyCaptureStoreAsync({ env: state.env });
        try {
          const events = (await reader.store.getSessionEvents(settings.sessionId)).toReversed();
          expect(events.map((event) => event.flowId)).toEqual(["first", "second"]);
          for (const event of events) {
            assert(typeof event.dataBlobId === "string", "Expected captured payload blob");
            const content = await reader.store.readBlob(event.dataBlobId);
            expect(content).not.toBeNull();
            expect(digest(content!)).toBe(expectedDigest);
          }
        } finally {
          await reader.release();
        }
      } finally {
        hold.release();
        releaseInputs();
        await Promise.allSettled(pending);
        await Promise.allSettled([finalize()]);
      }
    },
  ),
);
