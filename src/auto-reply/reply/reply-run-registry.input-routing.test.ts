import { afterEach, describe, expect, it } from "vitest";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
describe("reply operation input-routing custody", () => {
  afterEach(() => testing.resetReplyRunRegistry());
  it("retains source order when later routing finishes or cancels first", async () => {
    const operation = createTestReplyOperation();
    const first = operation.reserveInputRouting();
    const second = operation.reserveInputRouting();
    const third = operation.reserveInputRouting();
    const ready: string[] = [];
    void second.ready.then(() => ready.push("second"));
    void third.ready.then(() => ready.push("third"));
    await first.ready;
    second.release();
    second.release();
    await Promise.resolve();
    expect(ready).toEqual([]);
    first.release();
    await third.ready;
    expect(ready).toEqual(["second", "third"]);
    third.release();
    operation.complete();
  });

  it("keeps routing custody across source completion without blocking a successor owner", async () => {
    const operation = createTestReplyOperation();
    const first = operation.reserveInputRouting();
    const pending = operation.reserveInputRouting();
    let ready = false;
    void pending.ready.then(() => {
      ready = true;
    });
    await first.ready;
    operation.complete();
    const successor = createTestReplyOperation({ sessionId: "successor" });
    const independent = successor.reserveInputRouting();
    await independent.ready;
    expect(ready).toBe(false);
    first.release();
    await pending.ready;
    expect(ready).toBe(true);
    pending.release();
    independent.release();
    successor.complete();
  });
});
