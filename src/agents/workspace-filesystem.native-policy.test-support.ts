import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { FsSafeError } from "@openclaw/fs-safe/errors";

assert.ok(process.versions.bun, "native cleanup policy must execute in Bun");
const root = await fs.realpath(process.argv[2]!);
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
  LEGACY_WORKSPACE_ATTESTATION_HEADER,
} = await import("./workspace-legacy-state.js");
const { getTrackedWorkerLifecycleSnapshot } = await import("../infra/worker-cpu.js");
const { publishBootstrapFile } = await import("./workspace-bootstrap-publish.js");
const { readWorkspaceFileWithGuards } = await import("./workspace-file-read.js");
const { drainGlobalSingletonLifecycleState } = await import("../shared/global-singleton.js");
const started = () =>
  getTrackedWorkerLifecycleSnapshot().workerLifecycle.find(
    (entry) => entry.script === "fs-safe-copy.worker.js",
  )?.started ?? 0;
const before = started();
const previous = getFsSafeNativeConfig();
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace);
const sibling = `${workspace}.attested`;
const marker = `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\nsynthetic\n`;
await fs.writeFile(sibling, marker);
const readPath = path.join(workspace, "AGENTS.md");
await fs.writeFile(readPath, marker);
const plan = await prepareLegacyWorkspaceStateReset(workspace);
try {
  for (const [index, mode] of (["require", "off", "require"] as const).entries()) {
    configureFsSafeNative({ mode });
    const pending = removeLegacyWorkspaceStateForReset(plan);
    // Even cached dynamic imports resume after this synchronous mode change.
    configureFsSafeNative({ mode: "off" });
    const result = await pending;
    configureFsSafeNative({ mode });
    if (mode === "off") {
      assert.deepEqual(result, { removedPaths: [sibling], warnings: [] });
      await assert.rejects(fs.lstat(sibling), { code: "ENOENT" });
      await fs.writeFile(sibling, marker);
    } else {
      assert.deepEqual(result.removedPaths, [], `cleanup native ${mode}`);
      assert.ok(result.warnings.some((warning) => warning.includes(sibling)));
      assert.equal(await fs.readFile(sibling, "utf8"), marker);
    }
    const publication = path.join(workspace, `publication-${index}.md`);
    if (mode === "off") {
      assert.equal(await publishBootstrapFile(publication, marker), true);
      assert.equal(await fs.readFile(publication, "utf8"), marker);
    } else {
      await assert.rejects(publishBootstrapFile(publication, marker), /native fs-safe helper/);
      await assert.rejects(fs.lstat(publication), { code: "ENOENT" });
    }
    const read = readWorkspaceFileWithGuards({ filePath: readPath, workspaceDir: workspace });
    configureFsSafeNative({ mode: mode === "off" ? "require" : "off" });
    const loaded = await read;
    configureFsSafeNative({ mode });
    if (mode === "off") {
      assert.ok(loaded.ok);
      assert.equal(loaded.content, marker);
      assert.equal(typeof loaded.sourceIdentity[1]?.ino, "bigint");
    } else {
      assert.ok(!loaded.ok);
      assert.equal(loaded.reason, "validation");
      assert.ok(loaded.error instanceof FsSafeError);
      assert.equal(loaded.error.code, "helper-unavailable");
    }
  }
  assert.equal(started() - before, 1, "workspace effects must reuse their filesystem worker");
} finally {
  await drainGlobalSingletonLifecycleState("restart", { retainSharedState: true });
  configureFsSafeNative(previous);
}
