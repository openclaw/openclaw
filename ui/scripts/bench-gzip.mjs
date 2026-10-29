// Compare gzip encoders on final build bytes, without Brotli or I/O in the timer.
// Run: node ui/scripts/bench-gzip.mjs [dist/control-ui] [samples=5]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { gzip as gzipLibdeflate } from "libdeflate";
import { gzip as gzipPako } from "pako";

const dist = path.resolve(process.argv[2] ?? "dist/control-ui");
const samples = Number(process.argv[3] ?? 5);
assert(Number.isSafeInteger(samples) && samples >= 1, "samples must be a positive integer");
const files = fs
  .readdirSync(path.join(dist, "assets"))
  .filter((file) => /[.](js|css)$/.test(file))
  .toSorted();
assert(files.length > 0, "no finalized JavaScript or CSS assets");
const bodies = files.map((file) => fs.readFileSync(path.join(dist, "assets", file)));
const encoders = [
  {
    name: "pako-9-legacy-mem6",
    encode: (body) => gzipPako(body, { level: 9, legacyHash: true, memLevel: 6 }),
  },
  { name: "libdeflate-11", encode: (body) => gzipLibdeflate(body, 11) },
  { name: "libdeflate-12", encode: (body) => gzipLibdeflate(body, 12) },
];
const results = new Map();
for (const { name, encode } of encoders) {
  // Warm module initialization separately; this is compressor cost, not cold-build time.
  encode(bodies[0]);
  results.set(name, { runs: [], bytes: [], sha256: [] });
}
const host = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpus: os.availableParallelism(),
  load: os.loadavg(),
};
for (let sample = 0; sample < samples; sample++) {
  // Alternate order to reduce shared-host/order bias; all encoders run serially.
  const order = sample % 2 ? encoders.toReversed() : encoders;
  for (const { name, encode } of order) {
    const cpu = process.cpuUsage();
    const start = performance.now();
    const output = bodies.map(encode);
    const wallMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const result = results.get(name);
    result.runs.push({ wallMs, cpuMs: (used.user + used.system) / 1000 });
    output.forEach((encoded, index) => {
      assert(
        gunzipSync(encoded).equals(bodies[index]),
        "decode mismatch: " + name + "/" + files[index],
      );
      const hash = createHash("sha256").update(encoded).digest("hex");
      if (sample === 0) {
        result.bytes.push(encoded.byteLength);
        result.sha256.push(hash);
      } else {
        assert.equal(hash, result.sha256[index], "nondeterministic: " + name + "/" + files[index]);
      }
    });
  }
}
function summarize(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
}
console.log(
  JSON.stringify(
    {
      host,
      samples,
      dist,
      files: files.length,
      rawBytes: bodies.reduce((sum, body) => sum + body.length, 0),
      encoders: Object.fromEntries(
        [...results].map(([name, result]) => [
          name,
          {
            ...result,
            totalBytes: result.bytes.reduce((sum, bytes) => sum + bytes, 0),
            wallMs: summarize(result.runs.map((run) => run.wallMs)),
            cpuMs: summarize(result.runs.map((run) => run.cpuMs)),
          },
        ]),
      ),
      assets: files,
    },
    null,
    2,
  ),
);
