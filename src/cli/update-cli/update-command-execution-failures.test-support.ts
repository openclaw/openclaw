import { expect, it } from "vitest";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import {
  executionParams,
  inspectOrStopService,
  mocks,
} from "./update-command-execution.test-support.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";

export function registerExecutionFailureTests() {
  it.each(["service-definition-not-writable", "service-context-changed"] as const)(
    "names the managed-service refusal before package mutation: %s",
    async (code) => {
      const params = executionParams("package");
      if (code === "service-definition-not-writable") {
        params.managedServiceRoot = "/serving/install";
      } else {
        params.managedServiceRootRedirect = { root: params.root, previousRoot: "/other/install" };
        mocks.maybeStopService.mockImplementation(async () => ({
          ...inspectOrStopService("inspect"),
          serviceEnv: undefined,
        }));
      }

      const execution = await executeMutableUpdate(params);

      expect(execution).toMatchObject({
        mutationStarted: false,
        result: {
          status: "error",
          reason: "managed-service-preflight",
          steps: [{ failureFacts: [{ check: "managed-service-preflight", code }] }],
        },
      });
      expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
      expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
      expect(mocks.serviceStopped).toBe(false);
    },
  );

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
