import assert from "node:assert/strict";
import { normalizeTranscriptJsonValue } from "./transcript-json.js";

const MIB = 1024 * 1024;
const unicode = "🦞\ud800 lone \udfff";
const modes = ["plain", "frozen"] as const;

function append(index: number) {
  const mode = modes[index % modes.length]!;
  const bytes = Buffer.alloc(2 * MIB, 0x41);
  const donor = bytes.toString("utf8");
  const block = { type: "text", text: donor.slice(64, 64 + 2048) };
  const message = {
    role: "toolResult",
    content: [block],
    details: { tail: donor.slice(-1024), unicode },
  };
  const entry = { type: "message", id: String(index), message };
  if (mode === "frozen") {
    Object.freeze(block);
    Object.freeze(message.content);
    Object.freeze(message.details);
    Object.freeze(message);
    Object.freeze(entry);
  }
  const normalized = normalizeTranscriptJsonValue(entry, "");
  // Mirror the append's worker handoff without keeping its serialized copy alive.
  JSON.stringify(normalized);
  return normalized as typeof entry;
}

assert.equal(typeof global.gc, "function", "retention probe requires --expose-gc");
const gc = global.gc!;
normalizeTranscriptJsonValue({ message: { content: [{ type: "text", text: "warm" }] } }, "");
gc();
gc();
const before = process.memoryUsage();
const retained = Array.from({ length: 8 }, (_, index) => append(index));
gc();
gc();
const after = process.memoryUsage();
const retainedBytes = after.heapUsed - before.heapUsed;
const externalBytes = after.external - before.external;
console.log(
  JSON.stringify({
    retainedBytes,
    externalBytes,
    arrayBufferBytes: after.arrayBuffers - before.arrayBuffers,
    donorBytes: retained.length * 2 * MIB,
  }),
);
assert.ok(
  retainedBytes < MIB,
  `small persisted payloads retained ${retainedBytes} bytes from 16 MiB of discarded tool output`,
);
assert.ok(
  externalBytes < MIB,
  `small persisted payloads retained ${externalBytes} external bytes from discarded tool output`,
);

// Inspect contents only after measuring: assertions must not flatten the donor-backed strings.
for (const entry of retained) {
  const block = entry.message.content[0]!;
  assert.equal(block.text, "A".repeat(2048));
  assert.equal(entry.message.details.tail, "A".repeat(1024));
  assert.equal(entry.message.details.unicode, unicode);
  // A later preparation keeps the already-owned payload instead of cloning its graph again.
  assert.equal(normalizeTranscriptJsonValue(entry.message, ""), entry.message);
  assert.equal(normalizeTranscriptJsonValue(entry, ""), entry);
}

// A live payload should not need a process-lifetime admission entry per descendant.
const wide = { message: { values: Array.from({ length: 65_536 }, () => ({})) } };
gc();
gc();
const beforeAdmission = process.memoryUsage().heapUsed;
assert.equal(normalizeTranscriptJsonValue(wide, ""), wide);
gc();
gc();
const admissionBytes = process.memoryUsage().heapUsed - beforeAdmission;
console.log(JSON.stringify({ admissionBytes, descendants: wide.message.values.length }));
assert.ok(admissionBytes < MIB, `payload admission retained ${admissionBytes} bookkeeping bytes`);
assert.equal(normalizeTranscriptJsonValue(wide.message, ""), wide.message);
