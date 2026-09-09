import { describe, expect, it } from "vitest";
import { resolveFallbackTransition } from "../fallback-state.js";
import type { TemplateContext } from "../templating.js";
import {
  buildSilentFallbackFailurePayload,
  resolveAdmittedRunSessionFile,
  resolveReplyRunDeliveryContext,
} from "./agent-runner-core.js";
import type { RuntimeFallbackAttempt } from "./agent-runner-execution.types.js";

describe("resolveAdmittedRunSessionFile", () => {
  it("uses the scoped session key when one is available", () => {
    expect(
      resolveAdmittedRunSessionFile({
        agentId: "main",
        sessionId: "session",
        sessionFile: "legacy-target",
        sessionKey: " agent:main:session ",
        storePath: "/tmp/sessions.json",
      }),
    ).toBe("agent:main:session");
  });

  it("preserves the admitted fallback when a persisted run has no session key", () => {
    expect(
      resolveAdmittedRunSessionFile({
        agentId: "main",
        sessionId: "session",
        sessionFile: "legacy-target",
        storePath: "/tmp/sessions.json",
      }),
    ).toBe("legacy-target");
  });
});

describe("resolveReplyRunDeliveryContext", () => {
  it.each([
    { name: "numeric message topic", messageThreadId: 99, threadId: 99 },
    { name: "numeric transport topic", transportThreadId: 99, threadId: 99 },
    { name: "message topic precedence", messageThreadId: 99, transportThreadId: 77, threadId: 99 },
    { name: "string message topic", messageThreadId: "99", threadId: "99" },
    { name: "session identity fallback", threadId: "12345:99" },
  ])("preserves the $name", ({ messageThreadId, transportThreadId, threadId }) => {
    expect(
      resolveReplyRunDeliveryContext({
        cfg: {},
        sessionCtx: {
          Provider: "telegram",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:12345",
          AccountId: "work",
          MessageThreadId: messageThreadId,
          TransportThreadId: transportThreadId,
          SessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
        } as TemplateContext,
        sessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
      }),
    ).toEqual({
      channel: "telegram",
      to: "telegram:12345",
      accountId: "work",
      threadId,
    });
  });
});

