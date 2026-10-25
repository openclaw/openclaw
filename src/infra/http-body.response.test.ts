import { setImmediate } from "node:timers/promises";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  cancelUnreadResponseBody,
  readResponseTextPrefix,
  readResponseTextSnippet,
  readResponseWithLimit,
} from "./http-body.js";
import { makeStallingStream } from "./http-body.test-support.js";

afterEach(() => vi.useRealTimers());

const bytes = (text: string) => new TextEncoder().encode(text);
const createResponse = (...chunks: string[]) => new Response(makeStream(chunks.map(bytes)));

function makeStream(
  chunks: Uint8Array[],
  delayMs?: number,
  cancel?: UnderlyingSource<Uint8Array>["cancel"],
) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs) {
          await new Promise((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
        controller.enqueue(chunk);
      }
      controller.close();
    },
    cancel,
  });
}

async function expectTimeout(read: Promise<unknown>, message: string | RegExp, advanceMs = 60) {
  const rejected = expect(read).rejects.toThrow(message);
  await vi.advanceTimersByTimeAsync(advanceMs);
  await rejected;
}

function expectCancelled(cancel: ReturnType<typeof vi.fn>, message: string) {
  expect(cancel).toHaveBeenCalledOnce();
  expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ message }));
}

function makeTricklingStream(intervalMs: number, onCancel?: (reason?: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = () => {
        if (cancelled) {
          return;
        }
        controller.enqueue(new Uint8Array([1]));
        timer = setTimeout(enqueue, intervalMs);
      };
      enqueue();
    },
    cancel(reason) {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
      onCancel?.(reason);
    },
  });
}

