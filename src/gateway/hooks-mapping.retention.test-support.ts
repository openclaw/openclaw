import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectForRetentionCheck, expectLiveObjects } from "../test-utils/retention.js";
import { applyHookMappings, commitHookTransformMappingReload } from "./hooks-mapping.js";

const measure = process.argv.includes("--measure");
const allocation = process.argv.includes("--allocation");
const modules = measure ? 40 : 2;
const batches = measure ? 10 : 3;
const reloads = measure ? 10 : 2;
const references: WeakRef<object>[] = [];
Reflect.set(globalThis, "__hookTransformRetention", references);
const temp = createTempDirTracker();
const directory = temp.make("hook-transform-retention-");
const mappings = Array.from({ length: modules }, (_, index) => {
  const modulePath = path.join(directory, `${index}.mjs`);
  fs.writeFileSync(
    modulePath,
    `const state = { text: "original", payload: new Array(${measure ? 8192 : 8}).fill(${index}) };
globalThis.__hookTransformRetention.push(new WeakRef(state));
export default () => ({ kind: "wake", text: state.text });`,
  );
  return { id: String(index), action: "wake" as const, transform: { modulePath } };
});
const context = {
  payload: {},
  headers: {},
  path: "probe",
  url: new URL("http://localhost/hooks/probe"),
};
async function invokeMappings() {
  for (const mapping of mappings) {
    const result = await applyHookMappings([mapping], context);
    assert.ok(result?.ok && result.actions[0]?.kind === "wake");
    assert.equal(result.actions[0].text, "original");
  }
}
const inspector = allocation ? new Session() : undefined;
try {
  // Warm the real import and mapping path before measuring reload-only growth.
  await invokeMappings();
  await collectForRetentionCheck("hook-transform-warm");
  const baselineHeap = process.memoryUsage().heapUsed;
  const samples = [];
  for (let batch = 0; batch < batches; batch++) {
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 16384,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (let reload = 0; reload < reloads; reload++) {
      commitHookTransformMappingReload();
      await invokeMappings();
    }
    const wallMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    let allocatedBytes: number | undefined;
    if (inspector) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const nodes = [profile.head];
      allocatedBytes = 0;
      while (nodes.length > 0) {
        const node = nodes.pop()!;
        allocatedBytes += node.selfSize;
        nodes.push(...node.children);
      }
      inspector.disconnect();
    }
    await collectForRetentionCheck(`hook-transform-${batch}`);
    samples.push({
      batch,
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      allocatedBytes,
      heapDelta: process.memoryUsage().heapUsed - baselineHeap,
      live: references.filter((reference) => reference.deref()).length,
    });
  }
  if (!measure) {
    await expectLiveObjects(references, modules);
    // Reloads must still observe source edits, including equal-length replacements.
    const changed = mappings[0]!.transform.modulePath;
    fs.writeFileSync(changed, fs.readFileSync(changed, "utf8").replace("original", "modified"));
    commitHookTransformMappingReload();
    const result = await applyHookMappings([mappings[0]!], context);
    assert.ok(result?.ok && result.actions[0]?.kind === "wake");
    assert.equal(result.actions[0].text, "modified");
    await expectLiveObjects(references, modules + 1);
  }
  console.log(
    JSON.stringify({
      node: process.version,
      modules,
      batches,
      reloads,
      load: os.loadavg(),
      samples,
    }),
  );
} finally {
  inspector?.disconnect();
  commitHookTransformMappingReload();
  Reflect.deleteProperty(globalThis, "__hookTransformRetention");
  temp.cleanup();
}
