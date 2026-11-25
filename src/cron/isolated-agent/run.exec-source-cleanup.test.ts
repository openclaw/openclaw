import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as cronRunExecSource from "../../infra/cron-run-exec-source.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  getChannelPluginMock,
  loadRunCronIsolatedAgentTurn,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("cron execution-source cleanup", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each(["success", "preparation error", "execution error"] as const)(
    "releases the execution source after %s",
    async (outcome) => {
      getChannelPluginMock.mockReset();
      const registeredRunIds: string[] = [];
      const releases: Array<() => void> = [];
      const register = cronRunExecSource.registerCronRunExecSource;
      const registration = vi
        .spyOn(cronRunExecSource, "registerCronRunExecSource")
        .mockImplementation((runId, source) => {
          const release = register(runId, source);
          registeredRunIds.push(runId);
          releases.push(release);
          expect(cronRunExecSource.lookupCronRunExecSource(runId)).toEqual(source);
          return release;
        });
      onTestFinished(() => {
        releases.forEach((release) => release());
        registration.mockRestore();
      });

      resolveDeliveryTargetMock.mockResolvedValue({
        ok: true,
        channel: "messagechat",
        to: "test-target",
      });
      if (outcome === "preparation error") {
        resolveCronDeliveryPlanMock.mockReturnValue({
          requested: true,
          mode: "announce",
          channel: "messagechat",
          to: "test-target",
        });
        getChannelPluginMock.mockReturnValue({
          threading: {
            resolveCurrentChannelId: () => {
              throw new Error("channel target preparation failed");
            },
          },
        });
      } else if (outcome === "execution error") {
        runWithModelFallbackMock.mockRejectedValueOnce(new Error("execution failed"));
      }

      const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

      expect(result.status).toBe(outcome === "success" ? "ok" : "error");
      if (outcome === "preparation error") {
        expect(result.error).toContain("channel target preparation failed");
        expect(runWithModelFallbackMock).not.toHaveBeenCalled();
      } else if (outcome === "execution error") {
        expect(result.error).toContain("execution failed");
      }
      expect(registeredRunIds).toHaveLength(1);
      expect(cronRunExecSource.lookupCronRunExecSource(registeredRunIds[0])).toBeUndefined();
    },
  );
});