describe("cancelUnreadResponseBody", () => {
  it("cancels unread bodies and ignores cancellation failures", async () => {
    const cancel = vi.fn(() => {
      throw new Error("already closed");
    });
    const response = new Response(makeStallingStream([], cancel));

    await expect(cancelUnreadResponseBody(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("leaves consumed and absent bodies alone", async () => {
    const cancel = vi.fn();
    const consumed = new Response(makeStream([bytes("done")], undefined, cancel));
    await consumed.text();

    await cancelUnreadResponseBody(consumed);
    await cancelUnreadResponseBody(undefined);

    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not wait for a retained response clone to finish cancellation", async () => {
    const cancel = vi.fn();
    const response = new Response(makeStallingStream([], cancel));
    const capture = response.clone();
    const cleanup = cancelUnreadResponseBody(response);
    try {
      const completed = await Promise.race([cleanup.then(() => true), setImmediate(false)]);
      expect(completed).toBe(true);
      expect(response.bodyUsed).toBe(true);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await capture.body?.cancel();
      await cleanup;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("readResponseWithLimit", () => {
  it.each([undefined, 1_000])(
    "aborts prefix reads without awaiting cancellation (deadline %s)",
    async (timeoutMs) => {
      const readStarted = createDeferred();
      const cancel = vi.fn(async () => await new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            readStarted.resolve();
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      const controller = new AbortController();
      const reason = new Error("index request cancelled");
      const result = readResponseTextPrefix(new Response(body), 8, {
        signal: controller.signal,
        timeoutMs,
      }).catch((error: unknown) => error);

      try {
        await withTestTimeout(readStarted.promise, 1_000, "response read did not start");
        controller.abort(reason);

        await expect(withTestTimeout(result, 1_000, "response abort did not settle")).resolves.toBe(
          reason,
        );
        expect(cancel).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledWith(reason);
        expect(body.locked).toBe(false);
      } finally {
        controller.abort(reason);
      }
    },
  );

  it("cancels a pre-aborted full-body read without pulling or retaining the reader", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const reason = new Error("request already cancelled");

    await expect(
      readResponseWithLimit(new Response(body), 8, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);

    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(body.locked).toBe(false);
  });

  it.each(["prefix", "overflow", "deadline"] as const)(
    "settles %s reads before a retained response clone is released",
    async (kind) => {
      const cancel = vi.fn();
      const response = new Response(makeStallingStream([bytes("abcdefgh")], cancel));
      const capture = response.clone();
      const expected = new Error("read rejected");
      const operation = (
        kind === "prefix"
          ? readResponseTextPrefix(response, 8)
          : readResponseWithLimit(
              response,
              4,
              kind === "overflow"
                ? { onOverflow: () => expected }
                : {
                    timeoutMs: () => {
                      throw expected;
                    },
                  },
            )
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        const result = await Promise.race([operation, setImmediate()]);
        expect(result).toEqual(
          kind === "prefix"
            ? { value: { text: "abcdefgh", size: 8, truncated: true } }
            : { error: expected },
        );
        expect(response.body?.locked).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        await capture.body?.cancel();
        await operation;
      }
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { maxBytes: 0.5, expected: "custom: 3 > 0.5" },
    { maxBytes: 3.5, expected: "custom: 6 > 3.5" },
    { maxBytes: 5, expected: "custom: 6 > 5" },
    { maxBytes: 4, expected: /too large/i },
  ])("rejects overflow at $maxBytes bytes", async ({ maxBytes, expected }) => {
    await expect(
      readResponseWithLimit(
        createResponse("123", "456"),
        maxBytes,
        typeof expected === "string"
          ? {
              onOverflow: ({ size, maxBytes: limit }) => new Error(`custom: ${size} > ${limit}`),
            }
          : undefined,
      ),
    ).rejects.toThrow(expected);
  });

  it.each([Number.NaN, -1])("rejects invalid maxBytes before reading: %s", async (maxBytes) => {
    await expect(
      readResponseWithLimit(new Response(makeStream([new Uint8Array([1, 2, 3])])), maxBytes),
    ).rejects.toThrow(/maxBytes must be a non-negative finite number/);
  });

  it.each(["idle", "overall"] as const)(
    "names the default %s timeout for retry classifiers",
    async (kind) => {
      vi.useFakeTimers();
      const result = readResponseWithLimit(
        new Response(
          kind === "idle" ? makeStallingStream([new Uint8Array([1, 2])]) : makeTricklingStream(40),
        ),
        1024,
        kind === "idle" ? { chunkTimeoutMs: 50 } : { timeoutMs: 50 },
      ).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(60);

      await expect(result).resolves.toMatchObject({
        name: "TimeoutError",
        message:
          kind === "idle"
            ? expect.stringMatching(/stalled/i)
            : "Response body timed out after 50ms",
      });
    },
  );

  it("does not time out while chunks keep arriving", async () => {
    vi.useFakeTimers();
    const body = makeStream([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])], 40);
    const readPromise = readResponseWithLimit(new Response(body), 100, { chunkTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(125);
    const buf = await readPromise;
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps oversized idle timeout timers while reading chunks", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const buf = await readResponseWithLimit(createResponse("ab"), 100, {
        chunkTimeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
      });

      expect(buf).toEqual(Buffer.from("ab"));
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.each([false, true])(
    "passes the idle-timeout error without waiting for cancellation (%s)",
    async (pendingCancel) => {
      vi.useFakeTimers();
      const cancel = vi.fn((_reason?: unknown) =>
        pendingCancel ? new Promise<void>(() => {}) : undefined,
      );
      const body = makeStallingStream([new Uint8Array([1, 2])], cancel);
      await expectTimeout(
        readResponseWithLimit(new Response(body), 1024, {
          chunkTimeoutMs: 50,
          onIdleTimeout: ({ chunkTimeoutMs }) => new Error(`custom idle ${chunkTimeoutMs}`),
        }),
        "custom idle 50",
      );
      expectCancelled(cancel, "custom idle 50");
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels a trickling body at its lazily resolved overall deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const timeoutMs = vi.fn(() => 100);
    const response = new Response(makeTricklingStream(40, cancel));
    const assertion = expect(
      readResponseWithLimit(response, 1024, {
        chunkTimeoutMs: 50,
        timeoutMs,
        onTimeout: ({ timeoutMs: resolved }) => new Error(`custom overall ${resolved}`),
      }),
    ).rejects.toThrow("custom overall 100");

    expect(timeoutMs).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(110);
    await assertion;
    expect(timeoutMs).toHaveBeenCalledOnce();
    expectCancelled(cancel, "custom overall 100");
  });

  it("cancels the body with a lazy resolver's expired-deadline error", async () => {
    const cancel = vi.fn();
    const reason = new Error("deadline expired");
    await expect(
      readResponseWithLimit(new Response(makeStallingStream([], cancel)), 1024, {
        timeoutMs: () => {
          throw reason;
        },
      }),
    ).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
  });

  it("cancels a getReader-less body when its overall timeout expires", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async (_reason?: unknown) => undefined);
    const response = {
      body: { cancel },
      arrayBuffer: async () => await new Promise<ArrayBuffer>(() => {}),
    } as unknown as Response;
    await expectTimeout(
      readResponseWithLimit(response, 1024, {
        timeoutMs: 50,
        onTimeout: ({ timeoutMs }) => new Error(`fallback overall ${timeoutMs}`),
      }),
      "fallback overall 50",
      50,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("clears the overall timeout after a successful read", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = makeStream([new Uint8Array([1, 2])], undefined, cancel);

    await expect(
      readResponseWithLimit(new Response(body), 100, { timeoutMs: 50 }),
    ).resolves.toEqual(Buffer.from([1, 2]));
    await vi.advanceTimersByTimeAsync(100);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("readResponseTextSnippet", () => {
  it.each([
    ["collapses whitespace", ["hello   \n world"], 64, 50, "hello world"],
    ["stops at the byte limit", ["12345", "67890"], 7, 50, "1234567…"],
    ["drops partial UTF-8 bytes", ["ab😀cd"], 3, 50, "ab…"],
    ["preserves UTF-16 at the character limit", ["ab🚀tail"], 64, 3, "ab…"],
  ] as const)("%s", async (_name, chunks, maxBytes, maxChars, expected) => {
    await expect(
      readResponseTextSnippet(createResponse(...chunks), { maxBytes, maxChars }),
    ).resolves.toBe(expected);
  });

  it.each([
    { maxBytes: 0.5, text: "", size: 3 },
    { maxBytes: 3.5, text: "abc", size: 6 },
  ])("returns whole bytes under a fractional prefix budget of $maxBytes", async (expected) => {
    await expect(
      readResponseTextPrefix(createResponse("abc", "def"), expected.maxBytes),
    ).resolves.toEqual({
      text: expected.text,
      size: expected.size,
      truncated: true,
    });
  });

  it("applies the idle timeout while reading snippets", async () => {
    vi.useFakeTimers();
    const res = new Response(makeStallingStream([new Uint8Array([65, 66])]));
    await expectTimeout(
      readResponseTextSnippet(res, { maxBytes: 64, chunkTimeoutMs: 50 }),
      /stalled/i,
    );
  }, 5_000);
});
