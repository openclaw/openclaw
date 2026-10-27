import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as runtimeConfig from "../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runCommand } from "./invoke-run-command.js";
import { handleSystemRunInvoke } from "./invoke-system-run.js";

describe("node command service identity", () => {
  const tempDirs = createTempDirTracker();
  let stateDir = "";

  beforeAll(() => {
    closeOpenClawStateDatabaseForTest();
    stateDir = tempDirs.make("node-child-state-");
  });

  afterAll(() => {
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  });

  it.each([undefined, { chatId: "chat-1" }])(
    "runs child commands without inherited service identity with context %j",
    async (executionContext) => {
      const serviceEnv = {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "node",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.node",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
        OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
        OPENCLAW_TASK_SCRIPT_NAME: "node.cmd",
        OPENCLAW_LOG_PREFIX: "node",
        OPENCLAW_GATEWAY_SERVICE_PID: "12345",
      };
      await withEnvAsync(
        {
          ...serviceEnv,
          OPENCLAW_HOME: stateDir,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_PROFILE: "node-proof",
        },
        async () => {
          const config = vi.spyOn(runtimeConfig, "getRuntimeConfig").mockReturnValue({
            tools: { exec: { security: "full", ask: "off" } },
          });
          onTestFinished(() => config.mockRestore());
          const keys = [...Object.keys(serviceEnv), "OPENCLAW_STATE_DIR", "OPENCLAW_PROFILE"];
          const command = [
            process.execPath,
            "-e",
            `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]))))`,
          ];
          for (const env of [undefined, { OPENCLAW_SYSTEMD_UNIT: "custom-gateway.service" }]) {
            const sendInvokeResult = vi.fn<
              Parameters<typeof handleSystemRunInvoke>[0]["sendInvokeResult"]
            >(async () => {});
            await handleSystemRunInvoke({
              params: { command, env, executionContext },
              skillBins: { current: async () => [] },
              runCommand,
              sendInvokeResult,
              preferMacAppExecHost: false,
            });
            const [response] = sendInvokeResult.mock.calls[0] ?? [];
            expect(response?.ok).toBe(true);
            const result = JSON.parse(response?.payloadJSON ?? "{}");
            expect(result).toMatchObject({ success: true, exitCode: 0 });
            expect(JSON.parse(result.stdout)).toEqual({
              OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_PROFILE: "node-proof",
              ...env,
            });
          }
          expect(process.env).toMatchObject(serviceEnv);
        },
      );
    },
  );
});
