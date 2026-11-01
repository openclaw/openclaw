import { vi } from "vitest";

type ObservedTranscriptHydration = {
  kind: string;
  events: number;
  totalEvents: number | undefined;
};

/**
 * Records how many events the history worker hydrates against the session's total.
 * Imports lazily so a test's module mocks apply before the lane is created.
 */
export async function observeTranscriptHydrations() {
  const { historyLane } =
    await import("../../src/config/sessions/session-transcript-worker-resources.js");
  const { unwrapSessionTranscriptWorkerReply } =
    await import("../../src/config/sessions/session-history-worker-errors.js");
  const hydrations: ObservedTranscriptHydration[] = [];
  const run = historyLane.pool.run.bind(historyLane.pool);
  const spy = vi.spyOn(historyLane.pool, "run").mockImplementation((input, options) => {
    let request: { kind: string } | undefined;
    return run(async () => {
      const prepared = typeof input === "function" ? await input() : input;
      request = prepared as typeof request;
      return prepared;
    }, options).then((reply) => {
      if (request?.kind === "transcript-hydration") {
        const value = unwrapSessionTranscriptWorkerReply(
          reply as Parameters<typeof unwrapSessionTranscriptWorkerReply>[0],
        ) as {
          kind: string;
          eventCount?: number;
          snapshot?: { events: unknown[]; totalEvents: number };
        };
        hydrations.push({
          kind: value.kind,
          events: value.snapshot?.events.length ?? value.eventCount ?? 0,
          totalEvents: value.snapshot?.totalEvents,
        });
      }
      return reply;
    });
  });
  return { hydrations, restore: () => spy.mockRestore() };
}
