import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAwaitedDecodedOutput, joinProcessCompletionAndOutput } from "./decoded-output.js";

describe("awaited decoded output", () => {
  it("retains stdout when the source resumes and ends before subscription", async () => {
    const source = new PassThrough();
    const output = createAwaitedDecodedOutput(source, () => {});
    try {
      source.end("output before subscription");
      source.resume();
      await finished(source);
      let received = "";
      await output.consume((chunk) => {
        received += chunk;
      });
      expect(received).toBe("output before subscription");
    } finally {
      output.close();
      source.destroy();
    }
  });

  it.each([false, true])(
    "rejects closure before EOF (already closed: %s)",
    async (alreadyClosed) => {
      const source = new PassThrough();
      if (alreadyClosed) {
        source.destroy();
      }
      const stopped = createDeferred<unknown>();
      const output = createAwaitedDecodedOutput(source, (error) => stopped.resolve(error));
      const consumed = output.consume(() => {});
      try {
        source.destroy();
        await expect(consumed).rejects.toThrow("Process stdout closed before EOF");
        expect(await stopped.promise).toEqual(new Error("Process stdout closed before EOF"));
      } finally {
        output.close();
        source.destroy();
        await consumed.catch(() => undefined);
      }
    },
  );

  it("requests stop for a rejected consumer and joins native completion before rejecting", async () => {
    const source = new PassThrough();
    const stopped = createDeferred<unknown>();
    const completion = createDeferred<{ code: number }>();
    const failure = new Error("synthetic rejected consumer");
    let stopCount = 0;
    const output = createAwaitedDecodedOutput(source, (error) => {
      stopCount += 1;
      stopped.resolve(error);
    });
    const consumed = output.consume(async () => {
      throw failure;
    });
    const joined = joinProcessCompletionAndOutput(completion.promise, consumed);
    let settled = false;
    void joined.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      source.write("input");
      expect(await stopped.promise).toBe(failure);
      source.end("discard after stop");
      await finished(source);
      await consumed.catch(() => undefined);
      await Promise.resolve();
      expect(stopCount).toBe(1);
      expect(settled).toBe(false);
      completion.resolve({ code: 0 });
      await expect(joined).rejects.toBe(failure);
      expect(stopCount).toBe(1);
    } finally {
      completion.resolve({ code: 0 });
      output.close();
      source.destroy();
      await joined.catch(() => undefined);
    }
  });

  it("keeps native backpressure and ordered delivery while consumption waits", async () => {
    const source = new PassThrough();
    const output = createAwaitedDecodedOutput(source, () => {});
    const entered = createDeferred();
    const release = createDeferred();
    const chunks: string[] = [];
    const consumed = output.consume(async (chunk) => {
      chunks.push(chunk);
      if (chunks.length === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    try {
      source.write("first");
      await entered.promise;
      const remaining = "x".repeat(source.writableHighWaterMark);
      source.write(remaining);
      expect(source.write(remaining)).toBe(false);
      source.end();
      expect(output.drain()).toBe(consumed);
      expect(chunks).toEqual(["first"]);
      let settled = false;
      void consumed.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve();
      await consumed;
      expect(chunks.join("")).toBe(`first${remaining}${remaining}`);
    } finally {
      release.resolve();
      output.close();
      source.destroy();
      await consumed.catch(() => undefined);
    }
  });

  it("joins the decoder tail consumer after source EOF", async () => {
    const source = new PassThrough();
    const output = createAwaitedDecodedOutput(source, () => {});
    const entered = createDeferred();
    const release = createDeferred();
    const chunks: string[] = [];
    const consumed = output.consume(async (chunk) => {
      chunks.push(chunk);
      entered.resolve();
      await release.promise;
    });
    try {
      source.write(Buffer.from([0xf0]));
      source.end(Buffer.from([0x9f]));
      await entered.promise;
      expect(chunks).toEqual(["�"]);
      let settled = false;
      void consumed.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve();
      await consumed;
    } finally {
      release.resolve();
      output.close();
      source.destroy();
      await consumed.catch(() => undefined);
    }
  });

  it("retains an accepted consumer after disposal until it settles", async () => {
    const source = new PassThrough();
    let stopCount = 0;
    const output = createAwaitedDecodedOutput(source, () => {
      stopCount += 1;
    });
    const entered = createDeferred();
    const release = createDeferred();
    const consumed = output.consume(async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      source.write("accepted");
      await entered.promise;
      output.close();
      let settled = false;
      void consumed.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve();
      await expect(consumed).rejects.toThrow("Process stdout consumption closed");
      expect(stopCount).toBe(0);
    } finally {
      release.resolve();
      output.close();
      source.destroy();
      await consumed.catch(() => undefined);
    }
  });
});
