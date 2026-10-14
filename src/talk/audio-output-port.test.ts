import { once } from "node:events";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createRealtimeVoiceAudioPortSender } from "./audio-output-port.js";

describe("worker audio output port", () => {
  it("orders interruption before new PCM, owns buffers, and honors immediate sink revocation", async () => {
    const { port1, port2 } = new MessageChannel();
    const state = new SharedArrayBuffer(4);
    const sender = createRealtimeVoiceAudioPortSender({ port: port1, state });
    try {
      const first = once(port2, "message");
      const caller = Buffer.from([1, 2]);
      sender.sendAudio(caller);
      caller.fill(9);
      expect((await first)[0]).toEqual({ type: "audio", audio: new Uint8Array([1, 2]) });
      sender.sendAudio(Buffer.from([3, 4]));
      const clear = once(port2, "message");
      sender.clear();
      sender.sendAudio(Buffer.from([5, 6]));
      expect((await clear)[0]).toEqual({ type: "clear" });
      const next = once(port2, "message");
      // Node MessagePort acknowledgment, not a Window message.
      port2.postMessage({ type: "ack" });
      expect((await next)[0]).toEqual({ type: "audio", audio: new Uint8Array([5, 6]) });

      // The sink can revoke synchronously before its worker processes stop.
      Atomics.store(new Int32Array(state), 0, 1);
      sender.sendAudio(Buffer.from([7, 8]));
      port2.postMessage({ type: "ack" });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(receiveMessageOnPort(port2)).toBeUndefined();
      sender.close();
      sender.close();
      expect(Atomics.load(new Int32Array(state), 0)).toBe(1);
    } finally {
      sender.close();
      port2.close();
    }
  });
  it("flushes only after queued PCM is acknowledged and settles empty output", async () => {
    const { port1, port2 } = new MessageChannel();
    const sender = createRealtimeVoiceAudioPortSender({
      port: port1,
      state: new SharedArrayBuffer(4),
    });
    try {
      const first = once(port2, "message");
      sender.sendAudio(Buffer.from([1, 2]));
      expect((await first)[0]).toEqual({ type: "audio", audio: new Uint8Array([1, 2]) });
      sender.sendAudio(Buffer.from([3, 4]));
      port2.postMessage({ type: "flush", marker: 1 }, []);
      port2.postMessage({ type: "flush", marker: 2 }, []);
      const queued = once(port2, "message");
      port2.postMessage({ type: "ack" }, []);
      expect((await queued)[0]).toEqual({ type: "audio", audio: new Uint8Array([3, 4]) });
      expect(receiveMessageOnPort(port2)).toBeUndefined();
      const flushed = once(port2, "message");
      port2.postMessage({ type: "ack" }, []);
      expect((await flushed)[0]).toEqual({ type: "flushed", marker: 2 });
      const empty = once(port2, "message");
      port2.postMessage({ type: "flush", marker: 3 }, []);
      expect((await empty)[0]).toEqual({ type: "flushed", marker: 3 });
    } finally {
      sender.close();
      port2.close();
    }
  });
});
