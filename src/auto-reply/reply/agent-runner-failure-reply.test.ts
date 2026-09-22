import { describe, expect, it } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../../agents/failover/user-copy.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
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
  it("does not expose a foreign error's userMessage property", () => {
    const error = Object.assign(new Error("private-diagnostic-canary"), {
      userMessage: "untrusted-public-canary",
    });
    expect(buildExternalRunFailureReply({ message: error.message, error })).toEqual({
      text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      isGenericRunnerFailure: true,
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

    expect(reply.text).toContain(message);
    expect(reply.isGenericRunnerFailure).toBe(false);
    expect(reply.text).not.toContain("/new");
  });

  it.each(["401 unauthorized", "529 overloaded", "503 service unavailable", "402 billing"])(
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
    const input = { message: "boom-canary", error: new Error("boom-canary") };
    expect(buildExternalRunFailureReply(input, { isHeartbeat: true })).toEqual({
      text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
      isGenericRunnerFailure: false,
    });
    const verbose = buildExternalRunFailureReply(input, {
      isHeartbeat: true,
      includeDetails: true,
    });
    expect(verbose.text).toContain("boom-canary");
    expect(verbose.text).not.toContain("/new");
    expect(verbose.isGenericRunnerFailure).toBe(false);
  });

  it("keeps unclassified model context visible without exposing raw detail", () => {
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
    expect(reply.text).toContain("openai/test-model");
    expect(reply.text).not.toContain(message);
  });

  it("forwards classified provider copy when verbose detail is off", () => {
    const message = "opaque provider response with secret-canary";
    const reply = buildExternalRunFailureReply(
      {
        message,
        error: new FailoverError(message, {
          reason: "overloaded",
          provider: "openai",
          model: "test-model",
        }),
      },
      { includeDetails: false },
    );

    expect(reply.text).toContain("openai/test-model");
    expect(reply.text).not.toContain("secret-canary");
    expect(reply.text).not.toBe(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
    expect(reply.isGenericRunnerFailure).toBe(false);
  });
});
