// Update phase tests cover doctor behavior during staged update phases.
import { describe, expect, it } from "vitest";
import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_IN_PROGRESS_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
  UPDATE_POST_CORE_CONVERGENCE_ENV,
  isLegacyParentWritableUpdateDoctorPass,
  isPostCoreConvergencePass,
  isUpdatePackageSwapInProgress,
  shouldDeferConfiguredPluginInstallRepair,
} from "./update-phase.js";

describe("update-phase env helpers", () => {
  it("ignores swap-in-progress when post-core convergence is also set (post-core wins)", () => {
    const env = {
      [UPDATE_IN_PROGRESS_ENV]: "1",
      [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
    };
    expect(isUpdatePackageSwapInProgress(env)).toBe(false);
    expect(isPostCoreConvergencePass(env)).toBe(true);
  });

  it("defers configured plugin repair for post-core handoffs", () => {
    expect(
      shouldDeferConfiguredPluginInstallRepair({
        [UPDATE_IN_PROGRESS_ENV]: "1",
      }),
    ).toBe(false);
    expect(
      shouldDeferConfiguredPluginInstallRepair({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
      }),
    ).toBe(true);
    expect(
      shouldDeferConfiguredPluginInstallRepair({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
      }),
    ).toBe(true);
    expect(
      shouldDeferConfiguredPluginInstallRepair({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
        [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
      }),
    ).toBe(false);
  });

  it("identifies writable legacy parents that need old-readable config writes", () => {
    expect(
      isLegacyParentWritableUpdateDoctorPass({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
      }),
    ).toBe(true);
    expect(
      isLegacyParentWritableUpdateDoctorPass({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
        [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
      }),
    ).toBe(false);
    expect(
      isLegacyParentWritableUpdateDoctorPass({
        [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
        [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
      }),
    ).toBe(false);
  });
});
