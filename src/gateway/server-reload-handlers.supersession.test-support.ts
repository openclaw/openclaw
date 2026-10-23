import { expect, it, type Mock } from "vitest";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

/** Reuses the admitted September reload fixture rather than a second mock graph. */
export function registerModelPublicationSupersessionTests(input: {
  createFixture: () => {
    handlers: ReturnType<typeof import("./server-reload-hot.js").createGatewayReloadHandlers>;
    setState: Mock;
  };
  installRefresh: (implementation: () => Promise<never>) => () => void;
}) {
  it.each([
    {
      name: "superseded publication",
      superseded: true,
      publicationReplaced: true,
      cancelled: true,
    },
    { name: "current publication", superseded: false, publicationReplaced: true, cancelled: false },
    {
      name: "failed superseded publication",
      superseded: true,
      publicationReplaced: false,
      cancelled: false,
    },
    {
      name: "failed current publication",
      superseded: false,
      publicationReplaced: false,
      cancelled: false,
    },
  ])(
    "preserves the recovery distinction for a $name",
    async ({ superseded, publicationReplaced, cancelled }) => {
      const { handlers, setState } = input.createFixture();
      const config: OpenClawConfig = {
        models: {
          providers: {
            fixture: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "synthetic-key", models: [] },
          },
        },
      };
      const plan = buildGatewayReloadPlan(["models.providers.fixture.apiKey"]);
      let current = true;
      const restoreRefresh = input.installRefresh(async () => {
        current = !superseded;
        throw publicationReplaced
          ? new PreparedModelRuntimePublicationSupersededError("publication replaced")
          : new Error("catalog build failed");
      });
      try {
        const reload = handlers.applyHotReload(plan, config, {
          sourceConfig: config,
          isCurrent: () => current,
          publish: async (commit) => await commit(),
        });
        if (cancelled) {
          await expect(reload).rejects.toBeInstanceOf(GatewayConfigReloadSupersededError);
        } else {
          await expect(reload).resolves.toBe("applied-restart-required");
        }
        expect(setState).toHaveBeenCalledOnce();
        expect(handlers.hasOutstandingGatewayRestart()).toBe(!cancelled);
      } finally {
        restoreRefresh();
        handlers.stopRestartRetries();
      }
    },
  );
}
