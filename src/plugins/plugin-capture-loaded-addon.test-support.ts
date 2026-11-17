import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getFsSafeNativeStatus } from "@openclaw/fs-safe";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { acquireSqliteStagingToken } from "../infra/sqlite-staging-token.js";
import {
  captureRetainedNativeWorkerSource,
  closeDefaultRetainedNativeWorkerSource,
} from "../infra/worker-native-lifecycle.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { preparePluginGenerationArtifact } from "./plugin-generation-worker.js";
import { preparePluginNativeAdmissions } from "./plugin-native-admission-state.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

// Run in a child: Node keeps loaded native images mapped until process exit.
export async function captureLoadedAddonThroughSourceClose(stateDir: string) {
  const native = await getFsSafeNativeStatus({ probe: true });
  assert(native.loaded && native.packageName, "Installed native dependency must be available");
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(require.resolve("@openclaw/fs-safe"));
  const fixture = createFixture(path.join(stateDir, "plugin"), false);
  fs.copyFileSync(nativeRequire.resolve(native.packageName), fixture.filename);
  const cleanups = new AsyncDisposableStack();
  const capture = async () => {
    const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
    const cache = createPluginCache();
    cleanups.defer(async () => {
      await retirePluginCache(cache);
    });
    const probe = await source.captureIndependentResource(
      new URL(
        `data:text/javascript,${encodeURIComponent(
          'export function createNativeWorkerResource(port) { port.on("message", () => port.postMessage(process.pid)); return { async close() { port.close(); } }; }',
        )}`,
      ),
    );
    cleanups.defer(() => probe.close());
    const brokerPid = async () => {
      const reply = once(probe.port, "message");
      probe.port.postMessage("pid", []);
      return (await reply)[0];
    };
    const prepared = await withArtifactPreservingStateReads(() =>
      withPluginCache(cache, () =>
        withPluginInstallRoots({ ...resolvePluginInstallRoots(), stateDir }, () =>
          withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () => {
            preparePluginNativeAdmissions(fixture.index, cache);
            return preparePluginGenerationArtifact({
              rootDir: fixture.root,
              source: fixture.entry,
            });
          }),
        ),
      ),
    );
    cleanups.defer(() => prepared.artifact.disposeAsync());
    return { source, cache, prepared, probe, brokerPid };
  };
  try {
    const first = await capture();
    const { source, prepared, cache } = first;
    const pid = await first.brokerPid();
    const captured = fs.realpathSync(prepared.artifact.resolve(fixture.filename));
    let nativeDirectory = path.dirname(captured);
    while (path.basename(nativeDirectory) !== "native") {
      assert.notEqual(nativeDirectory, path.dirname(nativeDirectory));
      nativeDirectory = path.dirname(nativeDirectory);
    }
    const instance = path.dirname(nativeDirectory);
    const expectExcluded = () => {
      assert.throws(() => {
        const release = acquireSqliteStagingToken(instance, "reclaim");
        release();
      }, isSqliteLockError);
    };
    expectExcluded();
    await prepared.artifact.disposeAsync();
    await closeDefaultRetainedNativeWorkerSource();
    expectExcluded();
    const second = await capture();
    assert.equal(await second.brokerPid(), pid, "Closed source must reuse retained broker");
    const addon = { exports: {} };
    process.dlopen(addon, captured);
    assert(Object.keys(addon.exports).length > 0, "Real addon must initialize");
    await retirePluginCache(cache);
    await first.probe.close();
    assert.equal(await second.brokerPid(), pid, "Old lease release must preserve successor");
    await second.prepared.artifact.disposeAsync();
    await closeDefaultRetainedNativeWorkerSource();
    await retirePluginCache(second.cache);
    await second.probe.close();
    const third = await capture();
    assert.equal(await third.brokerPid(), pid, "Loaded broker must survive another source close");
    await third.prepared.artifact.disposeAsync();
    await closeDefaultRetainedNativeWorkerSource();
    await retirePluginCache(third.cache);
    await third.probe.close();
    await source.retireIdleBroker();
    expectExcluded();
    assert(fs.existsSync(captured), "Loaded addon bytes must remain until host exit");
    return { instance, captured };
  } finally {
    try {
      await cleanups.disposeAsync();
    } finally {
      await closeDefaultRetainedNativeWorkerSource();
    }
  }
}
