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
      }),
    ).toEqual({ fix: true, serviceRepairPolicy: "external" });
  });

  it.each([
    {
      name: "an older target with parent repair authorization",
      targetVersion: "2026.4.1",
      allowGatewayServiceRepair: true,
      expectedFix: false,
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
            "process.stdout.write(JSON.stringify({policy:process.env.OPENCLAW_SERVICE_REPAIR_POLICY??null,repair:process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR}))",
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
      expect(JSON.parse(result.stdout)).toEqual({
        policy: expectedPolicy,
        repair: allowGatewayServiceRepair ? "1" : "0",
      });
    },
  );
});
