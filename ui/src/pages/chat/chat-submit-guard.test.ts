// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ChatHost } from "./chat-send-contract.ts";
import { withChatSubmissionGuard, withChatSubmitGuard } from "./chat-submit-guard.ts";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createHost(): ChatHost {
  return { chatSubmitGuards: new Map<string, Promise<void>>() } as ChatHost;
}

describe("withChatSubmitGuard", () => {
  it("publishes a logical submission before starting it synchronously", async () => {
    const calls: string[] = [];
    const host = createHost();
    let reentry: Promise<string> | undefined;

    const first = withChatSubmissionGuard(host, "logical-sync", async () => {
      calls.push("original");
      reentry = withChatSubmissionGuard(host, "logical-sync", async () => {
        calls.push("duplicate");
        return "duplicate";
      });
      return "original";
    });

    expect(calls).toEqual(["original"]);
    expect(reentry).toBe(first);
    await expect(first).resolves.toBe("original");
    await expect(reentry).resolves.toBe("original");
    expect(calls).toEqual(["original"]);
  });

  it("runs three distinct same-key submissions in fair FIFO order", async () => {
    const gate = createDeferred<void>();
    const order: string[] = [];
    const host = createHost();

    const first = withChatSubmitGuard(host, "same-key", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    expect(order).toEqual(["first:start"]);

    const second = withChatSubmitGuard(host, "same-key", async () => {
      order.push("second");
    });
    const third = withChatSubmitGuard(host, "same-key", async () => {
      order.push("third");
    });

    expect(order).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second, third]);

    expect(order).toEqual(["first:start", "first:end", "second", "third"]);
  });

  it("deduplicates concurrent and settled handler reentry by submission id", async () => {
    const gate = createDeferred<void>();
    const calls: string[] = [];
    const host = createHost();
    const run = async () => {
      calls.push("original");
      await gate.promise;
    };

    const first = withChatSubmissionGuard(host, "logical-submission", run);
    const reentry = withChatSubmissionGuard(host, "logical-submission", run);
    await Promise.resolve();
    expect(calls).toEqual(["original"]);

    gate.resolve();
    await Promise.all([first, reentry]);
    await expect(withChatSubmissionGuard(host, "logical-submission", run)).resolves.toBeUndefined();

    expect(calls).toEqual(["original"]);
  });

  it("continues the same-key FIFO lane after an earlier submission rejects", async () => {
    const gate = createDeferred<void>();
    const order: string[] = [];
    const host = createHost();

    const first = withChatSubmitGuard(host, "same-key", async () => {
      order.push("first");
      await gate.promise;
      throw new Error("first failed");
    });
    const second = withChatSubmitGuard(host, "same-key", async () => {
      order.push("second");
    });
    const third = withChatSubmitGuard(host, "same-key", async () => {
      order.push("third");
    });

    gate.resolve();
    const settled = await Promise.allSettled([first, second, third]);

    expect(settled.map((entry) => entry.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(order).toEqual(["first", "second", "third"]);
  });
});
