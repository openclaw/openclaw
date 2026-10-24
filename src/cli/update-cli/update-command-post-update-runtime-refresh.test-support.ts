import { expect, it, vi, type Mock } from "vitest";
import { ServiceStartRefusalError } from "../../daemon/service-inspection-error.js";
import type { readGatewayServiceState } from "../../daemon/service.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { finishUpdate } from "./update-command-post-update.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
} from "./update-command-post-update.test-support.js";
import * as rollbackModule from "./update-command-rollback.js";
import type * as serviceOperations from "./update-command-service.js";

type RuntimeRefreshMocks = {
  readService: Mock<typeof readGatewayServiceState>;
  restart: Mock<typeof serviceOperations.maybeRestartService>;
  stop: Mock<typeof serviceOperations.maybeStopManagedServiceBeforeMutableUpdate>;
  revalidate: Mock;
  converge: Mock;
  healthy: boolean;
};

export function registerCurrentCoreRuntimeRefreshTests(
  fixture: () => FinishUpdateParams,
  mocks: RuntimeRefreshMocks,
) {
  function currentCore(changed = false, order: string[] = [], finalReadError?: string) {
    const params = fixture();
    params.coreAlreadyCurrent = true;
    params.preManagedServiceStop!.stopped = false;
    params.result.status = "skipped";
    params.result.reason = "already-current";
    params.result.before = params.result.after;
    mocks.converge.mockImplementation(
      async (input: {
        result: FinishUpdateParams["result"];
        beforeDoctor?: () => Promise<void>;
      }) => {
        order.push("converge");
        if (finalReadError) {
          await input.beforeDoctor?.();
          mocks.readService.mockRejectedValueOnce(new Error(finalReadError));
        }
        return {
          resultWithPostUpdate: {
            ...input.result,
            postUpdate: { plugins: { status: "ok", changed } },
          },
          postUpdateConfigSnapshot: params.configSnapshot,
        };
      },
    );
    return params;
  }

  it.each([
    { mode: "refresh", changed: false, activate: true },
    { mode: "refresh", changed: true, activate: true },
    { mode: "healthy", changed: false, activate: false },
    { mode: "no-restart", changed: false, activate: false },
    { mode: "not-running", changed: false, activate: false },
    { mode: "absent", changed: false, activate: false },
    { mode: "operator-restart", changed: false, activate: false },
  ] as const)(
    "activates current-core runtime refresh exactly once ($mode, changed=$changed)",
    async ({ mode, changed, activate }) => {
      const order: string[] = [];
      const params = currentCore(changed, order);
      params.mutationStarted = false;
      params.serviceRuntimeRefreshRequired = mode !== "healthy" && mode !== "operator-restart";
      params.packageUpdateNodeRunner = "/supported-node/bin/node";
      params.shouldRestart = mode !== "no-restart";
      params.preManagedServiceStop!.running = mode !== "not-running" && mode !== "absent";
      if (mode === "absent") {
        params.preManagedServiceStop!.serviceUpdateVerdict = { kind: "absent" };
      }
      const restartCommand = "sudo systemctl restart openclaw-production.service";
      if (mode === "operator-restart") {
        params.preManagedServiceStop!.serviceMutationAllowed = false;
        params.preManagedServiceStop!.serviceMutationSkipMessage = `System-scope Gateway requires an operator restart. Run: ${restartCommand}`;
      }
      mocks.readService.mockResolvedValue({
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        runtime: { status: "running", pid: 4321 },
        env: params.ownedManagedUpdateEnv!,
        command: {
          programArguments: [process.execPath, "/candidate/dist/entry.js", "gateway"],
          environment: Object.fromEntries(
            Object.entries(params.ownedManagedUpdateEnv!).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
        },
      });
      mocks.revalidate.mockImplementation(async () => {
        order.push("inspect");
        return {
          kind: "owned",
          root: "/candidate",
          fingerprint: "fixture",
          refreshDefinition: true,
        };
      });
      mocks.restart.mockImplementation(async () => {
        order.push("restart");
        return "ok";
      });
      mocks.healthy = true;
      await finishUpdate(params);
      expect(mocks.restart).toHaveBeenCalledTimes(activate ? 1 : 0);
      if (activate) {
        expect(order).toEqual(["inspect", "converge", "inspect", "restart"]);
        expect(mocks.restart.mock.calls[0]?.[0]).toMatchObject({
          refreshServiceEnv: true,
          nodeRunner: "/supported-node/bin/node",
        });
      }
      if (mode === "operator-restart") {
        expect(mocks.stop).not.toHaveBeenCalled();
        const run = getUpdateRun(params.opts.run!.runId, { env: params.opts.run!.env });
        expect(renderUpdateRunReport(run!).markdown).toContain(restartCommand);
      }
    },
  );

  it("terminalizes a failed final native read after current-core plugin parking", async () => {
    const params = currentCore(true, [], "final native query failed");
    mocks.stop.mockResolvedValue({ ...params.preManagedServiceStop!, stopped: true });
    await expect(finishUpdate(params)).rejects.toMatchObject({
      exitCode: 1,
      result: {
        status: "error",
        reason: "state-migrated-no-rollback",
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "post-update verification", exitCode: 1 }),
        ]),
      },
    });
    expect(getUpdateRun(params.opts.run!.runId, { env: params.opts.run!.env })).toMatchObject({
      status: "failed",
    });
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.restart).not.toHaveBeenCalled();
  });
}