describe("buildSilentFallbackFailurePayload", () => {
  const selected = { provider: "openrouter", model: "z-ai/glm-5.3" };
  const other = { provider: "amazon-bedrock", model: "claude-haiku" };
  const transition = resolveFallbackTransition({
    selectedProvider: selected.provider,
    selectedModel: selected.model,
    activeProvider: other.provider,
    activeModel: other.model,
    attempts: [],
  });
  const base = {
    fallbackTransition: transition,
    fallbackFailureKnown: true,
    cfg: {},
    isHeartbeat: false,
    hasSuccessfulTerminalDelivery: false,
  };
  const attempt = (
    reason: RuntimeFallbackAttempt["reason"],
    identity: Partial<RuntimeFallbackAttempt> = {},
  ): RuntimeFallbackAttempt => ({ ...selected, error: "provider failed", reason, ...identity });

  it.each(["timeout", "server_error", "overloaded", "tls_certificate"] as const)(
    "uses unreachable wording for selected-backend %s evidence",
    (reason) => {
      const payload = buildSilentFallbackFailurePayload({
        ...base,
        fallbackAttempts: [attempt(reason)],
      });
      expect(payload?.text).toContain("couldn't reach the configured model backend");
      expect(payload?.text).toContain(transition.selectedModelRef);
      expect(payload?.text).toContain(transition.activeModelRef);
      expect(payload?.isError).toBe(true);
    },
  );

  it.each(["format", "empty_response"] as const)(
    "uses response wording for selected-backend %s evidence",
    (reason) => {
      const payload = buildSilentFallbackFailurePayload({
        ...base,
        fallbackAttempts: [attempt(reason)],
      });
      expect(payload?.text).toContain("responded but produced no usable reply");
      expect(payload?.text).not.toContain("couldn't reach");
    },
  );

  it.each([
    { label: "empty evidence", attempts: [] },
    { label: "unknown reason", attempts: [attempt("unknown")] },
    { label: "auth skip", attempts: [attempt("auth")] },
    { label: "auth with synthesized status", attempts: [attempt("auth", { status: 401 })] },
    { label: "permanent auth", attempts: [attempt("auth_permanent")] },
    { label: "billing", attempts: [attempt("billing")] },
    { label: "rate limit", attempts: [attempt("rate_limit")] },
    ...(["timeout", "overloaded", "format", "empty_response"] as const).map((reason) => ({
      label: `local skip retaining ${reason}`,
      attempts: [attempt(reason, { code: "MODEL_FALLBACK_SKIPPED" })],
    })),
    {
      label: "local skip beside a response",
      attempts: [attempt("format"), attempt("format", { code: "MODEL_FALLBACK_SKIPPED" })],
    },
    { label: "transport then response", attempts: [attempt("timeout"), attempt("format")] },
    { label: "response then transport", attempts: [attempt("format"), attempt("timeout")] },
    { label: "other backend only", attempts: [attempt("format", other)] },
    { label: "other model only", attempts: [attempt("format", { model: "different" })] },
    { label: "unattributed response", attempts: [attempt("format", { provider: "", model: "" })] },
    {
      label: "unattributed transport",
      attempts: [attempt("timeout", { provider: "", model: "" })],
    },
    {
      label: "incomplete evidence beside response",
      attempts: [attempt("format"), attempt("timeout", { provider: "" })],
    },
    {
      label: "incomplete evidence beside transport",
      attempts: [attempt("timeout"), attempt("format", { model: " " })],
    },
  ])("keeps $label cause-neutral", ({ attempts }) => {
    const payload = buildSilentFallbackFailurePayload({ ...base, fallbackAttempts: attempts });
    expect(payload?.text).toContain("produced no usable reply");
    expect(payload?.text).not.toContain("responded");
    expect(payload?.text).not.toContain("couldn't reach");
  });

  it.each([
    {
      selectedReason: "format",
      otherReason: "timeout",
      expected: "responded but produced no usable reply",
    },
    {
      selectedReason: "timeout",
      otherReason: "format",
      expected: "couldn't reach the configured model backend",
    },
  ] as const)(
    "ignores another backend's $otherReason evidence",
    ({ selectedReason, otherReason, expected }) => {
      const payload = buildSilentFallbackFailurePayload({
        ...base,
        fallbackAttempts: [attempt(otherReason, other), attempt(selectedReason)],
      });
      expect(payload?.text).toContain(expected);
    },
  );

  it("uses the configured runtime alias when attributing a response", () => {
    const cfg = { plugins: { allow: ["anthropic"], entries: { anthropic: { enabled: true } } } };
    const fallbackTransition = resolveFallbackTransition({
      selectedProvider: "anthropic",
      selectedModel: "claude-sonnet-4-6",
      activeProvider: "openai",
      activeModel: "gpt-5.5",
      attempts: [],
      cfg,
    });
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      cfg,
      fallbackTransition,
      fallbackAttempts: [attempt("format", { provider: "claude-cli", model: "claude-sonnet-4-6" })],
    });
    expect(payload?.text).toContain("responded but produced no usable reply");
  });

  it.each([
    { isHeartbeat: true },
    { hasSuccessfulTerminalDelivery: true },
    { allowEmptyAssistantReplyAsSilent: true },
    { silentExpected: true },
    { hasExplicitSilentReply: true },
    { fallbackFailureKnown: false },
    { fallbackTransition: { ...transition, fallbackActive: false } },
  ])("preserves warning suppression %j", (suppression) => {
    expect(
      buildSilentFallbackFailurePayload({
        ...base,
        ...suppression,
        fallbackAttempts: [attempt("format")],
      }),
    ).toBeUndefined();
  });
});
