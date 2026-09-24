import { expect, it } from "vitest";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { executionParams, mocks } from "./update-command-execution.test-support.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";

export function registerExecutionFailureTests() {
  it.each(["activation", "requester revocation", "service ownership"])(
    "reports %s exceptions without retrying a fallback package updater",
    async (kind) => {
      const failure =
        kind === "requester revocation"
          ? new UpdateRequesterRevokedError()
          : kind === "service ownership"
            ? new GatewayServiceUpdateOwnershipError(
                "Service manager returned EACCES.",
                undefined,
                "service-manager-access-denied",
              )
            : new Error("activation failed");
      mocks.runPackageUpdate.mockRejectedValue(failure);

      const execution = await executeMutableUpdate(executionParams("package"));

      expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
      expect(execution?.failure?.cause).toBe(failure);
      expect(execution?.result).toMatchObject({
        status: "error",
        reason: kind === "requester revocation" ? "requester-revoked" : "update-failed",
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        steps: [expect.objectContaining({ name: "update", exitCode: 1 })],
      });
      expect(mocks.verifyPackageRecovery).not.toHaveBeenCalled();
      if (kind === "service ownership") {
        expect(execution?.result.steps[0]?.failureFacts).toEqual([
          {
            check: "managed-service",
            code: "service-manager-access-denied",
            message: expect.stringContaining(
              "The service-manager probe could not start (EACCES/EPERM).",
            ),
          },
        ]);
      }
    },
  );
}
