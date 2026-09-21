import { describe, expect, it } from "vitest";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { resolveFallbackTransition } from "../fallback-state.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import {
  buildSilentFallbackFailurePayload,
  resolveAdmittedRunSessionFile,
  resolveReplyRunDeliveryContext,
} from "./agent-runner-core.js";

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
  const selected = { provider: "openai", model: "primary-model" };
  const other = { provider: "anthropic", model: "fallback-model" };
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
    fallbackAttempts: [],
    cfg: {},
    completion: resolveReplyCompletion("required", "empty"),
  };

  it("surfaces both model identities when a required fallback reply is missing", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      cfg: { agents: { defaults: { silentReply: { group: "allow" } } } },
    });

    expect(payload?.isError).toBe(true);
    expect(payload?.text).toContain(transition.selectedModelRef);
    expect(payload?.text).toContain(transition.activeModelRef);
    expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it.each([
    resolveReplyCompletion("optional", "empty"),
    ...(["ready", "delivered", "pending", "blocked"] as const).map((evidence) =>
      resolveReplyCompletion("required", evidence),
    ),
  ])("does not synthesize a failure for $expectation/$outcome", (completion) => {
    expect(buildSilentFallbackFailurePayload({ ...base, completion })).toBeUndefined();
  });

  it.each([
    { fallbackFailureKnown: false },
    { fallbackTransition: { ...transition, fallbackActive: false } },
  ])("requires an active failed fallback: %j", (fallback) => {
    expect(buildSilentFallbackFailurePayload({ ...base, ...fallback })).toBeUndefined();
  });
});
