import { channel } from "node:diagnostics_channel";
import { expect, it } from "vitest";
import { startGatewayBenchDiagnostics } from "../../scripts/lib/gateway-bench-diagnostics.js";

it("aggregates captured work with bounded memory and drops content-bearing fields", () => {
  const source = channel("openclaw.session.write");
  const lists = channel("openclaw.session.list");
  const finish = startGatewayBenchDiagnostics();
  let result;
  try {
    for (let index = 0; index < 2; index += 1) {
      source.publish({
        operation: "session-entry.patch",
        outcome: "ok",
        writer: "foreground",
        queueWaitMs: 20 + index,
        writerExecutionMs: 2,
        storePath: "/private/example",
        agentId: "private-agent",
        error: "private-error",
      });
      lists.publish({
        operation: "sessions.list",
        responseOutcome: "ok",
        cacheRole: "projection-owner",
        storeLoadThreadCpuMs: 0.75 * (index + 1),
        prepareThreadCpuMs: 1.5 * (index + 1),
        rowThreadCpuMs: 2.25 * (index + 1),
        cacheSelectionThreadCpuMs: 0.125 * (index + 1),
        cachePublicationThreadCpuMs: 0.25 * (index + 1),
        responseThreadCpuMs: 0.375 * (index + 1),
      });
    }
    for (let index = 0; index < 300; index += 1) {
      source.publish({ operation: `session.synthetic-${index}`, outcome: "ok", elapsedMs: 1 });
    }
  } finally {
    result = finish();
  }
  expect(result.groups).toHaveLength(256);
  expect(result.droppedEvents).toBe(46);
  expect(result.collectionErrors).toBe(0);
  expect(result.groups[0]).toMatchObject({
    operation: "session-entry.patch",
    count: 2,
    metrics: {
      queueWaitMs: { count: 2, total: 41, max: 21 },
      writerExecutionMs: { count: 2, total: 4, max: 2 },
    },
  });
  expect(result.groups[1]).toMatchObject({
    operation: "sessions.list",
    cacheRole: "projection-owner",
    count: 2,
    metrics: {
      storeLoadThreadCpuMs: { count: 2, total: 2.25, max: 1.5 },
      prepareThreadCpuMs: { count: 2, total: 4.5, max: 3 },
      rowThreadCpuMs: { count: 2, total: 6.75, max: 4.5 },
      cacheSelectionThreadCpuMs: { count: 2, total: 0.375, max: 0.25 },
      cachePublicationThreadCpuMs: { count: 2, total: 0.75, max: 0.5 },
      responseThreadCpuMs: { count: 2, total: 1.125, max: 0.75 },
    },
  });
  expect(JSON.stringify(result)).not.toContain("private");
  source.publish({ operation: "session-entry.patch", outcome: "ok", queueWaitMs: 999 });
  expect(result.groups[0]).toMatchObject({ count: 2 });
});
