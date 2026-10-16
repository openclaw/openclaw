import { describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  buildUpdateDoctorEnv,
  resolveUpdateDoctorExecutionPolicy,
} from "./update-runner-doctor.js";

describe("resolveUpdateDoctorExecutionPolicy", () => {
  it("supports external ownership from the first compatible prerelease", () => {
    expect(
      resolveUpdateDoctorExecutionPolicy({
        targetVersion: "2026.4.25-beta.1",
        allowGatewayServiceRepair: false,
      }),
    ).toEqual({ fix: true, serviceRepairPolicy: "external" });
  });

  it.each([
    {
      name: "authorized service repair",
      targetVersion: "2026.4.1",
      allowGatewayServiceRepair: true,
      expectedFix: true,
      expectedPolicy: null,
    },
    {
      name: "an older target without service repair",
      targetVersion: "2026.4.24",
      allowGatewayServiceRepair: false,
      expectedFix: false,
      expectedPolicy: null,
    },
    {
      name: "a supported target without service repair",
      targetVersion: "2026.4.25",
      allowGatewayServiceRepair: false,
      expectedFix: true,
      expectedPolicy: "external",
    },
  ])(
    "passes the selected Doctor policy to a real child for $name",
    async ({ targetVersion, allowGatewayServiceRepair, expectedFix, expectedPolicy }) => {
      const policy = resolveUpdateDoctorExecutionPolicy({
        targetVersion,
        allowGatewayServiceRepair,
      });
      expect(policy).toEqual({
        fix: expectedFix,
        ...(expectedPolicy === null ? {} : { serviceRepairPolicy: expectedPolicy }),
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
