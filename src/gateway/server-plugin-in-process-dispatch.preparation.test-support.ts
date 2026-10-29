import { expect, it, vi, type Mock } from "vitest";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { heldWork } from "./server-plugin-reload.fixture-tools.test-support.js";

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
    { method: "agent", outcome: "retired-factory" },
    { method: "agent.wait", outcome: "current" },
    { method: "agent.wait", outcome: "replaced" },
    { method: "agent.wait", outcome: "retired-factory" },
    { method: "health", outcome: "current" },
    { method: "health", outcome: "replaced" },
  ])(
    "revalidates $method after preparation with a $outcome Gateway",
    async ({ method, outcome }) => {
      const gate = heldWork();
      const response =
        method === "health" ? { ok: true } : { runId: "prepared-source", status: "accepted" };
      const handler = vi.fn(({ respond }: GatewayRequestHandlerOptions) => respond(true, response));
      const handlers = createLazyCoreHandlers({
        methods: ["health"],
        loadHandlers: async () => {
          await gate.run();
          return { health: handler };
        },
      });
      const context = createContext(
        method === "health" ? [["health", "operator.read", "test", handlers.health!]] : [],
      );
      let current = context;
      if (method !== "health") {
        const createFacade = context.createAgentTurnFacade!;
        context.createAgentTurnFacade = async (principal) => {
          await gate.run();
          return createFacade(principal);
        };
      }
      const prepareDispatchCurrent = vi.fn(async () => {
        if (outcome === "replaced") {
          current = createContext();
        }
      });
      startTurn.mockImplementation(async ({ io }) => io.emitAcceptance([true, response]));
      waitForTurn.mockResolvedValue({ result: response });
      const params =
        method === "agent"
          ? { message: "prepared turn", idempotencyKey: "prepared-source" }
          : method === "agent.wait"
            ? { runId: "prepared-source" }
            : {};
      const pending = dispatchGatewayMethodInProcess(method, params, {
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        resolveGatewayContext: () => current,
        ...(outcome === "retired-factory" ? {} : { prepareDispatchCurrent }),
      });
      const result =
        outcome === "current"
          ? expect(pending).resolves.toEqual(response)
          : expect(pending).rejects.toThrow("current gateway instance binding");
      await gate.entered;
      expect(prepareDispatchCurrent).not.toHaveBeenCalled();
      if (outcome === "retired-factory") {
        current = createContext();
      }
      gate.release();
      await result;
      expect(prepareDispatchCurrent).toHaveBeenCalledTimes(outcome === "retired-factory" ? 0 : 1);
      expect(startTurn).toHaveBeenCalledTimes(Number(outcome === "current" && method === "agent"));
      expect(waitForTurn).toHaveBeenCalledTimes(
        Number(outcome === "current" && method === "agent.wait"),
      );
      expect(handler).toHaveBeenCalledTimes(Number(outcome === "current" && method === "health"));
    },
  );
}
