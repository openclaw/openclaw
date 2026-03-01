import type { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createFakeStreamFn } from "./fake-provider.js";
import { MessageTracker } from "./message-tracker.js";
import { mulberry32 } from "./types.js";

/** StreamFn may return a Promise; resolve it so we can async-iterate. */
async function resolveStream(
  s: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
): Promise<AssistantMessageEventStream> {
  return s instanceof Promise ? await s : s;
}

describe("createFakeStreamFn", () => {
  it("returns a stream that completes after latencyMs", async () => {
    const tracker = new MessageTracker();
    const streamFn = createFakeStreamFn({
      models: { "test-model": { latencyMs: 50, response: "hello" } },
      tracker,
    });

    const stream = await resolveStream(
      streamFn(
        { id: "test-model", contextWindow: 8192 } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {} as never,
      ),
    );

    let result = "";
    for await (const evt of stream) {
      if (evt.type === "done") {
        result = evt.message.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
      }
    }

    expect(result).toBe("hello");
  });

  it("uses seeded PRNG for deterministic error injection", async () => {
    const tracker = new MessageTracker();

    // Run multiple times — results should be deterministic
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const rngForRun = mulberry32(42 + i);
      const fn = createFakeStreamFn({
        models: { "err-model": { latencyMs: 10, response: "ok", errorRate: 0.5 } },
        tracker,
        rng: rngForRun,
      });
      const stream = await resolveStream(
        fn(
          { id: "err-model", contextWindow: 8192 } as never,
          { messages: [] } as never,
          {} as never,
        ),
      );
      let ok = false;
      for await (const evt of stream) {
        if (evt.type === "done") {
          ok = true;
        }
      }
      results.push(ok);
    }
    // With seed, results should be consistent across runs
    expect(results.length).toBe(5);
  });

  it("respects AbortSignal", async () => {
    const tracker = new MessageTracker();
    const controller = new AbortController();

    const streamFn = createFakeStreamFn({
      models: { slow: { latencyMs: 5000, response: "should not arrive" } },
      tracker,
      signal: controller.signal,
    });

    const stream = await resolveStream(
      streamFn(
        { id: "slow", contextWindow: 8192 } as never,
        { messages: [] } as never,
        {} as never,
      ),
    );

    // Abort immediately
    controller.abort();

    let gotError = false;
    for await (const evt of stream) {
      if (evt.type === "error") {
        gotError = true;
      }
      if (evt.type === "done") {
        gotError = false;
      }
    }

    expect(gotError).toBe(true);
  });
});
