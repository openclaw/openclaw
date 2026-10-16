import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createBrokerReceiver, createBrokerSender, MAX_PENDING_BYTES } from "./ipc.js";

it.each([16, 2 * 1024 * 1024])(
  "rechecks launch authority after queued preparation before the final %i-byte command frame",
  async (size) => {
    const firstWrite = createDeferredCore();
    const receiver = createBrokerReceiver();
    const received: unknown[] = [];
    let acknowledge: ((error: Error | null) => void) | undefined;
    const nativeSend = vi.fn<Parameters<typeof createBrokerSender>[0]>(
      (message, _handle, callback) => {
        const decoded = receiver.receive(message);
        if (decoded !== undefined) {
          received.push(decoded);
        }
        if (!acknowledge) {
          acknowledge = callback;
          firstWrite.resolve();
        } else {
          callback(null);
        }
      },
    );
    const sender = createBrokerSender(nativeSend);
    const preparation = sender({ type: "prepare" });
    await firstWrite.promise;
    let current = true;
    let initiated = false;
    const pending = sender({ type: "start", data: "x".repeat(size) }, undefined, (launch) => {
      if (!current) {
        throw new Error("launch authority revoked");
      }
      initiated = true;
      return launch();
    });
    const refused = expect(pending).rejects.toThrow("launch authority revoked");
    current = false;
    acknowledge?.(null);
    await preparation;
    await refused;
    expect(initiated).toBe(false);
    expect(received).toEqual([{ type: "prepare" }]);
    await sender({ type: "permitted" });
    expect(received).toEqual([{ type: "prepare" }, { type: "permitted" }]);
  },
);

it("reclaims abandoned frame capacity when the serialized producer starts another message", async () => {
  const receiver = createBrokerReceiver();
  receiver.receive({
    kind: "openclaw-spawn-broker-frame",
    id: 99,
    total: MAX_PENDING_BYTES,
    offset: 0,
    bytes: Buffer.from("unfinished"),
  });
  const message = { type: "permitted", data: "x".repeat(1024 * 1024) };
  const received: unknown[] = [];
  const sender = createBrokerSender((frame, _handle, callback) => {
    const decoded = receiver.receive(frame);
    if (decoded !== undefined) {
      received.push(decoded);
    }
    callback(null);
  });
  await sender(message);
  expect(received).toEqual([message]);
});
