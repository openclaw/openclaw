import { describe, expect, test } from "vitest";

import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "./diagnostic-events.js";

describe("diagnostic-events", () => {
  test("emits monotonic seq", async () => {
    resetDiagnosticEventsForTest();
    const seqs: number[] = [];
    const stop = onDiagnosticEvent((evt) => seqs.push(evt.seq));

    emitDiagnosticEvent({
      type: "model.usage",
      usage: { total: 1 },
    });
    emitDiagnosticEvent({
      type: "model.usage",
      usage: { total: 2 },
    });

    stop();

    expect(seqs).toEqual([1, 2]);
  });
});
