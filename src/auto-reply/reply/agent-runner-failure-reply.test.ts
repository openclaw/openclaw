import { expect, it } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { AUTH_PROFILE_COOLDOWN_ERROR_CODE } from "../../agents/failover/error.js";
import { ContextPreparationTimeoutError } from "../../agents/failover/local-preparation-error.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { SkillResourceDeliveryLimitError } from "../../skills/runtime/resource-delivery-error.js";
import { SkillLibraryError } from "../../skills/skill-library-error.js";
import type { TemplateContext } from "../templating.js";
import {
  buildExternalRunFailureReply,
  buildKnownAgentRunFailureReplyPayload,
  buildPreflightCompactionFailureText,
} from "./agent-runner-failure-reply.js";

const genericFailure = { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isGenericRunnerFailure: true };
const directContext: TemplateContext = {
  Provider: "discord",
  Surface: "discord",
  ChatType: "direct",
};
const externalReply = (error: Error) =>
  buildExternalRunFailureReply({ message: error.message, error });
const knownReply = (err: unknown, sessionCtx: TemplateContext = directContext) =>
  buildKnownAgentRunFailureReplyPayload({ err, sessionCtx, resolvedVerboseLevel: "off" });

it("shows unshrinkable request guidance without verbose diagnostics", () => {
  const reason =
    "The estimated foreground request budget still exceeds the 32768-token model window " +
    "(fixed instructions and tools: 40000; pending input: 10; retained history: 20). " +
    "No further history compaction can make this request fit. Use /context detail to reduce fixed context, shorten the request, or select a larger-context model.";
  expect(
    buildPreflightCompactionFailureText(`Preflight compaction required but failed: ${reason}`),
  ).toBe(`⚠️ ${reason}`);
});

it("keeps wrapped skill delivery-limit guidance visible without diagnostics", () => {
  const limit = new SkillResourceDeliveryLimitError();
  const error = new Error("private-diagnostic-canary", { cause: limit });
  const reply = externalReply(error);
  expect(reply).toEqual({
    text: "⚠️ Selected skill resources exceed the 8 MiB delivery limit. Select fewer skills, then try again.",
    isGenericRunnerFailure: false,
  });
  expect(
    knownReply(error, { Provider: "webchat", Surface: "webchat", ChatType: "direct" }),
  ).toMatchObject({ text: reply.text, isError: true });
});

it.each([
  Object.assign(new Error("private-diagnostic-canary"), {
    name: "SkillResourceDeliveryLimitError",
  }),
  new SkillLibraryError("INVALID_BUNDLE", "private-skill-path-canary"),
  Object.assign(new Error("private-diagnostic-canary"), {
    userMessage: "untrusted-public-canary",
  }),
  new Error(
    "provider detail quoted: Codex execution node disconnected; start a fresh attempt. (execution node failed)",
  ),
])("does not expose untrusted skill, userMessage, or embedded recovery details: %s", (error) => {
  expect(externalReply(error)).toEqual(genericFailure);
});

it("uses typed runtime guidance without exposing the private diagnostic", () => {
  const error = Object.assign(new Error("private runtime diagnostic"), {
    code: "codex_node_disconnected",
    name: "CodexNodeExecServerDisconnectedError",
  });
  expect(externalReply(error)).toEqual({
    text: "⚠️ Codex execution node disconnected. Start a fresh attempt.",
    isGenericRunnerFailure: false,
  });
});