export function registerServiceStartRefusalFinalizationTests({
  makeTempDir,
  mocks,
}: {
  makeTempDir: (prefix: string) => string;
  mocks: {
    readServiceState: Mock;
    restartService: Mock<typeof serviceOperations.maybeRestartService>;
    printResult: Mock;
  };
}) {
  it.for(["restart", "revalidation"] as const)(
    "keeps the activated candidate when its service definition refuses startup (%s)",
    async (phase, { onTestFinished }) => {
      const identity = createManagedServiceIdentityFixture(makeTempDir("finalizer-service-hold-"));
      onTestFinished(identity.restore);
      const root = identity.home;
      const rollback = vi.spyOn(rollbackModule, "rollbackFailedUpdate");
      const restorePackage = vi.fn();
      const complete = vi.fn(async () => undefined);
      if (phase === "revalidation") {
        mocks.readServiceState.mockRejectedValueOnce(
          new ServiceStartRefusalError({
            reason: "masked",
            message: "Run `systemctl --user unmask openclaw-gateway.service`, then retry.",
          }),
        );
        const actual = await vi.importActual<typeof serviceOperations>(
          "./update-command-service.js",
        );
        mocks.restartService.mockImplementationOnce(actual.maybeRestartService);
      } else {
        mocks.restartService.mockResolvedValueOnce("reconciliation-pending");
      }

      await expect(
        finishSuccessfulPackageSwitch(
          {
            packageRoot: root,
            restartEnvironment: process.env,
            stoppedForUpdate: phase === "revalidation",
          },
          { packageTransaction: { backupRoot: root, rollback: restorePackage, complete } },
        ),
      ).resolves.toBeUndefined();

      expect(rollback).not.toHaveBeenCalled();
      expect(restorePackage).not.toHaveBeenCalled();
      expect(mocks.restartService).toHaveBeenCalledOnce();
      if (phase === "revalidation") {
        expect(mocks.restartService).toHaveBeenCalledWith(
          expect.objectContaining({
            shouldRestart: false,
            serviceMutationSkipMessage: expect.stringMatching(
              /SERVICE-DEFINITION.*unmask.*openclaw gateway start/,
            ),
          }),
        );
        expect(mocks.printResult.mock.lastCall?.[0].steps).toContainEqual(
          expect.objectContaining({
            advisory: expect.objectContaining({
              message: expect.stringContaining("SERVICE-DEFINITION"),
            }),
          }),
        );
      }
      expect(complete).toHaveBeenCalledOnce();
      expect(mocks.printResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: "ok", root }),
        expect.anything(),
        expect.anything(),
      );
    },
  );
}
