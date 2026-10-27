// Tests bounded HTTP response reads and cleanup behavior.
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

function makeStream(chunks: Uint8Array[], delayMs?: number) {
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
  });
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
    const consumed = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes("done"));
          controller.close();
        },
        cancel,
      }),
    );
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
      const completed = await Promise.race([
        cleanup.then(() => true),
        new Promise<boolean>((resolve) => {
          setImmediate(() => resolve(false));
        }),
      ]);
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
        const result = await Promise.race([
          operation,
          new Promise<undefined>((resolve) => {
            setImmediate(() => resolve(undefined));
          }),
        ]);
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

  it.each([0.5, 3.5])("reports overflow for a fractional byte budget of %s", async (maxBytes) => {
    const response = new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]));

    await expect(
      readResponseWithLimit(response, maxBytes, {
        onOverflow: ({ maxBytes: limit }) => new Error(`Exceeded ${limit} bytes`),
      }),
    ).rejects.toThrow(`Exceeded ${maxBytes} bytes`);
  });

  it.each([false, true])("rejects overflow with custom error: %s", async (custom) => {
    const res = custom ? createResponse("0123456789") : createResponse("123", "456");
    await expect(
      readResponseWithLimit(
        res,
        custom ? 5 : 4,
        custom
          ? {
              onOverflow: ({ size, maxBytes }) => new Error(`custom: ${size} > ${maxBytes}`),
            }
          : undefined,
      ),
    ).rejects.toThrow(custom ? "custom: 10 > 5" : /too large/i);
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
    const res = new Response(body);
    const readPromise = readResponseWithLimit(res, 100, { chunkTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(125);
    const buf = await readPromise;
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps oversized idle timeout timers while reading chunks", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const body = makeStream([new Uint8Array([1]), new Uint8Array([2])]);
      const res = new Response(body);

      const buf = await readResponseWithLimit(res, 100, {
        chunkTimeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
      });

      expect(buf).toEqual(Buffer.from([1, 2]));
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
      const res = new Response(body);
      const readPromise = expect(
        readResponseWithLimit(res, 1024, {
          chunkTimeoutMs: 50,
          onIdleTimeout: ({ chunkTimeoutMs }) => new Error(`custom idle ${chunkTimeoutMs}`),
        }),
      ).rejects.toThrow("custom idle 50");

      await vi.advanceTimersByTimeAsync(60);
      await readPromise;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ message: "custom idle 50" }));
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
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ message: "custom overall 100" }));
  });

  it("cancels the body when a lazy timeout resolver reports an expired deadline", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel,
      }),
    );

    await expect(
      readResponseWithLimit(response, 1024, {
        timeoutMs: () => {
          throw new Error("deadline expired");
        },
      }),
    ).rejects.toThrow("deadline expired");
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ message: "deadline expired" }));
  });

  it("cancels a getReader-less body when its overall timeout expires", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async (_reason?: unknown) => undefined);
    const response = {
      body: { cancel },
      arrayBuffer: async () => await new Promise<ArrayBuffer>(() => {}),
    } as unknown as Response;
    const assertion = expect(
      readResponseWithLimit(response, 1024, {
        timeoutMs: 50,
        onTimeout: ({ timeoutMs }) => new Error(`fallback overall ${timeoutMs}`),
      }),
    ).rejects.toThrow("fallback overall 50");

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("clears the overall timeout after a successful read", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
      cancel,
    });

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

  it("cancels immediately when a diagnostic prefix fills the byte budget", async () => {
    const cancel = vi.fn();
    const response = new Response(makeStallingStream([bytes("exact")], cancel));

    await expect(readResponseTextPrefix(response, 5)).resolves.toEqual({
      text: "exact",
      size: 5,
      truncated: true,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
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
    const rejection = expect(
      readResponseTextSnippet(res, { maxBytes: 64, chunkTimeoutMs: 50 }),
    ).rejects.toThrow(/stalled/i);
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
  }, 5_000);
});
