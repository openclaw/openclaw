import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider } from "../../plugins/types.js";
import { allocationSnapshot } from "./provider-allocation-snapshot.js";

const configured = {
  provider: "fake",
  settings: { binary: "trusted-helper", provider: "trusted-account" },
};
describe("allocation resource selection", () => {
  it("persists effective provider settings and resource identity without changing authority", () => {
    const resources = { machineType: "native-type", region: "test-region", diskSizeGb: 80 };
    const selectMachineResources = vi.fn<NonNullable<WorkerProvider["selectMachineResources"]>>(
      (settings, requested) => ({ ...settings, requestedResources: requested }),
    );
    const snapshot = allocationSnapshot(configured, { resources }, { selectMachineResources });
    expect(selectMachineResources).toHaveBeenCalledWith(configured.settings, resources);
    expect(snapshot).toEqual({
      ...configured,
      resources,
      settings: { ...configured.settings, requestedResources: resources },
    });
  });
  it("rejects unsupported or conflicting selectors before allocation", () => {
    expect(() => allocationSnapshot(configured, { resources: { region: "test-region" } })).toThrow(
      "does not support",
    );
    expect(() =>
      allocationSnapshot(configured, {
        machineClass: "small",
        resources: { machineType: "native-type" },
      }),
    ).toThrow("not both");
  });
  it("does not inherit caller-looking resource or guest metadata from configuration", () => {
    expect(
      allocationSnapshot(
        { ...configured, resources: { region: "stale" }, sessionGuest: { profileId: "other" } },
        {},
      ),
    ).toEqual(configured);
  });
});
