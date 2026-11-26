/**
 * Run from the repository root:
 * node --import ./scripts/tsx.mjs ui/src/lib/dictation/formatting.bench.ts
 *
 * Acceptance hypothesis: validation + all three renderings p95 <= 50 ms for
 * each 10,000-character workload within the 20-command confirmation cap.
 * This measures deterministic
 * preparation only, never acoustic, provider, screen-reader or native delivery.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, loadavg, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import {
  prepareDictationFormatting,
  renderDictationDocument,
  validateDictationDocument,
  type DictationRange,
} from "./formatting.ts";

const samples = 100;
const warmupSamples = 10;
type WorkloadPart = { command: string } | null;
function fillSlots(parts: WorkloadPart[], alphabet: string) {
  const slots = parts.filter((part) => part === null).length;
  const available =
    10_000 - (parts.length - 1) - parts.reduce((sum, part) => sum + (part?.command.length ?? 0), 0);
  const confirmedMarkers: DictationRange[] = [];
  let text = "";
  let index = 0;
  for (const part of parts) {
    if (text) {
      text += " ";
    }
    if (part) {
      // Fixture construction authors each range independently of the formatter.
      const start = text.length;
      text += part.command;
      confirmedMarkers.push({ start, end: text.length });
      continue;
    }
    const length = Math.floor(available / slots) + (index++ < available % slots ? 1 : 0);
    if (length < 2) {
      throw new Error("Benchmark fixture has no content budget");
    }
    text += alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length - 1) + ".";
  }
  return { text, confirmedMarkers };
}
const paragraphParts: WorkloadPart[] = [null];
for (let index = 0; index < 20; index++) {
  paragraphParts.push({ command: "new paragraph." }, null);
}
const nestedParts: WorkloadPart[] = [];
for (let index = 0; index < 2; index++) {
  nestedParts.push(
    { command: "start list" },
    { command: "bullet" },
    null,
    { command: "nested list" },
    { command: "bullet" },
    null,
    { command: "nested list" },
    { command: "step three" },
    null,
    { command: "end list" },
    { command: "end list" },
    { command: "end list" },
  );
}
nestedParts.push(null);
const fixtures = [
  {
    name: "paragraphs",
    ...fillSlots(paragraphParts, "abcdefghijklmnopqrstuvwxyz0123456789 "),
    blocks: 21,
    depth: 0,
    markers: 20,
  },
  // Ampersands expand every source character to five HTML characters. Other
  // Markdown/HTML punctuation combinations are checked by the parser tests.
  {
    name: "escaped-paragraphs",
    ...fillSlots(paragraphParts, "&"),
    blocks: 21,
    depth: 0,
    markers: 20,
  },
  {
    name: "nested-lists",
    ...fillSlots(nestedParts, "abcdefghijklmnopqrstuvwxyz0123456789 "),
    blocks: 7,
    depth: 3,
    markers: 18,
  },
];
function summarize(values: number[]) {
  const sorted = values.toSorted((left, right) => left - right);
  const percentile = (fraction: number) =>
    Number(sorted[Math.ceil(sorted.length * fraction) - 1]!.toFixed(3));
  return {
    samples: values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: percentile(1),
  };
}
const results = [];
for (const fixture of fixtures) {
  const memoryBefore = process.memoryUsage();
  const firstStart = performance.now();
  const first = prepareDictationFormatting(fixture.text, "explicit", {
    sourceId: `benchmark-${fixture.name}`,
    confirmedMarkers: fixture.confirmedMarkers,
  });
  const firstCallMs = performance.now() - firstStart;
  if (
    fixture.text.length !== 10_000 ||
    first.status !== "formatted" ||
    first.counts.blocks !== fixture.blocks ||
    fixture.confirmedMarkers.length !== fixture.markers ||
    first.counts.depth !== fixture.depth ||
    !first.document
  ) {
    throw new Error(
      `Invalid benchmark fixture: ${fixture.name} (${first.status}, ${first.reason ?? ""}, ${first.counts.blocks} blocks)`,
    );
  }
  const document = first.document;
  const preparation: number[] = [];
  const validationAndRendering: number[] = [];
  let peakObservedRssBytes = memoryBefore.rss;
  let peakObservedHeapBytes = memoryBefore.heapUsed;
  for (let index = -warmupSamples; index < samples; index++) {
    const start = performance.now();
    const prepared = prepareDictationFormatting(fixture.text, "explicit", {
      sourceId: `benchmark-${fixture.name}`,
      confirmedMarkers: fixture.confirmedMarkers,
    });
    const elapsed = performance.now() - start;
    if (prepared.status !== "formatted" || prepared.counts.blocks !== fixture.blocks) {
      throw new Error("A fallback is not a successful formatting timing");
    }
    if (index >= 0) {
      preparation.push(elapsed);
    }
    const validationStart = performance.now();
    const validated = validateDictationDocument(document);
    if (!validated.ok) {
      throw new Error(`Benchmark document rejected: ${validated.reason}`);
    }
    renderDictationDocument(validated.document);
    const validationMs = performance.now() - validationStart;
    if (index >= 0) {
      validationAndRendering.push(validationMs);
    }
    const memory = process.memoryUsage();
    peakObservedRssBytes = Math.max(peakObservedRssBytes, memory.rss);
    peakObservedHeapBytes = Math.max(peakObservedHeapBytes, memory.heapUsed);
  }
  results.push({
    workload: fixture.name,
    sourceUtf16Characters: fixture.text.length,
    sourceUtf8Bytes: Buffer.byteLength(fixture.text),
    confirmedMarkerCount: fixture.confirmedMarkers.length,
    counts: first.counts,
    firstCall: {
      samples: 1,
      milliseconds: Number(firstCallMs.toFixed(3)),
      scope: "first call for this workload in one process; no JIT reset",
    },
    warmupSamples,
    preparation: summarize(preparation),
    validationAndRendering: summarize(validationAndRendering),
    meetsProposed50MsP95: summarize(validationAndRendering).p95Ms <= 50,
    memory: {
      before: memoryBefore,
      after: process.memoryUsage(),
      peakObservedRssBytes,
      peakObservedHeapBytes,
      observation: "between iterations, not continuous heap profiling",
    },
  });
}
const sources = ["types.ts", "grammar.ts", "document.ts", "formatting.ts", "formatting.bench.ts"];
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sourceSha256: Object.fromEntries(
        sources.map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(new URL(name, import.meta.url)))
            .digest("hex"),
        ]),
      ),
      hardware: {
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        availableParallelism: availableParallelism(),
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: freemem(),
        loadAverage: loadavg(),
      },
      runtime: {
        node: process.version,
        v8: process.versions.v8,
        architecture: process.arch,
        os: process.platform,
        osRelease: release(),
      },
      providerRequests: 0,
      providerLatency: "NOT RUN; no provider is invoked by deterministic formatting",
      microphoneToDeliveryLatency: "NOT RUN; this benchmark has no microphone or target adapter",
      results,
    },
    null,
    2,
  ),
);