it("does not trust provider codes as runtime coordination provenance", () => {
  const error = new FailoverError("private provider diagnostic", {
    code: "codex_node_disconnected",
    provider: "private-provider",
    reason: "server_error",
    status: 500,
  });
  expect(externalReply(error)).toEqual({
    text: "⚠️ The AI service is having trouble. Please try again in a moment.",
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

it("keeps overloaded preflight diagnostics verbose-gated", () => {
  const message = `529 overloaded; reconnect before continuing. diagnostic-canary ${"x".repeat(1500)}`;
  const input = {
    message,
    error: new AgentHarnessPreflightError(message, {
      cause: new FailoverError("provider diagnostic", { reason: "overloaded", status: 529 }),
    }),
  };
  expect(
    knownReply(input.error, { Provider: "discord", Surface: "discord", ChatType: "group" }),
  ).toBeUndefined();
  expect(buildExternalRunFailureReply(input)).toEqual(genericFailure);
  const verbose = buildExternalRunFailureReply(input, { includeDetails: true });
  expect(verbose.isGenericRunnerFailure).toBe(true);
  expect(verbose.text).toContain("reconnect before continuing");
  expect(verbose.text).toContain("diagnostic-canary");
  expect(verbose.text).not.toContain("x".repeat(1500));
});

it.each([
  {
    error: new WorkerTaskError("worker task timed out", "timeout"),
    text: "A local worker task timed out. Please try again.",
  },
  {
    error: new ContextPreparationTimeoutError(new WorkerTaskError("private-canary", "timeout")),
    text: "Context preparation timed out locally. Please try again. If this persists, check Gateway logs for slow context reads.",
  },
])("preserves local stage guidance without exposing diagnostics: $text", ({ error, text }) => {
  const wrapped = new Error("private-wrapper-canary", { cause: error });
  expect(externalReply(wrapped)).toEqual({ text, isGenericRunnerFailure: false });
  expect(
    knownReply(wrapped, { Provider: "telegram", Surface: "telegram", ChatType: "direct" }),
  ).toMatchObject({ text, isError: true });
});

const promptSizeGuidance =
  "⚠️ The provider rejected this request because the prompt exceeds its per-request limit. Shorten the prompt and try again, or choose a model with a larger limit.";

it("preserves transport guidance in a terminal timeout-bucket reply", () => {
  const error = new FailoverError("Sanitized provider failure", {
    rawError: "private-canary",
    code: "ECONNREFUSED",
    reason: "timeout",
    status: 408,
    provider: "external",
    model: "local-model",
  });
  const payload = knownReply(error);

  expect(payload?.isError).toBe(true);
  expect(payload?.text).toContain("Couldn't connect to the AI service.");
  expect(payload?.text).toContain(
    "Check the conversation for any completed work before trying again.",
  );
  expect(payload?.text).not.toMatch(/took too long|private-canary|Sanitized provider failure/);
});

const groupCtx = { ...directContext, ChatType: "group" } as TemplateContext;
const diagnostic = (provider: string, model: string) =>
  `Auth profile "${provider}:alice-team-plan" is temporarily unavailable for ${provider}/${model}.`;
const cooldownFacts = (provider: string, model: string) => ({
  reason: "rate_limit" as const,
  code: AUTH_PROFILE_COOLDOWN_ERROR_CODE,
  provider,
  model,
});
const cooldown = (provider: string, model: string) =>
  new FailoverError(diagnostic(provider, model), {
    ...cooldownFacts(provider, model),
    profileId: `${provider}:alice-team-plan`,
  });
const chained = (provider: string, model: string) =>
  new FailoverError(`All models failed (1): ${provider}/${model}: ${diagnostic(provider, model)}`, {
    reason: "rate_limit",
    attempts: [
      {
        ...cooldownFacts(provider, model),
        error: diagnostic(provider, model),
      },
    ],
  });

it.each([
  ["direct OpenAI", cooldown("openai", "gpt-5.5")],
  ["fallback OpenAI", chained("openai", "gpt-5.5")],
  ["fallback with a hint-shaped label", chained("xai", "grok-4")],
])("keeps the saved-login label out of %s replies", (_name, err) => {
  expect(knownReply(err, groupCtx)?.text).toBe(
    "⚠️ The AI service needs a short break. Please try again in a few minutes.",
  );
});

it("still forwards provider-authored usage-limit guidance", () => {
  const hint = "You've hit your usage limit. Try again in 3 hours.";
  expect(
    knownReply(
      new FailoverError("All models failed (1)", {
        reason: "rate_limit",
        attempts: [{ provider: "openai", model: "gpt-5.5", reason: "rate_limit", error: hint }],
      }),
      groupCtx,
    )?.text,
  ).toBe(`⚠️ ${hint}`);
});
it("keeps HTTP server failures ahead of connection wording in provider details", () => {
  const error = new FailoverError("503 connection error: private-canary", {
    reason: "timeout",
    status: 503,
  });
  expect(knownReply(error)?.text).toBe(
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

  const payload = knownReply(error);

  expect(payload).toMatchObject({ isError: true, text: promptSizeGuidance });
});

it("preserves local capacity guidance through provider-looking wrappers without leaking detail", () => {
  const local = new WorkerTaskError("private-capacity-detail", "overloaded");
  const wrapped = new FailoverError("503 overloaded private-wrapper-detail", {
    reason: "overloaded",
    status: 503,
    cause: local,
  });
  for (const error of [local, wrapped, new AggregateError([local], "503 overloaded")]) {
    expect(knownReply(error)).toMatchObject({
      text: "OpenClaw's local workers are at capacity. Check the conversation for completed work before trying again.",
      isError: true,
    });
  }
  const provider = Object.assign(new Error("provider overloaded", { cause: local }), {
    status: 503,
  });
  expect(knownReply(provider)?.text).not.toContain("local workers");
  expect(knownReply(provider)).toBeDefined();
});
