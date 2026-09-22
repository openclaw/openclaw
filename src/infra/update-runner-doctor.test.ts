import { describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  buildUpdateDoctorEnv,
  resolveUpdateDoctorExecutionPolicy,
} from "./update-runner-doctor.js";

describe("resolveUpdateDoctorExecutionPolicy", () => {
  it("keeps fix mode when service repair is authorized", () => {
    expect(
      resolveUpdateDoctorExecutionPolicy({
        targetVersion: "2026.4.1",
        allowGatewayServiceRepair: true,
      }),
    ).toEqual({ fix: true });
  });

  it("uses the external policy for targets that support it", () => {
    for (const targetVersion of ["2026.4.25-beta.1", "2026.4.25-beta.11", "2026.4.25"]) {
      expect(
        resolveUpdateDoctorExecutionPolicy({
          targetVersion,
          allowGatewayServiceRepair: false,
        }),
      ).toEqual({ fix: true, serviceRepairPolicy: "external" });
    }
  });

  it("does not run fix mode on older targets that cannot honor ownership", () => {
    expect(
      resolveUpdateDoctorExecutionPolicy({
        targetVersion: "2026.4.24",
        allowGatewayServiceRepair: false,
      }),
    ).toEqual({ fix: false });
  });

  it.each([
    {
      name: "authorized service repair",
      targetVersion: "2026.4.1",
      allowGatewayServiceRepair: true,
      expectedPolicy: null,
    },
    {
      name: "an older target without service repair",
      targetVersion: "2026.4.24",
      allowGatewayServiceRepair: false,
      expectedPolicy: null,
    },
    {
      name: "a supported target without service repair",
      targetVersion: "2026.4.25",
      allowGatewayServiceRepair: false,
      expectedPolicy: "external",
    },
  ])(
    "passes the selected Doctor policy to a real child for $name",
    async ({ targetVersion, allowGatewayServiceRepair, expectedPolicy }) => {
      const policy = resolveUpdateDoctorExecutionPolicy({
        targetVersion,
        allowGatewayServiceRepair,
      });
      const result = await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, () =>
        runCommandWithTimeout(
          [
            process.execPath,
            "-e",
            "process.stdout.write(JSON.stringify(process.env.OPENCLAW_SERVICE_REPAIR_POLICY ?? null))",
          ],
          {
            timeoutMs: 5000,
            env: buildUpdateDoctorEnv({
              allowGatewayServiceRepair,
              allowGatewayActivation: false,
              serviceRepairPolicy: policy.serviceRepairPolicy,
            }),
          },
        ),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(JSON.stringify(expectedPolicy));
    },
  );
});
