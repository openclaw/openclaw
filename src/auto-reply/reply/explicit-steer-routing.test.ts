import { expect, it, vi } from "vitest";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { resolveActiveExplicitSteerSessionKey } from "./explicit-steer-routing.js";

it.each(["foreign-only", "selected", "selected-unavailable"] as const)(
  "resolves explicit steer in the configured physical store: %s",
  async (owner) => {
    const sessionKey = "agent:main:telegram:direct:reader";
    const storePath = "/stores/explicit-steer-selected.sqlite";
    const create = (storeScope: string, available: boolean) => {
      const operation = createReplyOperation({
        sessionKey,
        sessionId: "same-incarnation",
        resetTriggered: false,
        target: captureSessionTarget({ storeScope, sessionKey, agentId: "main" }),
      });
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        cancel: vi.fn(),
        messageInjection: { isAvailable: () => available, queueMessage: vi.fn() },
      });
      return operation;
    };
    const foreign = create("/stores/explicit-steer-foreign.sqlite", true);
    const selected = owner === "foreign-only" ? undefined : create(storePath, owner === "selected");
    try {
      expect(
        resolveActiveExplicitSteerSessionKey({
          cfg: { session: { store: storePath } },
          ctx: {
            SessionKey: "agent:main:telegram:slash:reader",
            CommandAuthorized: true,
            CommandTurn: {
              kind: "text-slash",
              source: "text",
              authorized: true,
              commandName: "steer",
              body: "/steer include the result",
            },
          },
        }),
      ).toBe(owner === "selected" ? sessionKey : undefined);
      expect(foreign.abortSignal.aborted).toBe(false);
    } finally {
      selected?.complete();
      foreign.complete();
      await Promise.all([selected?.ownerSettlement, foreign.ownerSettlement]);
    }
  },
);
