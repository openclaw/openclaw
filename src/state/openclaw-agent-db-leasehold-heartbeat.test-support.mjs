import { mock } from "node:test";
import { parentPort, workerData } from "node:worker_threads";

const completion = new Int32Array(workerData.fixtureCompletion);
mock.timers.enable({ apis: ["Date", "setTimeout"], now: workerData.fixtureNow });

// Advance the actual renewal scheduler while the host is inside native COMMIT.
// Keep fixture messages outside the production heartbeat protocol.
const on = parentPort.on.bind(parentPort);
parentPort.on = (event, listener) =>
  event === "message"
    ? on(event, (message) => {
        if (message?.fixtureAdvance === undefined) {
          Reflect.apply(listener, parentPort, [message]);
        }
      })
    : on(event, listener);
on("message", (message) => {
  if (message?.fixtureAdvance === undefined) {
    return;
  }
  mock.timers.tick(message.fixtureAdvance);
  Atomics.add(completion, 0, 1);
  Atomics.notify(completion, 0);
});

await import(workerData.fixtureEntrypoint);
