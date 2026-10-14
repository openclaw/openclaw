import { createHash } from "node:crypto";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import type { SqliteWorkerRequest } from "../infra/sqlite-worker-contract.js";
import { reserveSqliteWorkerInputPreparation } from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveDebugProxySettings } from "./env.js";
import { captureWsEventAsync, finalizeDebugProxyCaptureAsync } from "./runtime.js";
import { acquireDebugProxyCaptureStoreAsync } from "./store.async.js";

const MIB = 1024 * 1024;
afterEach(() => vi.restoreAllMocks());

function holdCaptureReply(boundary: "cold" | "write") {
  const held = createDeferredCore();
  let selected: { worker: Worker; id: number } | undefined;
  let captured = false;
  let publish: (() => void) | undefined;
  // oxlint-disable-next-line typescript/unbound-method -- The original receiver is restored below.
  const nativePost = Worker.prototype.postMessage;
  const posts = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (!captured) {
      const command: unknown = request.type === "execute" ? deserialize(request.input) : undefined;
      if (
        (boundary === "cold" && request.type === "open") ||
        (boundary === "write" &&
          isRecord(command) &&
          command.type === "capture.recordEventWithPayload")
      ) {
        captured = true;
        selected = { worker: this, id: request.id };
      }
    }
    return nativePost.call(this, request, transferList);
  });
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply retains the emitting worker.
  const nativeEmit = Worker.prototype.emit;
  const replies = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (
      event === "message" &&
      selected?.worker === this &&
      isRecord(args[0]) &&
      args[0].id === selected.id
    ) {
      selected = undefined;
      publish = () => Reflect.apply(nativeEmit, this, [event, ...args]);
      held.resolve();
      return true;
    }
    return Reflect.apply(nativeEmit, this, [event, ...args]);
  });
  return {
    held: held.promise,
    release() {
      posts.mockRestore();
      replies.mockRestore();
      publish?.();
      publish = undefined;
    },
  };
}

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

it.each([
  { boundary: "cold", payloadKind: "Buffer" },
  { boundary: "write", payloadKind: "two-byte string" },
] as const)(
  "charges queued $payloadKind bytes while $boundary admission is blocked and returns credits after settlement",
  async ({ boundary, payloadKind }) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "capture-input-admission" },
      async (state) => {
        const settings = {
          ...resolveDebugProxySettings(state.env),
          enabled: true,
          sessionId: "input-admission",
        };
        // Leave 5 MiB for two 2 MiB inputs and their metadata; reservations allocate no payload.
        const otherInputs = [64, 64, 64, 59].map((size) =>
          reserveSqliteWorkerInputPreparation(size * MIB),
        );
        const data =
          payloadKind === "Buffer" ? Buffer.alloc(2 * MIB, "a") : "a".repeat(MIB - 1) + "\u0100";
        const expectedDigest = digest(data);
        const hold = holdCaptureReply(boundary);
        const pending: Promise<void>[] = [];
        const capture = (flowId: string) => {
          const writing = captureWsEventAsync(
            {
              url: "wss://synthetic.invalid/capture",
              direction: "outbound",
              kind: "ws-frame",
              flowId,
              payload: data,
            },
            settings,
          );
          pending.push(writing);
          return writing;
        };
        try {
          const first = capture("first");
          await Promise.race([
            hold.held,
            first.then(() => {
              throw new Error("Capture completed without holding its expected reply");
            }),
          ]);
          const second = capture("second");
          expect(() => {
            const extra = reserveSqliteWorkerInputPreparation(MIB);
            extra.release();
          }).toThrow(expect.objectContaining({ code: "overloaded" }));
          await expect(capture("refused")).rejects.toMatchObject({ code: "overloaded" });
          if (Buffer.isBuffer(data)) {
            data.fill("b");
          }
          hold.release();
          await Promise.all([first, second]);
          await expect(finalizeDebugProxyCaptureAsync(settings)).rejects.toBeInstanceOf(
            AggregateError,
          );
          const recovered = reserveSqliteWorkerInputPreparation(5 * MIB);
          recovered.release();
          for (const input of otherInputs) {
            input.release();
          }
          const reader = await acquireDebugProxyCaptureStoreAsync({ env: state.env });
          try {
            const events = (await reader.store.getSessionEvents(settings.sessionId)).toReversed();
            expect(events.map((event) => event.flowId)).toEqual(["first", "second"]);
            for (const event of events) {
              if (typeof event.dataBlobId !== "string") {
                throw new Error("Expected captured payload blob");
              }
              const content = await reader.store.readBlob(event.dataBlobId);
              expect(content).not.toBeNull();
              expect(digest(content!)).toBe(expectedDigest);
            }
          } finally {
            await reader.release();
          }
        } finally {
          hold.release();
          for (const input of otherInputs) {
            input.release();
          }
          await Promise.allSettled(pending);
          await Promise.allSettled([finalizeDebugProxyCaptureAsync(settings)]);
        }
      },
    );
  },
);
