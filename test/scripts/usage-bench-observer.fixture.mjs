import { once } from "node:events";
import { Worker } from "node:worker_threads";

const worker = new Worker(
  `const { parentPort } = require("node:worker_threads");
   parentPort.on("message", ({ taskId }) => parentPort.postMessage(taskId));`,
  { eval: true, execArgv: [] },
);
try {
  const values = new Float64Array([1, 2]);
  const offsets = new Uint32Array([0, 2]);
  const firstReply = once(worker, "message");
  // This must precede Node's deferred process worker event.
  worker.postMessage(
    {
      taskId: 1,
      input: {
        kind: "prepare",
        input: {
          rows: [{ hasContextWeight: true }, { hasContextWeight: false }],
          packed: [{ batch: { values, offsets } }],
        },
      },
    },
    [values.buffer, offsets.buffer],
  );
  const first = await firstReply;
  const nextReply = once(worker, "message");
  worker.postMessage({ taskId: 2, input: { kind: "cohorts", input: { rows: [{}] } } }, []);
  const next = await nextReply;
  const unrelatedReply = once(worker, "message");
  worker.postMessage({ taskId: 3, input: { kind: "unrelated" } }, []);
  const unrelated = await unrelatedReply;
  process.send({
    channel: "observer-test",
    replies: [...first, ...next, ...unrelated],
    detachedBytes: [values.byteLength, offsets.byteLength],
  });
} finally {
  await worker.terminate();
}
