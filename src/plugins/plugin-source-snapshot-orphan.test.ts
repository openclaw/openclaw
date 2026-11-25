import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { readCurrentInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { updatePluginSnapshotCandidates } from "./installed-plugin-snapshot-candidates.js";
import { withPluginLifecycleLeaseAsync } from "./plugin-lifecycle-lease.js";
import { collectInstalledPluginSourceSnapshots } from "./plugin-source-snapshot-collection.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

const temp = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it("reclaims completed publication after the installer exits before index commit", async () => {
  const stateDir = temp.make("snapshot-orphan-");
  const source = path.join(stateDir, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "package.json"), '{"name":"orphan","main":"index.cjs"}');
  fs.writeFileSync(path.join(source, "index.cjs"), "module.exports = 1;");
  const entry = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.snapshotPreparation);
  const child = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(entry).slice(0, -1),
      "--input-type=module",
      "-e",
      `process.env.OPENCLAW_STATE_DIR = process.argv[1];
       const { preparePluginSourceSnapshot } = await import(${JSON.stringify(entry.href)});
       const capture = await preparePluginSourceSnapshot({stateDir:process.argv[1],rootDir:process.argv[2]});
       const result = await capture.publish({installRecordHash:"orphan",
         contentDigest:capture.contentDigest,dependencyClosureDigest:capture.dependencyClosureDigest,
         buildResolutionDigest:"options"});
       process.stdout.write(JSON.stringify(result) + "\\n", () => process.exit(0));`,
      stateDir,
      source,
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  expect((await once(child, "close"))[0], stderr).toBe(0);
  const descriptor = JSON.parse(stdout.trim()) as { artifact: { path: string } };
  expect(fs.existsSync(descriptor.artifact.path)).toBe(true);
  const candidates = () =>
    withPluginLifecycleLeaseAsync(
      { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
      (lease) => updatePluginSnapshotCandidates({ stateDir, lease, operation: "read" }),
    );
  expect((await candidates()).map((candidate) => candidate.artifact)).toEqual([
    descriptor.artifact,
  ]);
  expect(await readCurrentInstalledPluginIndex({ stateDir })).toBeNull();
  await collectInstalledPluginSourceSnapshots(stateDir);
  expect(fs.existsSync(descriptor.artifact.path)).toBe(false);
  expect(await candidates()).toEqual([]);
});
