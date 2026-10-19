import { describe, expect, it } from "vitest";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resolveAgentConfigMock,
  resolveEffectiveAgentRuntimeMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

// Payload fallback tests cover fallback prompt payloads for isolated cron runs.

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function requireModelFallbackRequest(): {
  fallbacksOverride?: string[];
  provider?: string;
  model?: string;
} {
  const request = runWithModelFallbackMock.mock.calls[0]?.[0] as
    | {
        fallbacksOverride?: string[];
        provider?: string;
        model?: string;
      }
    | undefined;
  if (!request) {
    throw new Error("Expected model fallback request");
  }
  return request;
}
describe("runCronIsolatedAgentTurn — payload.fallbacks", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("forwards reauthorization recovery after an explicit tools cap clears app authority", async () => {
    mockRunCronFallbackPassthrough();
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          runtimeAuthorityRecoveryRequired: true,
          payload: { kind: "agentTurn", message: "use calendar", toolsAllow: ["read"] },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledRuntimeAuthorityRecoveryRequired: true }),
    );
  });

  it.each([
    { name: "a different embedded runtime", runtime: "openclaw", cli: false },
    { name: "a CLI execution path", runtime: "codex", cli: true },
  ])("fails closed before executing stored Codex authority on $name", async ({ runtime, cli }) => {
    mockRunCronFallbackPassthrough();
    resolveEffectiveAgentRuntimeMock.mockReturnValue(runtime);
    isCliProviderMock.mockReturnValue(cli);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          runtimeAuthority: {
            version: 1,
            runtimeId: "codex",
            namespace: "codex.apps",
            payload: { version: 1 },
          },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("authority captured for the codex runtime");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("does not persist an authority-incompatible fallback on the run continuation", async () => {
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ provider }: { provider: string }) =>
      provider === "openai" ? "codex" : "openclaw",
    );
    runEmbeddedAgentMock.mockRejectedValueOnce(new Error("primary failed"));
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await expect(runInitialModelFallbackAttempt(params)).rejects.toThrow("primary failed");
      return await runFallbackModelAttempt(params, "anthropic", "claude-sonnet-4-6", "unknown");
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          runtimeAuthority: {
            version: 1,
            runtimeId: "codex",
            namespace: "codex.apps",
            payload: { version: 1 },
          },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("authority captured for the codex runtime");
    const persistedRunRows = await Promise.all(
      patchSessionEntryMock.mock.calls.flatMap((call, index) => {
        const scope = call[0] as { sessionKey?: string };
        const callResult = patchSessionEntryMock.mock.results[index];
        return scope.sessionKey?.includes(":run:") && callResult?.type === "return"
          ? [callResult.value]
          : [];
      }),
    );
    expect(persistedRunRows).not.toHaveLength(0);
    for (const persistedRunRow of persistedRunRows) {
      expect(persistedRunRow).toEqual(
        expect.objectContaining({ modelProvider: "openai", model: "gpt-5.4" }),
      );
    }
  });

  it("uses default subagent fallbacks ahead of a named agent's primary through the run path", async () => {
    mockRunCronFallbackPassthrough();
    resolveAgentConfigMock.mockReturnValue({
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5.4"],
      },
    });

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
            entries: {
              research: {
                model: {
                  primary: "anthropic/claude-opus-4-6",
                  fallbacks: ["openai/gpt-5.4"],
                },
              },
            },
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(requireModelFallbackRequest().fallbacksOverride).toEqual([
      "openai/gpt-5.2",
      "zai/glm-5",
    ]);
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      modelFallbacksOverride: ["openai/gpt-5.2", "zai/glm-5"],
    });
  });
});
