import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.factory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import * as manifestRegistry from "../plugins/manifest-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  createConfigReloadTestClock,
  createReloaderHarness,
  flushReload,
  makeZeroDebounceHookSnapshot,
  makeZeroDebounceHookWrite,
} from "./config-reload.test-support.js";

// Share the reload suite's database-worker, audit, and lifecycle fixtures.
export function registerInvalidConfigReloadTests(tempDirs: { make(prefix: string): string }) {
  it("skips schema-invalid saves using the Gateway's prepared plugin metadata", async () => {
    const root = tempDirs.make("openclaw-invalid-reload-");
    const configPath = path.join(root, "openclaw.json");
    const initialConfig: OpenClawConfig = { gateway: { reload: {} } };
    const io = createConfigIO({
      configPath,
      env: {
        HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
      homedir: () => root,
      observe: false,
    });
    const metadata = createPluginMetadataSnapshotFixture({ plugins: [{ id: "prepared-plugin" }] });
    setGatewayPluginMetadataSnapshot(metadata, { config: initialConfig });
    const registryLoads = vi.spyOn(manifestRegistry, "loadPluginManifestRegistryCore");
    const { clock, scheduler } = createConfigReloadTestClock();
    const harness = createReloaderHarness(() => io.readConfigFileSnapshot(), {
      initialConfig,
      scheduler,
    });
    await harness.reloader.ready;

    for (const [invalidConfig, issuePath] of [
      [{ agents: { defaults: { timeoutSeconds: -5 } } }, "agents.defaults.timeoutSeconds"],
      [{ gateway: { port: "abc" } }, "gateway.port"],
    ] as const) {
      await writeFile(configPath, JSON.stringify(invalidConfig));
      harness.watcher.emit("change");
      await clock.advanceBy(0);
      expect(harness.log.warn).toHaveBeenLastCalledWith(
        expect.stringContaining(`config reload skipped (invalid config): ${issuePath}:`),
      );
    }

    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.onConfigAccepted).not.toHaveBeenCalled();
    expect(registryLoads).not.toHaveBeenCalled();
  });

  it.each(["external", "accepted write"] as const)(
    "rejects invalid snapshots observed after %s even when the root hash matches",
    async (state) => {
      let snapshot = makeZeroDebounceHookSnapshot("same-root-hash");
      const readSnapshot = vi.fn(async () => snapshot);
      const onConfigCandidateObserved = vi.fn();
      const harness = createReloaderHarness(readSnapshot, {
        initialConfig: state === "accepted write" ? snapshot.config : undefined,
        onConfigCandidateObserved,
      });
      await harness.reloader.ready;
      if (state !== "external") {
        harness.emitWrite(makeZeroDebounceHookWrite("same-root-hash"));
      }
      if (state === "accepted write") {
        await flushReload(harness.reloader);
        expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
        harness.onConfigAccepted.mockClear();
      }
      snapshot = { ...snapshot, valid: false };
      onConfigCandidateObserved.mockClear();
      harness.watcher.emit("change");
      expect(onConfigCandidateObserved).toHaveBeenCalledOnce();
      expect(readSnapshot).not.toHaveBeenCalled();
      await flushReload(harness.reloader);
      expect(harness.onConfigAccepted).not.toHaveBeenCalled();
      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(harness.onHotReload).not.toHaveBeenCalled();
    },
  );
}
