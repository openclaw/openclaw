import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createSystemdPeerQueue } from "./systemd-peer-queue.js";

afterEach(() => vi.useRealTimers());

it("continues on the original peer after a completed query failure", async () => {
  const queue = createSystemdPeerQueue();
  await expect(
    queue.run(performance.now() + 1000, async () => {
      throw new Error("property unavailable");
    }),
  ).rejects.toThrow("property unavailable");
  await expect(queue.run(performance.now() + 1000, async () => "same peer")).resolves.toBe(
    "same peer",
  );
});

it("expires queued work on time without executing it or releasing active native work", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const queue = createSystemdPeerQueue();
  const started = createDeferred();
  const release = createDeferred();
  const first = queue.run(performance.now() + 1000, async () => {
    started.resolve();
    await release.promise;
    return "first";
  });
  await started.promise;
  const execute = vi.fn(async () => "must not run");
  const second = queue.run(performance.now() + 50, execute);
  const expired = expect(second).rejects.toThrow("deadline expired");
  let joined = false;
  const joining = queue.drain().then(() => {
    joined = true;
  });
  await vi.advanceTimersByTimeAsync(50);
  await expired;
  expect(joined).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  release.resolve();
  await expect(first).resolves.toBe("first");
  await joining;
  expect(execute).not.toHaveBeenCalled();
  expect(joined).toBe(true);
});
