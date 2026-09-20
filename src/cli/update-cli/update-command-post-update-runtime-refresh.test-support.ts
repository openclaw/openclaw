import { expect, it, type Mock } from "vitest";
import { finishUpdate, type FinishUpdateParams } from "./update-command-post-update.js";

type RuntimeRefreshMocks = {
  readService: Mock<typeof import("../../daemon/service.js").readGatewayServiceState>;
  restart: Mock<typeof import("./update-command-service.js").maybeRestartService>;
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
  ] as const)(
    "activates current-core runtime refresh exactly once ($mode, changed=$changed)",
    async ({ mode, changed, activate }) => {
      const params = fixture();
      params.coreAlreadyCurrent = true;
      params.mutationStarted = false;
      params.result.status = "skipped";
      params.result.reason = "already-current";
      params.result.before = params.result.after;
      params.serviceRuntimeRefreshRequired = mode !== "healthy";
      params.packageUpdateNodeRunner = "/supported-node/bin/node";
      params.shouldRestart = mode !== "no-restart";
      params.preManagedServiceStop!.stopped = false;
      params.preManagedServiceStop!.running = mode !== "not-running" && mode !== "absent";
      if (mode === "absent") {
        params.preManagedServiceStop!.serviceUpdateVerdict = { kind: "absent" };
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
    },
  );
}
