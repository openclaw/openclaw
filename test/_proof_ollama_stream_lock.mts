/**
 * Real behavior proof: ReadableStream reader lock lifecycle.
 *
 * Proves that reader.cancel() alone does NOT release the lock on a
 * ReadableStream, and that reader.releaseLock() IS required per the
 * Streams specification to allow other consumers to acquire the stream.
 *
 * This is the exact scenario addressed by the Ollama stream fix:
 * reader.cancel() in the finally block still leaves the stream locked;
 * adding reader.releaseLock() properly releases it.
 *
 * Usage: node --import tsx test/_proof_ollama_stream_lock.mts
 */

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
    fail++;
  }
}

async function main() {
  // Create a ReadableStream (simulating response.body)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });

  // Proof 1: stream starts unlocked
  check("fresh stream: not locked", !stream.locked);

  // Proof 2: getReader() locks the stream
  const reader = stream.getReader();
  check("after getReader: stream is locked", stream.locked);

  // Proof 3: cancel() does NOT release the lock
  await reader.cancel();
  check("after reader.cancel(): stream still locked", stream.locked,
    `locked=${stream.locked}`);

  // Proof 4: releaseLock() DOES release the lock
  reader.releaseLock();
  check("after reader.releaseLock(): stream unlocked", !stream.locked,
    `locked=${stream.locked}`);

  // Proof 5: after release, a new reader can acquire the stream
  const reader2 = stream.getReader();
  check("new reader: can acquire after lock released", stream.locked,
    `locked=${stream.locked}`);
  reader2.releaseLock();

  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}
main();
