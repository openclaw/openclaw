import { describe, expect, it } from "vitest";
import { coerceToFailoverError, FailoverError } from "../../agents/failover-error.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../../agents/failover/user-copy.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { SkillResourceDeliveryLimitError } from "../../skills/runtime/resource-delivery-error.js";
import { SkillLibraryError } from "../../skills/skill-library-error.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildEmptyInteractiveReplyPayload,
  buildExternalRunFailureReply,
  buildKnownAgentRunFailureReplyPayload,
} from "./agent-runner-failure-reply.js";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";

describe("buildEmptyInteractiveReplyPayload", () => {
  it("surfaces missing output for a mentioned group request even when silence is allowed", () => {
    const expectation = resolveSourceReplyExpectation({
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "group",
        InboundEventKind: "user_request",
        WasMentioned: true,
      },
      cfg: { agents: { defaults: { silentReply: { group: "allow" } } } },
    });
    const payload = buildEmptyInteractiveReplyPayload({
      completion: resolveReplyCompletion(expectation, "empty"),
    });

    expect(payload?.isError).toBe(true);
    expect(payload?.text).not.toBe(SILENT_REPLY_TOKEN);
    expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it.each([
    resolveReplyCompletion("optional", "empty"),
    ...(["ready", "delivered", "pending", "blocked"] as const).map((evidence) =>
      resolveReplyCompletion("required", evidence),
    ),
  ])("does not add an error for $expectation/$outcome", (completion) => {
    expect(buildEmptyInteractiveReplyPayload({ completion })).toBeUndefined();
  });
});

describe("buildExternalRunFailureReply", () => {
  it.each([
    ["thread not loaded: synthetic-thread", "Conversation context is unavailable."],
    [
      "managed worktree allocation lease core:managed-worktrees:create/capacity was lost",
      "Workspace preparation was interrupted.",
    ],
  ])("delivers startup recovery guidance without diagnostic identifiers: %s", (message, title) => {
    const reply = buildExternalRunFailureReply({ message, error: new Error(message) });
    expect(reply.isGenericRunnerFailure).toBe(false);
    expect(reply.text).toContain(title);
    expect(reply.text).toContain("Refresh");
    expect(reply.text).not.toContain("synthetic-thread");
    expect(reply.text).not.toContain("lease");
  });

  it.each(["direct", "wrapped"])(
    "keeps %s skill delivery-limit guidance visible without diagnostics",
    (kind) => {
      const limit = new SkillResourceDeliveryLimitError();
      const error =
        kind === "direct" ? limit : new Error("private-diagnostic-canary", { cause: limit });
      const reply = buildExternalRunFailureReply({ message: error.message, error });
      expect(reply).toEqual({
        text: "⚠️ Selected skill resources exceed the 8 MiB delivery limit. Select fewer skills, then try again.",
        isGenericRunnerFailure: false,
      });
      expect(
        buildKnownAgentRunFailureReplyPayload({
          err: error,
          sessionCtx: { Provider: "webchat", Surface: "webchat", ChatType: "direct" },
          resolvedVerboseLevel: "off",
        }),
      ).toMatchObject({ text: reply.text, isError: true });
    },
  );

  it.each([
    new Error(new SkillResourceDeliveryLimitError().message),
    Object.assign(new Error("private-diagnostic-canary"), {
      name: "SkillResourceDeliveryLimitError",
    }),
    new SkillLibraryError("LIMIT", "private-skill-path-canary"),
    new SkillLibraryError("INVALID_BUNDLE", "private-skill-path-canary"),
  ])("does not expose untyped or unrelated skill failures: %s", (error) => {
    expect(buildExternalRunFailureReply({ message: error.message, error })).toEqual({
      text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      isGenericRunnerFailure: true,
    });
  });

  it("does not expose a foreign error's userMessage property", () => {
    const error = Object.assign(new Error("private-diagnostic-canary"), {
      userMessage: "untrusted-public-canary",
    });
    expect(buildExternalRunFailureReply({ message: error.message, error })).toEqual({
      text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      isGenericRunnerFailure: true,
    });
  });

  it("does not treat an embedded Codex disconnect phrase as curated recovery", () => {
    const message =
      "provider detail quoted: Codex execution node disconnected; start a fresh attempt. (execution node failed)";
    expect(buildExternalRunFailureReply({ message, error: new Error(message) })).toEqual({
      text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      isGenericRunnerFailure: true,
    });
  });

  it("uses typed runtime guidance without exposing the private diagnostic", () => {
    const error = Object.assign(new Error("private runtime diagnostic"), {
      code: "codex_node_disconnected",
      name: "CodexNodeExecServerDisconnectedError",
    });
    expect(buildExternalRunFailureReply({ message: error.message, error })).toEqual({
      text: "⚠️ Codex execution node disconnected. Start a fresh attempt.",
      isGenericRunnerFailure: false,
    });
  });

  it.each(["runner-offline", "node_runner_update_required", "codex_node_disconnected"])(
    "does not trust provider code %s as runtime coordination provenance",
    (code) => {
      const error = new FailoverError("private provider diagnostic", {
        code,
        provider: "private-provider",
        reason: "server_error",
        status: 500,
      });
      expect(buildExternalRunFailureReply({ message: error.message, error })).toEqual({
        text: "⚠️ The AI service is having trouble. Please try again in a moment.",
        isGenericRunnerFailure: false,
      });
    },
  );

  it("retains the actual provider rejection when verbose output is off", () => {
    const message = "The AI service could not accept this request";
    const error = new FailoverError(message, {
      reason: "format",
      rawError: "Invalid service_tier argument",
    });
    expect(buildExternalRunFailureReply({ message, error })).toEqual({
      text: String.raw`LLM request rejected: Invalid service\_tier argument`,
      isGenericRunnerFailure: false,
    });
  });

  it("uses preserved format diagnostics without exposing raw details", () => {
    const message = "safe summary";
    const error = new FailoverError(message, {
      reason: "format",
      rawError: "Invalid session transcript entry: message PRIVATE_CANARY",
    });

    const reply = buildExternalRunFailureReply({ message, error });
    expect(reply.isGenericRunnerFailure).toBe(false);
    expect(reply.text).not.toContain("PRIVATE_CANARY");
  });

  it("includes heartbeat preflight reasons without verbose opt-in", () => {
    const message =
      "Codex session became active in another runner; wait for it to finish before continuing";
    const reply = buildExternalRunFailureReply(
      { message, error: new AgentHarnessPreflightError(message) },
      { isHeartbeat: true },
    );

    expect(reply.text).toContain(`\n\nDetails: ${message}.\n`);
    expect(reply.isGenericRunnerFailure).toBe(false);
    expect(reply.text).not.toContain("/new");
  });

  it.each(["401 unauthorized", "529 overloaded"])(
    "keeps preflight %s diagnostics verbose-gated except for heartbeats",
    (failure) => {
      const message = `${failure}; reconnect before continuing. diagnostic-canary ${"x".repeat(1500)}`;
      const input = {
        message,
        error: new AgentHarnessPreflightError(message, {
          cause: new FailoverError("provider diagnostic", {
            reason: failure.startsWith("401") ? "auth" : "overloaded",
            status: failure.startsWith("401") ? 401 : 529,
          }),
        }),
      };
      expect(
        buildKnownAgentRunFailureReplyPayload({
          err: input.error,
          sessionCtx: { Provider: "discord", Surface: "discord", ChatType: "group" },
          resolvedVerboseLevel: "off",
        }),
      ).toBeUndefined();
      expect(buildExternalRunFailureReply(input)).toEqual({
        text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
        isGenericRunnerFailure: true,
      });
      const heartbeat = buildExternalRunFailureReply(input, {
        isHeartbeat: true,
        includeDetails: true,
      });
      expect(heartbeat.isGenericRunnerFailure).toBe(false);
      expect(heartbeat.text).not.toContain("x".repeat(1500));
      expect(heartbeat.text).toContain("reconnect before continuing");
      expect(heartbeat.text).toContain("diagnostic-canary");
      expect(heartbeat.text).not.toContain("/new");
      const verbose = buildExternalRunFailureReply(input, { includeDetails: true });
      expect(verbose.isGenericRunnerFailure).toBe(true);
      expect(verbose.text).toContain("reconnect before continuing");
      expect(verbose.text).toContain("diagnostic-canary");
      expect(verbose.text).not.toContain("x".repeat(1500));
    },
  );

  it("keeps raw heartbeat failure details behind verbose opt-in", () => {
    const message = "Gateway SDK resource host is not bound";
    const input = { message, error: new Error(message) };
    expect(buildExternalRunFailureReply(input, { isHeartbeat: true })).toEqual({
      text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
      isGenericRunnerFailure: false,
    });
    const verbose = buildExternalRunFailureReply(input, {
      isHeartbeat: true,
      includeDetails: true,
    });
    expect(verbose.text).toContain(`\n\nDetails: ${message}.\n`);
    expect(verbose.text).not.toContain("/new");
    expect(verbose.isGenericRunnerFailure).toBe(false);
  });

  it("points unclassified failures to logs without exposing raw detail", () => {
    const message = "opaque-private-provider-detail";
    const reply = buildExternalRunFailureReply(
      {
        message,
        error: new FailoverError(message, {
          reason: "unclassified",
          provider: "openai",
          model: "test-model",
        }),
      },
      { includeDetails: false },
    );

    expect(reply.isGenericRunnerFailure).toBe(false);
    expect(reply.text).toContain("openclaw logs --follow");
    expect(reply.text).not.toContain(message);
  });

  it.each([
    {
      name: "provider overload",
      makeError: () =>
        new FailoverError("opaque provider response with secret-canary", {
          reason: "overloaded",
          provider: "openai",
          model: "test-model",
        }),
      localWorker: false,
    },
    {
      name: "local request timeout with a synthesized status",
      makeError: () => new Error("LLM request timed out."),
      localWorker: false,
    },
    {
      name: "typed local worker timeout",
      makeError: () => new WorkerTaskError("worker task timed out: secret-canary", "timeout"),
      localWorker: true,
    },
    {
      name: "wrapped local worker timeout",
      makeError: () =>
        new Error("preparation failed: secret-canary", {
          cause: new WorkerTaskError("worker task timed out", "timeout"),
        }),
      localWorker: true,
    },
    {
      name: "actual provider HTTP timeout with a local diagnostic cause",
      makeError: () =>
        Object.assign(
          new Error("worker task timed out: secret-canary", {
            cause: new WorkerTaskError("worker task timed out", "timeout"),
          }),
          { status: 408 },
        ),
      localWorker: false,
    },
    {
      name: "untyped matching timeout text",
      makeError: () => new Error("worker task timed out"),
      localWorker: false,
    },
    {
      name: "non-timeout worker failure with matching text",
      makeError: () => new WorkerTaskError("worker task timed out", "failed"),
      localWorker: false,
    },
  ])("preserves failure origin for $name", ({ makeError, localWorker }) => {
    const error = coerceToFailoverError(makeError(), { provider: "openai", model: "test-model" });
    if (!error) {
      throw new Error("Expected the existing failover classifier to recognize the fixture");
    }
    const reply = buildExternalRunFailureReply(
      { message: error.message, error },
      { includeDetails: false },
    );
    expect(reply.isGenericRunnerFailure).toBe(false);
    expect(reply.text).not.toContain("secret-canary");
    if (localWorker) {
      expect(reply.text).toMatch(/local worker/i);
      expect(reply.text).not.toMatch(/HTTP|openai\/test-model|context preparation/);
    } else if (error.reason === "timeout") {
      expect(reply.text).toBe(
        "⚠️ The request took too long. Check the conversation for any completed work before trying again.",
      );
      expect(error).toMatchObject({
        reason: "timeout",
        status: 408,
        provider: "openai",
        model: "test-model",
      });
    } else {
      expect(reply.text).toContain("AI service is busy");
      expect(reply.text).not.toMatch(/local worker/i);
    }
  });

  it("uses generic copy when useHeartbeatFailureCopy is false even if isHeartbeat is true", () => {
    const reply = buildExternalRunFailureReply(
      { message: "test error", error: new Error("test") },
      { isHeartbeat: true, useHeartbeatFailureCopy: false },
    );
    expect(reply.text).toBe(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
    expect(reply.isGenericRunnerFailure).toBe(false);
  });

  it("uses heartbeat copy when useHeartbeatFailureCopy is true", () => {
    const reply = buildExternalRunFailureReply(
      { message: "test error", error: new Error("test") },
      { isHeartbeat: true, useHeartbeatFailureCopy: true },
    );
    expect(reply.text).toBe(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT);
  });

  it("falls back to isHeartbeat when useHeartbeatFailureCopy is undefined", () => {
    const reply = buildExternalRunFailureReply(
      { message: "test error", error: new Error("test") },
      { isHeartbeat: true },
    );
    expect(reply.text).toBe(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT);
  });
});

describe("buildKnownAgentRunFailureReplyPayload", () => {
  const promptSizeGuidance =
    "⚠️ The provider rejected this request because the prompt exceeds its per-request limit. Shorten the prompt and try again, or choose a model with a larger limit.";
  const sessionCtx = {
    Provider: "discord",
    Surface: "discord",
    ChatType: "direct",
  } as unknown as TemplateContext;

  it.each([
    { rawError: "Connection error. private-canary", code: undefined },
    { rawError: "private-canary", code: "ECONNREFUSED" },
    { rawError: "getaddrinfo ENOTFOUND private-canary", code: undefined },
  ])("preserves transport guidance in a terminal timeout-bucket reply: %j", (facts) => {
    const error = new FailoverError("Sanitized provider failure", {
      ...facts,
      reason: "timeout",
      status: 408,
      provider: "external",
      model: "local-model",
    });
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: error,
      sessionCtx,
      resolvedVerboseLevel: "off",
    });

    expect(payload?.isError).toBe(true);
    expect(payload?.text).toContain("Couldn't connect to the AI service.");
    expect(payload?.text).toContain(
      "Check the conversation for any completed work before trying again.",
    );
    expect(payload?.text).not.toMatch(/took too long|private-canary|Sanitized provider failure/);
  });

  it("keeps HTTP server failures ahead of connection wording in provider details", () => {
    const error = new FailoverError("503 connection error: private-canary", {
      reason: "timeout",
      status: 503,
    });
    expect(
      buildKnownAgentRunFailureReplyPayload({
        err: error,
        sessionCtx,
        resolvedVerboseLevel: "off",
      })?.text,
    ).toBe(
      "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.",
    );
  });

  it("puts sanitized HTTP 400 prompt-size guidance in the terminal reply payload", () => {
    const raw = `400 ${JSON.stringify({
      error: {
        type: "invalid_request_error",
        message:
          "This prompt is longer than the free tier allows for a single request. Shorten it, or add credits to use this model without the free-tier cap.",
      },
      request_id: "req_prompt_size_canary",
    })}`;
    const error = new FailoverError(raw, {
      reason: "rate_limit",
      provider: "openai",
      model: "test-model",
      status: 400,
      rawError: raw,
    });

    const payload = buildKnownAgentRunFailureReplyPayload({
      err: error,
      sessionCtx,
      resolvedVerboseLevel: "off",
    });

    expect(payload?.isError).toBe(true);
    expect(payload?.text).toBe(promptSizeGuidance);
    expect(payload?.text).not.toContain("req_prompt_size_canary");
    expect(payload?.text).not.toContain("add credits");
  });

  it("keeps HTTP 429 throttle failures on the existing retry guidance", () => {
    const raw = "429 rate limit: service overloaded, try again in 30 seconds";
    const error = new FailoverError(raw, {
      reason: "rate_limit",
      provider: "anthropic",
      model: "test-model",
      status: 429,
      rawError: raw,
    });

    const payload = buildKnownAgentRunFailureReplyPayload({
      err: error,
      sessionCtx,
      resolvedVerboseLevel: "off",
    });

    expect(payload?.text).toBe(
      "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    );
  });
});
