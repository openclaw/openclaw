import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { setImmediate } from "node:timers/promises";
import { emitDiagnosticMemorySample } from "../logging/diagnostic-memory.js";

declare const Bun: { gc(force: boolean): number };

function collect() {
  if (process.versions.bun) {
    Bun.gc(true);
  } else {
    assert.ok(globalThis.gc, "The channel regression requires --expose-gc");
    globalThis.gc();
  }
}

function publishPressure() {
  emitDiagnosticMemorySample(
    {
      memoryUsage: { rss: 2, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
      thresholds: { rssCriticalBytes: 1 },
    },
    false,
  );
}

// Publish before a subscriber exists, then collect the inactive channel. The
// producer must retain its identity when a subscriber joins on a later turn.
publishPressure();
await setImmediate();
collect();
const pressure = channel("openclaw.memory.critical");
let delivered = 0;
const receive = () => delivered++;
pressure.subscribe(receive);
try {
  await setImmediate();
  collect();
  await setImmediate();
  publishPressure();
  assert.equal(
    delivered,
    1,
    "Critical memory pressure must reach the retained subscriber after GC",
  );
} finally {
  pressure.unsubscribe(receive);
}
process.stdout.write(JSON.stringify({ delivered: 1 }));
