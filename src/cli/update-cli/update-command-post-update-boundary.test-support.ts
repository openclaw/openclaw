import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import type { PackageLauncherFingerprint } from "../../infra/package-update-integrity.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  managedServiceState,
} from "./update-command-post-update.test-support.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import * as rollbackModule from "./update-command-rollback.js";
import * as nativeCommand from "./update-command-service-command.js";
import type { OriginalManagedServiceRuntime } from "./update-command-service-context-types.js";
import * as serviceLoad from "./update-command-service-load.js";

export function registerBoundaryFinalizationControls({
  makeTempDir,
  mocks,
}: {
  makeTempDir: (prefix: string) => string;
  mocks: {
    readServiceState: Mock;
    restartService: Mock<typeof import("./update-command-service.js").maybeRestartService>;
  };
}) {
  it.each(["no-child", "unsettled-child"] as const)(
    "retained boundary finalization distinguishes native effects: %s",
    async (scenario) => {
      const home = makeTempDir("retained-boundary-no-effect-");
      const identity = createManagedServiceIdentityFixture(home);
      try {
        await fs.mkdir(path.join(home, "dist"));
        await fs.writeFile(
          path.join(home, "package.json"),
          JSON.stringify({ name: "openclaw", type: "module" }),
        );
        await fs.writeFile(path.join(home, "dist", "index.js"), "export {};\n");
        const launcherFingerprint: PackageLauncherFingerprint = {
          type: "file",
          mode: "33188",
          uid: "0",
          gid: "0",
          contents: "fixture",
        };
        const original: OriginalManagedServiceRuntime = {
          root: home,
          nodeRunner: process.execPath,
          version: "2026.9.3",
          verified: true,
          definition: {
            command: { programArguments: [process.execPath, path.join(home, "dist/index.js")] },
            fingerprint: "fixture-original",
            runtimePin: { revision: "fixture-no-runtime-pin", stored: false },
          },
          service: { serviceEnv: { HOME: home } },
          packageIdentity: { identity: "fixture-directory", version: "2026.9.3" },
          launcher: {
            path: "fixture",
            realPath: "fixture",
            fingerprint: launcherFingerprint,
            targetFingerprint: launcherFingerprint,
          },
          nodeIdentity: "fixture-node",
        };
        mocks.readServiceState.mockResolvedValue(managedServiceState(process.env));
        const boundary = { assertCurrent: vi.fn(), seal: vi.fn() };
        const install = vi.spyOn(serviceLoad, "runGatewayInstallWithLoadBoundary");
        const actual = await vi.importActual<typeof import("./update-command-service.js")>(
          "./update-command-service.js",
        );
        const uncertain = new UpdateCommandRecoveryPendingError(
          "write-capable child remains unsettled",
        );
        const command = vi.spyOn(nativeCommand, "runUpdatedInstallGatewayCommand");
        if (scenario === "unsettled-child") {
          command.mockRejectedValueOnce(uncertain);
        }
        // Drive the real service and command catch boundaries. Only transport setup
        // and the compensation leaf are inert; no definition or process is mutated.
        mocks.restartService.mockImplementationOnce((params) =>
          actual.maybeRestartService({
            ...params,
            shouldRestart: true,
            refreshServiceEnv: true,
            serviceInstallEnv: {},
            originalManagedServiceRuntime: original,
            serviceLoadBoundary: boundary,
            serviceUpdateVerdict: undefined,
            result: { ...params.result, root: home },
          }),
        );
        const rollback = vi
          .spyOn(rollbackModule, "rollbackFailedUpdate")
          .mockImplementationOnce(async ({ result, originalManagedServiceRuntime }) => {
            expect(originalManagedServiceRuntime).toBe(original);
            return { result, rolledBack: false, originalServiceRecovery: "healthy" };
          });
        const finishing = finishSuccessfulPackageSwitch(undefined, {
          originalManagedServiceRuntime: original,
        });
        if (scenario === "no-child") {
          await expect(finishing).rejects.toMatchObject({
            name: "UpdateCommandFailure",
            result: { status: "error" },
          });
          expect(rollback).toHaveBeenCalledOnce();
        } else {
          await expect(finishing).rejects.toMatchObject({
            name: "UpdateCommandPendingRecoveryFailure",
            cause: uncertain,
          });
          expect(rollback).not.toHaveBeenCalled();
        }
        expect(install).not.toHaveBeenCalled();
        expect(boundary.seal).not.toHaveBeenCalled();
        expect(command).toHaveBeenCalledOnce();
        await expect(command.mock.results[0]?.value).rejects.toMatchObject({
          name:
            scenario === "no-child"
              ? "UpdateServiceLoadPreMutationError"
              : "UpdateCommandRecoveryPendingError",
        });
      } finally {
        identity.restore();
      }
    },
  );
}
