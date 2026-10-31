import { channel } from "node:diagnostics_channel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticMemoryPressureEvent,
} from "../infra/diagnostic-events.js";
import { emitDiagnosticMemorySample, resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";

const GIB = 1024 ** 3;

describe("diagnostic memory headroom", () => {
  let pressures: DiagnosticMemoryPressureEvent[];
  let stop: () => void;
  const retire = vi.fn();
  const critical = channel("openclaw.memory.critical");

  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    retire.mockClear();
    critical.subscribe(retire);
    pressures = [];
    stop = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.memory.pressure") {
        pressures.push(event);
      }
    });
  });

  afterEach(() => {
    stop();
    critical.unsubscribe(retire);
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
  });

  it.each([32, 187])("keeps a growing 4–6 GiB RSS healthy on a %i GiB host", (hostGiB) => {
    for (let minute = 0; minute <= 30; minute += 0.5) {
      emitDiagnosticMemorySample({
        now: minute * 60_000,
        emitSample: false,
        isBunRuntime: false,
        heapSizeLimitBytes: 16 * GIB,
        processMemoryLimitBytes: 0,
        physicalMemoryBytes: hostGiB * GIB,
        memoryUsage: {
          rss: (4 + minute / 15) * GIB,
          heapTotal: 2 * GIB,
          heapUsed: GIB,
          external: 43 * 1024 ** 2,
          arrayBuffers: 21 * 1024 ** 2,
        },
      });
    }
    expect(pressures).toEqual([]);
    expect(retire).not.toHaveBeenCalled();
  });
});
