import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  pickLastNonEmptyTextFromPayloadsMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveSessionAuthSelectionMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const requireRecord = createRequireRecord("record", "expected-non-array-record");

function makeRunResult(provider: string, model: string) {
  return {
    payloads: [{ text: "done" }],
    meta: { agentMeta: { model, provider, usage: { input: 10, output: 5 } } },
  };
}

function requireEmbeddedAgentCall(index: number): Record<string, unknown> {
  return requireRecord(runEmbeddedAgentMock.mock.calls[index]?.[0]);
}

describe("runCronIsolatedAgentTurn — fallback auth pin scope", () => {
  setupRunCronIsolatedAgentTurnSuite();

  beforeEach(() => {
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, model] = raw.split("/");
      return { ref: { provider, model } };
    });
  });

  it("keeps the session auth pin off a fallback candidate of another provider", async () => {
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "anthropic:work",
      source: "user",
      routeRequirement: undefined,
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          authProfileOverride: "anthropic:work",
          authProfileOverrideSource: "user",
        }),
        isNewSession: true,
      }),
    );
    runEmbeddedAgentMock
      .mockResolvedValueOnce(makeRunResult("anthropic", "claude-sonnet-4-6"))
      .mockResolvedValueOnce(makeRunResult("anthropic", "claude-opus-4-7"))
      .mockResolvedValueOnce(makeRunResult("openai", "gpt-5.6-sol"));
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: TestModelFallbackRunnerParams) => {
        await runInitialModelFallbackAttempt(params);
        await runFallbackModelAttempt(params, "anthropic", "claude-opus-4-7", "rate_limit");
        const result = await runFallbackModelAttempt(params, "openai", "gpt-5.6-sol", "rate_limit");
        return { result, provider: "openai", model: "gpt-5.6-sol", attempts: [] };
      },
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          id: "fallback-auth-pin-job",
          payload: { kind: "agentTurn", message: "run task", model: "anthropic/claude-sonnet-4-6" },
        }),
        message: "run task",
        sessionKey: "cron:fallback-auth-pin",
      }),
    );

    expect(result.status).toBe("ok");
    for (const index of [0, 1]) {
      const call = requireEmbeddedAgentCall(index);
      expect(call.provider).toBe("anthropic");
      expect(call.authProfileId).toBe("anthropic:work");
      expect(call.authProfileIdSource).toBe("user");
    }
    const crossProvider = requireEmbeddedAgentCall(2);
    expect(crossProvider.provider).toBe("openai");
    expect(crossProvider.authProfileId).toBeUndefined();
    expect(crossProvider.authProfileIdSource).toBeUndefined();
  });

  it("keeps the pin scoped to its provider when an interim-ack retry starts on the fallback route", async () => {
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      (payloads?: Array<{ text?: string }>) =>
        payloads?.findLast((payload) => typeof payload.text === "string" && payload.text.trim())
          ?.text ?? "",
    );
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "anthropic:work",
      source: "user",
      routeRequirement: undefined,
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          authProfileOverride: "anthropic:work",
          authProfileOverrideSource: "user",
        }),
        isNewSession: true,
      }),
    );
    const interim = {
      payloads: [{ text: "On it, checking the report now." }],
      meta: { agentMeta: { usage: { input: 10, output: 5 } } },
    };
    runEmbeddedAgentMock
      .mockResolvedValueOnce(interim)
      .mockResolvedValueOnce(makeRunResult("openai", "gpt-5.6-sol"))
      .mockResolvedValueOnce(makeRunResult("anthropic", "claude-sonnet-4-6"));
    runWithModelFallbackMock
      .mockImplementationOnce(async (params: TestModelFallbackRunnerParams) => {
        const result = await runFallbackModelAttempt(params, "openai", "gpt-5.6-sol", "rate_limit");
        return { result, provider: "openai", model: "gpt-5.6-sol", attempts: [] };
      })
      .mockImplementationOnce(async (params: TestModelFallbackRunnerParams) => {
        await runInitialModelFallbackAttempt(params);
        const result = await runFallbackModelAttempt(
          params,
          "anthropic",
          "claude-sonnet-4-6",
          "rate_limit",
        );
        return { result, provider: "anthropic", model: "claude-sonnet-4-6", attempts: [] };
      });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          id: "fallback-auth-pin-interim-job",
          payload: { kind: "agentTurn", message: "run task", model: "anthropic/claude-sonnet-4-6" },
        }),
        message: "run task",
        sessionKey: "cron:fallback-auth-pin-interim",
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    expect(requireRecord(runWithModelFallbackMock.mock.calls[1]?.[0]).provider).toBe("openai");
    for (const index of [0, 1]) {
      const call = requireEmbeddedAgentCall(index);
      expect(call.provider).toBe("openai");
      expect(call.authProfileId).toBeUndefined();
    }
    const backOnPinProvider = requireEmbeddedAgentCall(2);
    expect(backOnPinProvider.provider).toBe("anthropic");
    expect(backOnPinProvider.authProfileId).toBe("anthropic:work");
    expect(backOnPinProvider.authProfileIdSource).toBe("user");
  });
});
