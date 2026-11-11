import { flush } from "../../../test-helpers/solid-settle.ts";

/** Advance a new transcript's two mount frames without changing later frame scheduling.
 * Already queued frames belong to the caller's clock and must be advanced there.
 */
export function settleChatMount<T>(mount: () => T): T {
  const request = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  const pending = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = (callback) => {
    const id = request.call(globalThis, (timestamp) => {
      if (pending.delete(id)) {
        callback(timestamp);
      }
    });
    pending.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    pending.delete(id);
    cancel.call(globalThis, id);
  };
  try {
    const view = mount();
    flush();
    for (let frame = 0; frame < 2; frame += 1) {
      const batch = [...pending];
      for (const [id, callback] of batch) {
        if (pending.delete(id)) {
          cancel.call(globalThis, id);
          callback(performance.now());
        }
      }
      flush();
    }
    return view;
  } finally {
    globalThis.requestAnimationFrame = request;
    globalThis.cancelAnimationFrame = cancel;
  }
}
