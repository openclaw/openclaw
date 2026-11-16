import { writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

function stallProbeSpin() {
  writeSync(1, `spin-entered pid=${process.pid} at=${Date.now()}\n`);
  for (;;) {
    Math.sqrt(Date.now());
  }
}

if (isMainThread) {
  const gatewayPort = process.env.OPENCLAW_TEST_STALL_GATEWAY_PORT;
  if (gatewayPort) {
    // A preload exercises the actual dev Gateway's recorder only after its public readiness probe.
    const poll = async () => {
      if (
        !Object.getOwnPropertyDescriptor(
          globalThis,
          Symbol.for("openclaw.stallFlightRecorder.capture"),
        )
      ) {
        return;
      }
      try {
        if ((await fetch(`http://127.0.0.1:${gatewayPort}/readyz`)).ok) {
          clearInterval(timer);
          setImmediate(stallProbeSpin);
        }
      } catch {
        // Startup has not bound its port yet.
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, 250);
    timer.unref();
  } else {
    // Advance only the owner's clock; the observer sees an overdue beat without a 30-second test.
    // The real-bound harness omits this argument and waits for the production deadline.
    if (process.argv.includes("--fast")) {
      const now = performance.now.bind(performance);
      performance.now = () => now() - 30_000;
    }
    const { createStallFlightRecorder } = await import("./diagnostic-stall-flight-recorder.js");
    createStallFlightRecorder((message) => writeSync(2, `${message}\n`));
    setImmediate(stallProbeSpin);
  }
}
