// Reusable contract tests for ACP runtime turn adapters.
import { describe, expect, it, onTestFinished } from "vitest";
import type { AcpRuntimeEvent, AcpRuntimeTurn, AcpRuntimeTurnResult } from "./acp-runtime.js";

type TurnControlInput = { reason?: string } | undefined;

export type AcpRuntimeTurnContractScenario = {
  events: AsyncIterable<AcpRuntimeEvent>;
  /** Modern qualification requires authoritative prompt-submission readiness. */
  promptStarted: Promise<void>;
  requestId: string;
  result: Promise<AcpRuntimeTurnResult>;
  cancel(input?: { reason?: string }): Promise<void>;
  closeStream(input?: { reason?: string }): Promise<void>;
};

export type AcpRuntimeTurnContractHarness = {
  turn: AcpRuntimeTurn;
  dispose?(): Promise<void> | void;
};

export type AcpRuntimeTurnContractFactory = (
  scenario: AcpRuntimeTurnContractScenario,
) => AcpRuntimeTurnContractHarness | Promise<AcpRuntimeTurnContractHarness>;

function eventsFrom(events: AcpRuntimeEvent[]): AsyncIterable<AcpRuntimeEvent> {
  return (async function* () {
    yield* events;
  })();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function scenario(overrides: Partial<AcpRuntimeTurnContractScenario> & { requestId: string }) {
  return {
    events: eventsFrom([]),
    promptStarted: Promise.resolve(),
    result: Promise.resolve({ status: "completed" as const }),
    async cancel() {},
    async closeStream() {},
    ...overrides,
  } satisfies AcpRuntimeTurnContractScenario;
}

async function createHarness(
  factory: AcpRuntimeTurnContractFactory,
  input: AcpRuntimeTurnContractScenario,
) {
  const harness = await factory(input);
  onTestFinished(async () => {
    await harness.dispose?.();
  });
  return harness;
}

async function collectEvents(events: AsyncIterable<AcpRuntimeEvent>): Promise<AcpRuntimeEvent[]> {
  const collected: AcpRuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

/** Installs the shared behavioral contract for an adapter's modern startTurn boundary. */
export function installAcpRuntimeTurnContractSuite(params: {
  name: string;
  createHarness: AcpRuntimeTurnContractFactory;
}): void {
  describe(`${params.name} ACP runtime turn contract`, () => {
    it("preserves request identity, event order, and the authoritative completed result", async () => {
      const expectedEvents: AcpRuntimeEvent[] = [
        { type: "text_delta", text: "hello" },
        { type: "status", text: "working" },
        { type: "tool_call", text: "read file", toolCallId: "tool-1" },
      ];
      const expectedResult: AcpRuntimeTurnResult = {
        status: "completed",
        stopReason: "end_turn",
      };
      const input = scenario({
        requestId: "contract-completed",
        events: eventsFrom(expectedEvents),
        result: Promise.resolve(expectedResult),
      });
      const { turn } = await createHarness(params.createHarness, input);

      expect(turn.requestId).toBe(input.requestId);
      await expect(collectEvents(turn.events)).resolves.toEqual(expectedEvents);
      await expect(turn.result).resolves.toEqual(expectedResult);
    });

    it("keeps terminal failure separate from streamed events", async () => {
      const expectedEvents: AcpRuntimeEvent[] = [{ type: "text_delta", text: "partial" }];
      const expectedResult: AcpRuntimeTurnResult = {
        status: "failed",
        error: { message: "backend disconnected", code: "ACP_TURN_FAILED", retryable: true },
      };
      const { turn } = await createHarness(
        params.createHarness,
        scenario({
          requestId: "contract-failed",
          events: eventsFrom(expectedEvents),
          result: Promise.resolve(expectedResult),
        }),
      );

      await expect(collectEvents(turn.events)).resolves.toEqual(expectedEvents);
      await expect(turn.result).resolves.toEqual(expectedResult);
    });

    it("settles the authoritative result without waiting for event stream closure", async () => {
      const releaseStream = deferred<void>();
      const result: AcpRuntimeTurnResult = { status: "completed", stopReason: "end_turn" };
      const events = (async function* () {
        yield { type: "text_delta" as const, text: "partial" };
        await releaseStream.promise;
      })();
      const { turn } = await createHarness(
        params.createHarness,
        scenario({
          requestId: "contract-result-before-stream-close",
          events,
          result: Promise.resolve(result),
        }),
      );
      const iterator = turn.events[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: "text_delta", text: "partial" },
      });
      await expect(turn.result).resolves.toEqual(result);
      releaseStream.resolve();
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it("exposes prompt submission readiness", async () => {
      const promptStarted = deferred<void>();
      const { turn } = await createHarness(
        params.createHarness,
        scenario({ requestId: "contract-prompt-started", promptStarted: promptStarted.promise }),
      );
      let observed = false;
      void turn.promptStarted?.then(() => {
        observed = true;
      });

      await Promise.resolve();
      expect(turn.promptStarted).toBeDefined();
      expect(observed).toBe(false);
      promptStarted.resolve();
      await turn.promptStarted;
      expect(observed).toBe(true);
    });

    it("preserves prompt submission failure", async () => {
      const readinessError = new Error("prompt submission failed");
      const promptStarted = Promise.reject(readinessError);
      promptStarted.catch(() => {});
      const { turn } = await createHarness(
        params.createHarness,
        scenario({ requestId: "contract-prompt-rejected", promptStarted }),
      );

      await expect(turn.promptStarted).rejects.toBe(readinessError);
    });

    it("forwards cancellation with its reason without closing the event stream", async () => {
      const cancelCalls: TurnControlInput[] = [];
      const closeStreamCalls: TurnControlInput[] = [];
      const result = deferred<AcpRuntimeTurnResult>();
      const expectedResult: AcpRuntimeTurnResult = {
        status: "cancelled",
        stopReason: "user-request",
      };
      const { turn } = await createHarness(
        params.createHarness,
        scenario({
          requestId: "contract-cancel",
          result: result.promise,
          async cancel(input) {
            cancelCalls.push(input);
            result.resolve(expectedResult);
          },
          async closeStream(input) {
            closeStreamCalls.push(input);
          },
        }),
      );

      await turn.cancel({ reason: "user-request" });

      expect(cancelCalls).toEqual([{ reason: "user-request" }]);
      expect(closeStreamCalls).toEqual([]);
      await expect(turn.result).resolves.toEqual(expectedResult);
    });

    it("forwards early stream closure, unblocks iteration, and does not cancel work", async () => {
      const cancelCalls: TurnControlInput[] = [];
      const closeStreamCalls: TurnControlInput[] = [];
      const streamClosed = deferred<void>();
      const result = deferred<AcpRuntimeTurnResult>();
      const expectedResult: AcpRuntimeTurnResult = {
        status: "completed",
        stopReason: "end_turn",
      };
      const events: AsyncIterable<AcpRuntimeEvent> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              await streamClosed.promise;
              return { done: true, value: undefined };
            },
          };
        },
      };
      const { turn } = await createHarness(
        params.createHarness,
        scenario({
          requestId: "contract-close-stream",
          events,
          result: result.promise,
          async cancel(input) {
            cancelCalls.push(input);
          },
          async closeStream(input) {
            closeStreamCalls.push(input);
            streamClosed.resolve();
          },
        }),
      );
      const nextEvent = turn.events[Symbol.asyncIterator]().next();

      await turn.closeStream({ reason: "consumer-stopped" });

      expect(closeStreamCalls).toEqual([{ reason: "consumer-stopped" }]);
      expect(cancelCalls).toEqual([]);
      await expect(nextEvent).resolves.toEqual({ done: true, value: undefined });
      await expect(Promise.race([turn.result, Promise.resolve("pending")])).resolves.toBe(
        "pending",
      );
      result.resolve(expectedResult);
      await expect(turn.result).resolves.toEqual(expectedResult);
    });
  });
}
