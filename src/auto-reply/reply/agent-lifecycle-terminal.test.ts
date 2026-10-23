import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthRefreshFailureError } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { FailoverError } from "../../agents/failover-error.js";
import { AUTH_PROFILE_COOLDOWN_ERROR_CODE } from "../../agents/failover/error.js";
import { runWithAgentWorkspaceReadiness } from "../../agents/workspace-readiness.js";
import { decodePostgresError } from "../../infra/postgres-sync/protocol.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as providerFailover from "../../plugins/provider-failover.js";
import { createAgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }));

vi.mock("../../infra/agent-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-events.js")>()),
  emitAgentEvent,
}));

describe("createAgentLifecycleTerminalBackstop", () => {
  beforeEach(() => emitAgentEvent.mockClear());

  function createTerminal(
    overrides: Partial<Parameters<typeof createAgentLifecycleTerminalBackstop>[0]> = {},
  ) {
    return createAgentLifecycleTerminalBackstop({
      runId: "run",
      getLifecycleGeneration: () => "generation",
      resolveTerminationFields: () => ({}),
      ...overrides,
    });
  }

  it.each([
    {
      code: "unavailable",
      failure: new SqliteWorkerError("PRIVATE_ROLLBACK", "unavailable"),
    },
    {
      code: "session_actor_reconciliation",
      failure: new SqliteWorkerError("PRIVATE_UNCERTAIN_WRITE", "outcome-unknown"),
    },
    {
      code: "57014",
      failure: decodePostgresError({
        name: "error",
        code: "57014",
        message: "PRIVATE_CANCELLED_QUERY",
      }),
    },
  ])("renders $code before terminal events flatten the failure", ({ code, failure }) => {
    const wrapped = new Error("PRIVATE_LIFECYCLE_FAILURE", { cause: failure });
    expect(classifyGatewayStorageFailure(wrapped)).toBe(code);
    const terminal = createTerminal();
    terminal.capture("error", wrapped);
    terminal.emit("error", wrapped);
    expect(emitAgentEvent).toHaveBeenCalledOnce();
    const event = emitAgentEvent.mock.calls[0]?.[0];
    expect(event.data).toMatchObject({ phase: "error", executionSettled: true });
    expect(event.data.error).toMatch(/check|reopen|retry/i);
    expect(event.data.error).toMatch(code === "57014" ? /cancel|timeout/i : /confirm|saved/i);
    expect(event.data.error).not.toContain("PRIVATE_");
  });

  it("publishes a preparation failure once instead of its cancellation side effect", async () => {
    const preparation: { failure?: Error } = {};
    const terminal = await runWithAgentWorkspaceReadiness(
      {
        sessionKey: "agent:main:preparing",
        waitUntilReady: async () => {},
        assertCurrent: () => {},
        getFailure: () => preparation.failure,
      },
      async () =>
        createTerminal({
          runId: "preparing",
          sessionKey: "agent:main:preparing",
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
    expect(data).toMatchObject({ phase: "error", error: failure.message, executionSettled: true });
    expect(data).not.toHaveProperty("aborted");
    expect(data).not.toHaveProperty("stopReason");
  });

  it.each([false, true])("keeps only the selected attempt receipt (retry=%s)", (retry) => {
    const terminal = createTerminal();
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

  it.each([false, true])("replaces pending or captured attempt facts (captured=%s)", (captured) => {
    const terminal = createTerminal({ runId: "recovered", startedAt: 100 });
    terminal.note({
      stream: "lifecycle",
      data: {
        phase: "finishing",
        error: "old capacity error",
        stopReason: "error",
        errorObservation: { httpStatus: 503 },
        timeoutPhase: "provider",
        providerStarted: true,
        aborted: true,
        livenessState: "blocked",
        replayInvalid: true,
        suppressErrorNotice: true,
        assistantTranscriptIdempotencyKey: "old-receipt",
      },
    });
    if (captured) {
      terminal.capture("error", new Error("old capacity error"));
    }
    terminal.replaceAttemptTerminal();
    expect(terminal.getDeferredError()).toBeUndefined();
    terminal.emit("end", {
      meta: { stopReason: "stop", assistantTranscriptIdempotencyKey: "selected" },
    });
    terminal.replaceAttemptTerminal();
    terminal.emit("error", new Error("must not reopen"));
    expect(emitAgentEvent).toHaveBeenCalledOnce();
    const event = emitAgentEvent.mock.calls[0]?.[0];
    assert.isDefined(event);
    expect(event.data).toEqual({
      phase: "end",
      startedAt: 100,
      endedAt: expect.any(Number),
      stopReason: "stop",
      assistantTranscriptIdempotencyKey: "selected",
      executionSettled: true,
    });
  });

  it("publishes the provider-owned OAuth summary instead of the wrapped diagnostic", () => {
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
    const terminal = createTerminal({
      runId: "oauth-refresh-failure",
      getLifecycleGeneration: () => "test-generation",
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
      [
        kind,
        "selected_auth_profile_unavailable",
        "This saved login isn't available. Choose another login under Models in the Control UI or run `openclaw configure`.",
      ],
      [
        kind,
        AUTH_PROFILE_COOLDOWN_ERROR_CODE,
        "⚠️ The AI service needs a short break. Please try again in a few minutes.",
      ],
    ]),
  )("sanitizes %s auth failure %s without provider discovery", (kind, code, expected) => {
    const classifyProvider = vi
      .spyOn(providerFailover, "classifyProviderFailoverSignalWithPlugin")
      .mockImplementation(() => {
        throw new Error("Terminal presentation must not discover providers");
      });
    try {
      const profileId = "openai:private-profile";
      const rawCause = `Codex app-server auth profile "${profileId}" was not found`;
      const terminal = createTerminal({
        runId: "missing-selected-profile",
        sessionKey: "agent:main:test",
        getLifecycleGeneration: () => "test-generation",
      });

      const error =
        kind === "typed"
          ? new FailoverError(rawCause, {
              reason: "auth",
              code,
              profileId,
              cause: new Error(rawCause),
            })
          : Object.assign(new Error(rawCause), { code });
      terminal.emit("error", error);

      const event = emitAgentEvent.mock.calls[0]?.[0];
      expect(event.data.error).toBe(expected);
      expect(JSON.stringify(event)).not.toContain(profileId);
      expect(JSON.stringify(event)).not.toContain(rawCause);
      expect(classifyProvider).not.toHaveBeenCalled();
    } finally {
      classifyProvider.mockRestore();
    }
  });
});
