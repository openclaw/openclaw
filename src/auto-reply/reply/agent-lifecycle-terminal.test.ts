import { describe, expect, it, vi } from "vitest";
import { OAuthRefreshFailureError } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { FailoverError } from "../../agents/failover-error.js";
import { AUTH_PROFILE_COOLDOWN_ERROR_CODE } from "../../agents/failover/error.js";
import { runWithAgentWorkspaceReadiness } from "../../agents/workspace-readiness.js";
import * as providerFailover from "../../plugins/provider-failover.js";
import { createAgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }));

vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent }));

describe("createAgentLifecycleTerminalBackstop", () => {
  it("publishes a preparation failure once instead of its cancellation side effect", async () => {
    emitAgentEvent.mockClear();
    const preparation: { failure?: Error } = {};
    const terminal = await runWithAgentWorkspaceReadiness(
      {
        sessionKey: "agent:main:preparing",
        waitUntilReady: async () => {},
        assertCurrent: () => {},
        getFailure: () => preparation.failure,
      },
      async () =>
        createAgentLifecycleTerminalBackstop({
          runId: "preparing",
          sessionKey: "agent:main:preparing",
          getLifecycleGeneration: () => "generation",
          resolveTerminationFields: () => ({ aborted: true, stopReason: "aborted" }),
        }),
    );
    const failure = new Error("Checkout failed; retry this session.");
    preparation.failure = failure;
    terminal.note({
      stream: "lifecycle",
      data: { phase: "finishing", aborted: true, stopReason: "aborted" },
    });
    terminal.capture("end", {}, { aborted: true, stopReason: "aborted" });
    terminal.emit("end", {});
    terminal.emit("error", failure);
    expect(emitAgentEvent).toHaveBeenCalledOnce();
    const data = emitAgentEvent.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      phase: "error",
      error: failure.message,
      executionSettled: true,
    });
    expect(data).not.toHaveProperty("aborted");
    expect(data).not.toHaveProperty("stopReason");
  });

  it.each([false, true])("keeps only the selected attempt receipt (retry=%s)", (retry) => {
    emitAgentEvent.mockClear();
    const terminal = createAgentLifecycleTerminalBackstop({
      runId: "run",
      getLifecycleGeneration: () => "generation",
      resolveTerminationFields: () => ({}),
    });
    terminal.note({
      stream: "lifecycle",
      data: {
        phase: "finishing",
        error: "first failure",
        assistantTranscriptIdempotencyKey: "saved-A",
      },
    });
    terminal.capture("error", new Error("first failure"));
    expect(emitAgentEvent).not.toHaveBeenCalled();
    if (retry) {
      // Preparation fails before the next lifecycle start can be emitted.
      terminal.beginAttempt();
    }
    terminal.emit("error", new Error(retry ? "preparation failed" : "first failure"));
    expect(emitAgentEvent).toHaveBeenCalledOnce();
    const data = emitAgentEvent.mock.calls[0]?.[0]?.data;
    expect(data.assistantTranscriptIdempotencyKey).toBe(retry ? undefined : "saved-A");
    expect(data.error).toBe(retry ? "preparation failed" : "first failure");
    expect(data.executionSettled).toBe(true);
  });

  it("publishes the provider-owned OAuth summary instead of the wrapped diagnostic", () => {
    emitAgentEvent.mockClear();
    const summary =
      "Your refresh token has already been used to generate a new access token. Please try signing in again.";
    const rawDiagnostic = `OAuth token refresh failed for openai: {"error":{"message":"${summary}"}}`;
    const oauthError = new OAuthRefreshFailureError({
      provider: "openai",
      message: rawDiagnostic,
      errorType: "invalid_request_error",
      reason: "refresh_token_reused",
      status: 401,
      summary,
    });
    const error = new Error("wrapped OAuth refresh failure", { cause: oauthError });
    const terminal = createAgentLifecycleTerminalBackstop({
      runId: "oauth-refresh-failure",
      getLifecycleGeneration: () => "test-generation",
      resolveTerminationFields: () => ({}),
    });

    terminal.emit("error", error);

    const event = emitAgentEvent.mock.calls[0]?.[0];
    expect(event.data.error).toBe(`⚠️ ${summary}`);
    expect(event.data.errorObservation).toEqual({
      provider: "openai",
      failoverReason: "refresh_token_reused",
      providerRuntimeFailureKind: "auth_refresh",
      providerErrorType: "invalid_request_error",
      httpStatus: 401,
    });
    expect(JSON.stringify(event)).not.toContain(rawDiagnostic);
  });

  it.each(
    (["typed", "raw"] as const).flatMap((kind) => [
      {
        kind,
        code: "selected_auth_profile_unavailable",
        expected:
          "This saved login isn't available. Choose another login under Models in the Control UI or run `openclaw configure`.",
      },
      {
        kind,
        code: AUTH_PROFILE_COOLDOWN_ERROR_CODE,
        expected: "⚠️ The AI service needs a short break. Please try again in a few minutes.",
      },
    ]),
  )(
    "publishes bounded $code recovery from $kind failures without discovering providers",
    ({ kind, code, expected }) => {
      const classifyProvider = vi
        .spyOn(providerFailover, "classifyProviderFailoverSignalWithPlugin")
        .mockImplementation(() => {
          throw new Error("Terminal presentation must not discover providers");
        });
      emitAgentEvent.mockClear();
      try {
        const profileId = "openai:private-profile";
        const rawCause = `Codex app-server auth profile "${profileId}" was not found`;
        const terminal = createAgentLifecycleTerminalBackstop({
          runId: "missing-selected-profile",
          sessionKey: "agent:main:test",
          getLifecycleGeneration: () => "test-generation",
          resolveTerminationFields: () => ({}),
        });

        const error =
          kind === "typed"
            ? new FailoverError(rawCause, {
                reason: "auth",
                code,
                profileId,
                cause: new Error(rawCause),
              })
            : Object.assign(new Error(rawCause), {
                code,
              });
        terminal.emit("error", error);

        const event = emitAgentEvent.mock.calls[0]?.[0];
        expect(event.data.error).toBe(expected);
        expect(JSON.stringify(event)).not.toContain(profileId);
        expect(JSON.stringify(event)).not.toContain(rawCause);
        expect(classifyProvider).not.toHaveBeenCalled();
      } finally {
        classifyProvider.mockRestore();
      }
    },
  );
});
