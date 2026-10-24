import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as onboardInference from "../commands/onboard-inference.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { detectAvailableSetupProviderIds } from "../plugins/provider-setup-availability.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { detectSetupInference } from "./setup-inference-detect.js";

afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  await waitForPluginCacheRetirement();
});

it.each([false, true])(
  "retires repeated provider discovery after callback settlement (failed: %s)",
  (failed) =>
    withOpenClawTestState({ label: "setup-discovery-lifetime" }, async (state) => {
      const id = "discovery-lifetime-fixture";
      const pluginDir = state.statePath("extensions", id);
      const nativeEvent = `${id}-${path.basename(state.root)}`;
      const observationEvent = `${nativeEvent}-observation`;
      const releaseEvent = `${nativeEvent}-release`;
      const nativeBefore = process.listenerCount(nativeEvent);
      const modelRef = `${id}/local-model`;
      await state.writeJson(`extensions/${id}/openclaw.plugin.json`, {
        id,
        providers: [id],
        configSchema: { type: "object", properties: {} },
        providerAuthChoices: [
          {
            provider: id,
            method: "local",
            choiceId: id,
            choiceLabel: "Local discovery fixture",
            appGuidedDiscovery: true,
          },
        ],
      });
      await state.writeText(
        `extensions/${id}/index.ts`,
        `
        export default { id: ${JSON.stringify(id)}, register(api) {
          const listener = () => {};
          process.on(${JSON.stringify(nativeEvent)}, listener);
          api.lifecycle.onDispose(() => {
            process.off(${JSON.stringify(nativeEvent)}, listener);
            process.emit(${JSON.stringify(observationEvent)}, "dispose");
          });
          api.registerProvider({ id: ${JSON.stringify(id)}, label: "Local fixture", auth: [{
            id: "local", label: "Local", kind: "custom", run: async () => ({ profiles: [] }),
            appGuidedSetup: {
              async detect() {
                const released = new Promise(resolve => process.once(${JSON.stringify(releaseEvent)}, resolve));
                process.emit(${JSON.stringify(observationEvent)}, "detect");
                await released;
                ${failed ? 'throw new Error("synthetic unavailable provider");' : `return { modelRef: ${JSON.stringify(modelRef)}, detail: "fixture available" };`}
              },
              detectAvailability: async () => true,
              prepare: async () => null,
            },
          }] });
        } };
      `,
      );
      const config: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        gateway: { mode: "local" },
        plugins: {
          allow: [id],
          load: { paths: [pluginDir] },
          entries: { [id]: { enabled: true } },
          slots: { memory: "none" },
        },
      };
      await state.writeConfig(config);
      const backend = vi.spyOn(onboardInference, "detectInferenceBackends").mockResolvedValue([]);
      try {
        for (let iteration = 0; iteration < 2; iteration++) {
          const started = createDeferredCore();
          const phases: string[] = [];
          const observe = (phase: string) => {
            phases.push(phase);
            started.resolve();
          };
          process.on(observationEvent, observe);
          const work = detectSetupInference("main");
          try {
            await Promise.race([started.promise, work]);
            expect(phases).toEqual(["detect"]);
            expect(process.listenerCount(nativeEvent)).toBe(nativeBefore + 1);
            // This caller has no inherited provider lease; a pending probe cannot hold installs.
            await withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async (lease) =>
              lease.assertOwned(),
            );
            process.emit(releaseEvent);
            const candidate = expect.objectContaining({
              kind: `provider-auto:${id}`,
              modelRef,
              detail: "fixture available",
              credentials: true,
            });
            expect((await work).candidates).toEqual(failed ? [] : [candidate]);
            expect(phases).toEqual(["detect", "dispose"]);
            expect(process.listenerCount(nativeEvent)).toBe(nativeBefore);
            expect(process.listenerCount(releaseEvent)).toBe(0);
          } finally {
            process.emit(releaseEvent);
            try {
              await work;
            } finally {
              process.off(observationEvent, observe);
            }
          }
        }
        expect(
          await detectAvailableSetupProviderIds({ config, workspaceDir: state.workspaceDir }),
        ).toEqual(new Set([id]));
        expect(process.listenerCount(nativeEvent)).toBe(nativeBefore);
      } finally {
        backend.mockRestore();
        // Restore only this fixture's events when running the regression against its leaking predecessor.
        process.removeAllListeners(nativeEvent);
        process.removeAllListeners(releaseEvent);
        process.removeAllListeners(observationEvent);
      }
    }),
);
