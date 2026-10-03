import { expect, it, vi, type Mock } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { InternalAgentTurnPrincipalOptions } from "./agent-turn/internal-facade.types.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

export function registerInProcessGatewayDispatchPreparationTests({
  startTurn,
  waitForTurn,
}: {
  startTurn: Mock;
  waitForTurn: Mock;
}): void {
  it.each([
    { method: "agent", outcome: "current" },
    { method: "agent", outcome: "replaced" },
    { method: "agent.wait", outcome: "current" },
    { method: "agent.wait", outcome: "replaced" },
  ])(
    "refreshes source authority after $method facade preparation with a $outcome Gateway",
    async ({ method, outcome }) => {
      const context = createContext();
      let current = context;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const createFacade = context.createAgentTurnFacade!;
      context.createAgentTurnFacade = Object.assign(
        async (principal: InternalAgentTurnPrincipalOptions) => {
          entered.resolve();
          await release.promise;
          return createFacade(principal);
        },
        { captureOperatorRunAuthority: createFacade.captureOperatorRunAuthority },
      );
      const prepareDispatchCurrent = vi.fn(async () => {
        if (outcome === "replaced") {
          current = createContext();
        }
      });
      const response = { runId: "prepared-source", status: "accepted" };
      startTurn.mockImplementation(async ({ io }) => io.emitAcceptance([true, response]));
      waitForTurn.mockResolvedValue({ result: response });
      const pending = dispatchGatewayMethodInProcess(
        method,
        method === "agent"
          ? { message: "prepared turn", idempotencyKey: "prepared-source" }
          : { runId: "prepared-source" },
        {
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          resolveGatewayContext: () => current,
          prepareDispatchCurrent,
        },
      );
      const result =
        outcome === "current"
          ? expect(pending).resolves.toEqual(response)
          : expect(pending).rejects.toThrow("current gateway instance binding");
      await entered.promise;
      expect(prepareDispatchCurrent).not.toHaveBeenCalled();
      release.resolve();
      await result;
      expect(prepareDispatchCurrent).toHaveBeenCalledOnce();
      expect(startTurn).toHaveBeenCalledTimes(outcome === "current" && method === "agent" ? 1 : 0);
      expect(waitForTurn).toHaveBeenCalledTimes(
        outcome === "current" && method === "agent.wait" ? 1 : 0,
      );
    },
  );

  it.each(["current", "replaced"])(
    "checks a %s Gateway after raw dispatch preparation before invoking its handler",
    async (outcome) => {
      const context = createContext();
      let current = context;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const handler = vi.fn(({ respond }: GatewayRequestHandlerOptions) => {
        respond(true, { ok: true });
      });
      const handlers = createLazyCoreHandlers({
        methods: ["health"],
        loadHandlers: async () => {
          entered.resolve();
          await release.promise;
          return { health: handler };
        },
      });
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "health",
            scope: "operator.read",
            owner: { kind: "core", area: "test" },
            handler: handlers.health!,
          },
        ]);
      const prepareDispatchCurrent = vi.fn(async () => {
        if (outcome === "replaced") {
          current = createContext();
        }
      });
      const pending = dispatchGatewayMethodInProcess(
        "health",
        {},
        {
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          resolveGatewayContext: () => current,
          prepareDispatchCurrent,
        },
      );
      await entered.promise;
      expect(prepareDispatchCurrent).not.toHaveBeenCalled();
      release.resolve();
      if (outcome === "current") {
        await expect(pending).resolves.toEqual({ ok: true });
      } else {
        await expect(pending).rejects.toThrow("current gateway instance binding");
      }
      expect(prepareDispatchCurrent).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledTimes(outcome === "current" ? 1 : 0);
    },
  );
}
