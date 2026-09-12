import assert from "node:assert/strict";
import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "./worker-task-pool.js";

export type PoolFixtureInput = {
  label: string;
  exchanges?: number;
  counters?: SharedArrayBuffer;
  wait?: boolean;
  exitCode?: number;
  buffer?: ArrayBuffer;
  relayBuffer?: boolean;
};
export type PoolFixtureResult = {
  label: string;
  threadId: number;
  buffer?: ArrayBuffer;
  previousBufferBytes?: number;
  relayedBufferBytes?: number;
};

let previousBuffer: ArrayBuffer | undefined;
serveWorkerTasks<PoolFixtureResult>(
  async (input, channel) => {
    assert.ok(isRecord(input));
    assert.ok(typeof input.label === "string");
    if (input.exitCode !== undefined) {
      assert.ok(typeof input.exitCode === "number");
      process.exit(input.exitCode);
    }
    if (input.counters) {
      assert.ok(input.counters instanceof SharedArrayBuffer);
      const counters = new Int32Array(input.counters);
      Atomics.add(counters, 0, 1);
      if (input.wait) {
        Atomics.wait(counters, 1, 0);
      }
    }
    let relayedBufferBytes: number | undefined;
    if (input.exchanges && channel) {
      channel.consumeInput();
      for (let index = 0; index < Number(input.exchanges); index++) {
        const buffer =
          input.relayBuffer && input.buffer instanceof ArrayBuffer ? input.buffer : undefined;
        const response = await channel.request(
          { label: input.label, buffer },
          buffer ? [buffer] : undefined,
        );
        if (buffer) {
          relayedBufferBytes = buffer.byteLength;
          input.buffer = undefined;
        }
        if (response.input instanceof ArrayBuffer) {
          input.buffer = response.input;
        }
        response.consumed();
      }
    }
    const previousBufferBytes = previousBuffer?.byteLength;
    assert.ok(input.buffer === undefined || input.buffer instanceof ArrayBuffer);
    previousBuffer = input.buffer;
    return {
      label: input.label,
      threadId,
      buffer: input.buffer,
      previousBufferBytes,
      relayedBufferBytes,
    };
  },
  { transferList: (value) => (value.buffer ? [value.buffer] : []) },
);
