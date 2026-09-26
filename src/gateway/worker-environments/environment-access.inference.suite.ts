import { expect, it } from "vitest";
import * as support from "./service.test-support.js";
export function registerRecordedInferenceAccessTests(): void {
  it("projects recorded inference independently of live configuration without changing snapshots", async () => {
    const service = support.createService(support.createProvider());
    for (const inference of [undefined, "gateway", "worker", "runtime-local", "invalid"]) {
      const environmentId = "inference-" + inference;
      const profileSnapshot = {
        settings: { device: "paired-node", ...(inference ? { inference } : {}) },
      };
      await support.testState.store.createIntent({
        environmentId,
        providerId: "device",
        profileId: "named-device",
        profileSnapshot,
        provisionOperationId: "provision-" + environmentId,
      });
      // Reconfiguring a profile must never change an already recorded inference choice.
      support.testState.config.cloudWorkers = {
        profiles: {
          "named-device": {
            provider: "device",
            settings: { device: "other-node", inference: "gateway" },
          },
        },
      };
      expect(service.get(environmentId)?.inference).toBe(
        inference === "worker" || inference === "runtime-local" ? "worker" : undefined,
      );
      expect(support.testState.store.get(environmentId)?.profileSnapshot).toEqual(profileSnapshot);
      delete support.testState.config.cloudWorkers;
      expect(service.get(environmentId)?.inference).toBe(
        inference === "worker" || inference === "runtime-local" ? "worker" : undefined,
      );
    }
  });
}
