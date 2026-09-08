import { describe, expect, it } from "vitest";
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

const silentFallbackParams = {
  fallbackFailureKnown: true,
  isHeartbeat: false,
  hasSuccessfulTerminalDelivery: false,
} as const;

function silentFallbackTransition() {
  return {
    selectedModelRef: "openai/gpt-5.6-luna",
    activeModelRef: "anthropic/claude-sonnet-5",
    fallbackActive: true,
    fallbackTransitioned: true,
    fallbackCleared: false,
    reasonSummary: "",
    attemptSummaries: [],
    previousState: {},
    nextState: {},
    stateChanged: true,
  };
}

function fallbackAttempt(
  reason: RuntimeFallbackAttempt["reason"],
  provider = "openai",
  model = "gpt-5.6-luna",
): RuntimeFallbackAttempt {
  return { provider, model, error: "failed", reason };
}

describe("buildSilentFallbackFailurePayload", () => {
  it("keeps the unreachable wording when every attempt failed before the backend answered", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...silentFallbackParams,
      fallbackTransition: silentFallbackTransition(),
      fallbackAttempts: [fallbackAttempt("server_error"), fallbackAttempt("timeout")],
    });
    expect(payload?.text).toContain("I couldn't reach the configured model backend");
  });

  it("keeps the historical wording when no attempt records exist", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...silentFallbackParams,
      fallbackTransition: silentFallbackTransition(),
      fallbackAttempts: [],
    });
    expect(payload?.text).toContain("I couldn't reach the configured model backend");
  });

  it.each(["format", "billing", "rate_limit", "context_overflow", "session_expired"] as const)(
    "uses neutral wording for %s failures, claiming neither reachability nor a response",
    (reason) => {
      const payload = buildSilentFallbackFailurePayload({
        ...silentFallbackParams,
        fallbackTransition: silentFallbackTransition(),
        fallbackAttempts: [fallbackAttempt(reason)],
      });
      expect(payload?.text).toContain("did not produce a usable reply");
      expect(payload?.text).not.toContain("couldn't reach");
      expect(payload?.text).not.toContain("responded");
    },
  );

  it("uses neutral wording for auth-skipped candidates that never sent a request", () => {
    // The fallback runner records an auth-class failure for skipped candidates
    // and continues without executing them, so no backend answered and no
    // response claim is supportable.
    const payload = buildSilentFallbackFailurePayload({
      ...silentFallbackParams,
      fallbackTransition: silentFallbackTransition(),
      fallbackAttempts: [fallbackAttempt("auth")],
    });
    expect(payload?.text).toContain("did not produce a usable reply");
    expect(payload?.text).not.toContain("couldn't reach");
    expect(payload?.text).not.toContain("responded");
  });

  it.each([
    { primary: "timeout", secondary: "format" },
    { primary: "server_error", secondary: "format" },
  ] as const)(
    "uses neutral wording when a $primary transport failure mixes with a $secondary response-side failure",
    ({ primary, secondary }) => {
      const payload = buildSilentFallbackFailurePayload({
        ...silentFallbackParams,
        fallbackTransition: silentFallbackTransition(),
        fallbackAttempts: [
          fallbackAttempt(primary, "openai", "gpt-5.6-luna"),
          fallbackAttempt(secondary, "anthropic", "claude-sonnet-5"),
        ],
      });
      expect(payload?.text).toContain("did not produce a usable reply");
      expect(payload?.text).not.toContain("couldn't reach");
      expect(payload?.text).not.toContain("responded");
    },
  );

  it("still suppresses the payload for heartbeat runs", () => {
    expect(
      buildSilentFallbackFailurePayload({
        ...silentFallbackParams,
        isHeartbeat: true,
        fallbackTransition: silentFallbackTransition(),
        fallbackAttempts: [fallbackAttempt("format")],
      }),
    ).toBeUndefined();
  });

  it("still suppresses the payload when no fallback failure is known", () => {
    expect(
      buildSilentFallbackFailurePayload({
        ...silentFallbackParams,
        fallbackFailureKnown: false,
        fallbackTransition: silentFallbackTransition(),
        fallbackAttempts: [fallbackAttempt("format")],
      }),
    ).toBeUndefined();
  });
});
