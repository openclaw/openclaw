import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  checkDoctorExternalConfigPending,
  validateDoctorExternalConfigForStartup,
} from "./doctor-external-config.js";

const runtime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

describe("Doctor external config startup check", () => {
  it("is pending exactly when an externally managed config would refuse startup", async () => {
    await withOpenClawTestState(
      { prefix: "openclaw-doctor-external-config-", env: { OPENCLAW_CONFIG_READONLY: "1" } },
      async (state) => {
        await state.writeConfig({ gateway: { mode: "local" }, notAConfigKey: true });
        const before = fs.readFileSync(state.configPath);

        await expect(checkDoctorExternalConfigPending()).resolves.toBe("work");
        expect(fs.readFileSync(state.configPath)).toEqual(before);
        const refused = runtime();
        await expect(validateDoctorExternalConfigForStartup(refused)).resolves.toBe(false);
        expect(refused.error).toHaveBeenCalledWith(
          expect.stringContaining("Gateway startup requires the pending config repairs"),
        );

        await state.writeConfig({ gateway: { mode: "local" } });
        await expect(checkDoctorExternalConfigPending()).resolves.toBe("none");
        await expect(validateDoctorExternalConfigForStartup(runtime())).resolves.toBe(true);
      },
    );
  });

  it("has no work for a config Doctor writes itself", async () => {
    await withOpenClawTestState({ prefix: "openclaw-doctor-external-config-" }, async (state) => {
      await state.writeConfig({ gateway: { mode: "local" }, notAConfigKey: true });

      await expect(checkDoctorExternalConfigPending()).resolves.toBe("none");
      await expect(validateDoctorExternalConfigForStartup(runtime())).resolves.toBe(true);
    });
  });
});
