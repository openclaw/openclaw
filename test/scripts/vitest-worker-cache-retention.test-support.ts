import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CompilerInputSnapshot } from "../../scripts/lib/compiler-input-snapshot.mts";
import {
  verifyVitestWorkerArtifacts,
  type VitestWorkerManifest,
} from "../../scripts/lib/vitest-worker-artifacts.mts";
import {
  createVitestWorkerCache,
  retainVitestWorkerArtifacts,
} from "../../scripts/lib/vitest-worker-cache.mts";
import { collectForRetentionCheck } from "../../src/test-utils/retention.js";
import { writeWorkerFixtureManifest } from "./fixtures/vitest-worker-compiler.mjs";

const root = process.cwd();
const directory = path.join(root, ".artifacts/vitest-workers/run-cache-0");
const inputs: Record<string, string> = {};
for (const [name, bytes] of Object.entries({
  "package.json": '{"name":"worker-cache-retention","type":"module"}\n',
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "src/value.js": "export const value = 42;\n",
})) {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  inputs[filename] = bytes;
}
function reserve() {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
}
reserve();

const snapshots: WeakRef<CompilerInputSnapshot>[] = [];
let captures = 0;
// oxlint-disable-next-line typescript/unbound-method -- Every call supplies the actual snapshot via .call.
const prepare = CompilerInputSnapshot.prototype.prepare;
// A plain delegate observes lifetime without a mock's receiver or call history.
CompilerInputSnapshot.prototype.prepare = function () {
  snapshots.push(new WeakRef(this));
  captures += 1;
  return prepare.call(this);
};
try {
  const miss = await createVitestWorkerCache(root, directory);
  assert.ok(miss);
  assert.equal(await miss.restore(), undefined);
  const manifest: VitestWorkerManifest = writeWorkerFixtureManifest(directory, inputs, {
    "value.js": inputs[path.join(root, "src/value.js")]!,
    "build-info.json": "{}\n",
  });
  const signature = await miss.seal(manifest);
  manifest.cacheSignature = signature;
  assert.equal(await retainVitestWorkerArtifacts(root, directory, manifest), true);
  fs.rmSync(directory, { recursive: true });
  reserve();

  const hit = await createVitestWorkerCache(root, directory);
  assert.ok(hit);
  const restored = await hit.restore();
  assert.ok(restored);
  assert.deepEqual(restored, manifest);
  await verifyVitestWorkerArtifacts(directory, restored);
  assert.equal(captures, 2);

  await collectForRetentionCheck("worker-cache-metadata");
  const retained = snapshots.flatMap((reference, index) => (reference.deref() ? [index] : []));
  // Both live borrowers still seal from their once-captured metadata after GC.
  assert.equal(await miss.seal(manifest), signature);
  assert.equal(await hit.seal(restored), signature);
  assert.equal(captures, 2);
  assert.deepEqual(retained, [], "Completed cache metadata must not retain compiler snapshots");
  process.stdout.write(JSON.stringify({ retained, captures, restored: true }));
} finally {
  CompilerInputSnapshot.prototype.prepare = prepare;
}
