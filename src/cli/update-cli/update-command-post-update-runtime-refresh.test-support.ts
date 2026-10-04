import { expect, it, type Mock } from "vitest";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { finishUpdate } from "./update-command-post-update.js";

type RuntimeRefreshMocks = {
  readService: Mock<typeof import("../../daemon/service.js").readGatewayServiceState>;
  restart: Mock<typeof import("./update-command-service.js").maybeRestartService>;
  stop: Mock<
    typeof import("./update-command-service.js").maybeStopManagedServiceBeforeMutableUpdate
  >;
  revalidate: Mock;
  converge: Mock;
  healthy: boolean;
};

export function registerCurrentCoreRuntimeRefreshTests(
  fixture: () => FinishUpdateParams,
  mocks: RuntimeRefreshMocks,
) {
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
      const params = fixture();
      params.coreAlreadyCurrent = true;
      params.mutationStarted = false;
      params.result.status = "skipped";
      params.result.reason = "already-current";
      params.result.before = params.result.after;
      params.serviceRuntimeRefreshRequired = mode !== "healthy" && mode !== "operator-restart";
      params.packageUpdateNodeRunner = "/supported-node/bin/node";
      params.shouldRestart = mode !== "no-restart";
      params.preManagedServiceStop!.stopped = false;
      params.preManagedServiceStop!.running = mode !== "not-running" && mode !== "absent";
      if (mode === "absent") {
        params.preManagedServiceStop!.serviceUpdateVerdict = { kind: "absent" };
      }
      const restartCommand = "sudo systemctl restart openclaw-production.service";
      if (mode === "operator-restart") {
        params.preManagedServiceStop!.serviceMutationAllowed = false;
        params.preManagedServiceStop!.serviceMutationSkipMessage = `System-scope Gateway requires an operator restart. Run: ${restartCommand}`;
      }
      const order: string[] = [];
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
      mocks.converge.mockImplementation(async (input: { result: FinishUpdateParams["result"] }) => {
        order.push("converge");
        return {
          resultWithPostUpdate: {
            ...input.result,
            postUpdate: { plugins: { status: "ok", changed } },
          },
          postUpdateConfigSnapshot: params.configSnapshot,
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
        expect(mocks.restart.mock.calls[0]?.[0].refreshServiceEnv).toBe(true);
        expect(mocks.restart.mock.calls[0]?.[0].nodeRunner).toBe("/supported-node/bin/node");
      }
      if (mode === "operator-restart") {
        expect(mocks.stop).not.toHaveBeenCalled();
        const run = getUpdateRun(params.opts.run!.runId, { env: params.opts.run!.env });
        expect(renderUpdateRunReport(run!).markdown).toContain(restartCommand);
      }
    },
  );

  it("terminalizes a failed final native read after current-core plugin parking", async () => {
    const params = fixture();
    params.coreAlreadyCurrent = true;
    params.preManagedServiceStop!.stopped = false;
    params.result.status = "skipped";
    params.result.reason = "already-current";
    params.result.before = params.result.after;
    mocks.stop.mockResolvedValue({ ...params.preManagedServiceStop!, stopped: true });
    mocks.converge.mockImplementation(
      async (convergence: {
        result: FinishUpdateParams["result"];
        beforeDoctor?: () => Promise<void>;
      }) => {
        await convergence.beforeDoctor?.();
        mocks.readService.mockRejectedValueOnce(new Error("final native query failed"));
        return {
          resultWithPostUpdate: {
            ...convergence.result,
            postUpdate: { plugins: { status: "ok", changed: true } },
          },
          postUpdateConfigSnapshot: params.configSnapshot,
        };
      },
    );
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
