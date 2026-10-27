import { describe, expect, it } from "vitest";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as harness from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await harness.loadRunCronIsolatedAgentTurn();
const runtimeAuthority = {
  version: 1,
  runtimeId: "codex",
  namespace: "codex.apps",
  payload: { version: 1 },
};
const runJob = (job: Record<string, unknown>) =>
  runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({ job: makeIsolatedAgentJobFixture(job) }),
  );
describe("runCronIsolatedAgentTurn — payload.fallbacks", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("forwards reauthorization recovery after an explicit tools cap clears app authority", async () => {
    harness.mockRunCronFallbackPassthrough();
    harness.resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");

    const result = await runJob({
      runtimeAuthorityRecoveryRequired: true,
      payload: { kind: "agentTurn", message: "use calendar", toolsAllow: ["read"] },
    });

    expect(result.status).toBe("ok");
    expect(harness.runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledRuntimeAuthorityRecoveryRequired: true }),
    );
  });

  it.each([
    { name: "a different embedded runtime", runtime: "openclaw", cli: false },
    { name: "a CLI execution path", runtime: "codex", cli: true },
  ])("fails closed before executing stored Codex authority on $name", async ({ runtime, cli }) => {
    harness.mockRunCronFallbackPassthrough();
    harness.resolveEffectiveAgentRuntimeMock.mockReturnValue(runtime);
    harness.isCliProviderMock.mockReturnValue(cli);

    const result = await runJob({ runtimeAuthority });

    expect(result.status).toBe("error");
    expect(result.error).toContain("authority captured for the codex runtime");
    expect(harness.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(harness.runCliAgentMock).not.toHaveBeenCalled();
  });

  it("does not persist an authority-incompatible fallback on the run continuation", async () => {
    harness.resolveEffectiveAgentRuntimeMock.mockImplementation(
      ({ provider }: { provider: string }) => (provider === "openai" ? "codex" : "openclaw"),
    );
    harness.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("primary failed"));
    harness.runWithModelFallbackMock.mockImplementation(
      async (params: TestModelFallbackRunnerParams) => {
        await expect(runInitialModelFallbackAttempt(params)).rejects.toThrow("primary failed");
        return await runFallbackModelAttempt(params, "anthropic", "claude-sonnet-4-6", "unknown");
      },
    );

    const result = await runJob({ runtimeAuthority });

    expect(result.status).toBe("error");
    expect(result.error).toContain("authority captured for the codex runtime");
    const persistedRunRows = await Promise.all(
      harness.patchSessionEntryMock.mock.calls.flatMap((call, index) => {
        const scope = call[0] as { sessionKey?: string };
        const callResult = harness.patchSessionEntryMock.mock.results[index];
        return scope.sessionKey?.includes(":run:") && callResult?.type === "return"
          ? [callResult.value]
          : [];
      }),
    );
    expect(persistedRunRows).not.toHaveLength(0);
    for (const persistedRunRow of persistedRunRows) {
      expect(persistedRunRow).toMatchObject({ modelProvider: "openai", model: "gpt-5.4" });
    }
  });

  it("uses default subagent fallbacks ahead of a named agent's primary through the run path", async () => {
    harness.mockRunCronFallbackPassthrough();
    const research = {
      model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-5.4"] },
    };
    harness.resolveAgentConfigMock.mockReturnValue(research);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "research",
        cfg: {
          agents: {
            defaults: {
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: ["openai/gpt-5.2", "zai/glm-5"],
                },
              },
            },
            entries: { research },
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(harness.runWithModelFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      fallbacksOverride: ["openai/gpt-5.2", "zai/glm-5"],
    });
    expect(harness.runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      modelFallbacksOverride: ["openai/gpt-5.2", "zai/glm-5"],
    });
  });
});
