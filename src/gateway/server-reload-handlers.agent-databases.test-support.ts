import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyAgentDatabaseReaderRequest,
  captureDeletedAgentDatabaseFences,
  installDeletedAgentDatabaseFences,
} from "../infra/agent-database-readers.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import type { createGatewayReloadHandlers } from "./server-reload-hot.js";

export function registerGatewayAgentDatabaseReloadTests(
  createReloadHandlers: () => Pick<
    ReturnType<typeof createGatewayReloadHandlers>,
    "applyHotReload" | "stopRestartRetries"
  >,
): void {
  it.each([true, false])(
    "revives admitted database readers only after config commit (%s)",
    async (commit) => {
      const previousFences = captureDeletedAgentDatabaseFences();
      onTestFinished(() => installDeletedAgentDatabaseFences(previousFences));
      installDeletedAgentDatabaseFences([]);
      const databasePath = path.resolve("returning-reload-agent.sqlite");
      await applyAgentDatabaseReaderRequest({
        kind: "close",
        candidates: [{ path: databasePath }],
        deleted: true,
        agentId: "returning-agent",
      });
      const { applyHotReload, stopRestartRetries } = createReloadHandlers();
      const nextConfig: OpenClawConfig = {
        agents: { entries: { "returning-agent": {} } },
        logging: { level: "debug" },
      };
      try {
        const application = applyHotReload(buildGatewayReloadPlan(["logging.level"]), nextConfig, {
          sourceConfig: nextConfig,
          isCurrent: () => true,
          publish: async (publishConfig) => {
            if (!commit) {
              throw new Error("config publication rejected");
            }
            await publishConfig();
          },
        });
        if (commit) {
          await expect(application).resolves.toBe("applied");
        } else {
          await expect(application).rejects.toThrow("config publication rejected");
        }
        expect(captureDeletedAgentDatabaseFences()).toEqual(
          commit ? [] : [[databasePath, "returning-agent"]],
        );
      } finally {
        stopRestartRetries();
      }
    },
  );
}
