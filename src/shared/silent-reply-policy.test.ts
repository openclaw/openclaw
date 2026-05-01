import { describe, expect, it } from "vitest";
import {
  DEFAULT_SILENT_REPLY_POLICY,
  DEFAULT_SILENT_REPLY_REWRITE,
  classifySilentReplyConversationType,
  isStructuredThreadSessionKey,
  isTrustedStructuredThreadSessionKey,
  resolveSilentReplyPolicyFromPolicies,
  resolveSilentReplyRewriteFromPolicies,
  resolveSilentReplyRewriteText,
} from "./silent-reply-policy.js";

describe("classifySilentReplyConversationType", () => {
  it("prefers an explicit conversation type", () => {
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:group:123",
        conversationType: "internal",
      }),
    ).toBe("internal");
  });

  it("classifies direct and group session keys", () => {
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:telegram:direct:123",
      }),
    ).toBe("direct");
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:discord:group:123",
      }),
    ).toBe("group");
  });

  it("uses trusted structured thread keys as internal", () => {
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:telegram:direct:435427284:thread:435427284:300118",
        trustThreadSessionKey: true,
      }),
    ).toBe("internal");
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:discord:group:123:thread:456",
        trustThreadSessionKey: true,
      }),
    ).toBe("internal");
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:cron:job-id:run:run-id:thread:dreaming-narrative-light",
        trustThreadSessionKey: true,
      }),
    ).toBe("internal");
  });

  it("keeps caller-shaped or malformed thread keys on parent conversation policy", () => {
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:telegram:direct:123:thread:caller",
      }),
    ).toBe("direct");
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:discord:group:123:thread:456",
      }),
    ).toBe("group");
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:telegram:direct:123:thread:one:thread:two",
        trustThreadSessionKey: true,
      }),
    ).toBe("direct");
  });

  it("recognizes only one structured thread suffix", () => {
    expect(
      isStructuredThreadSessionKey("agent:main:telegram:direct:123:thread:435427284:300118"),
    ).toBe(true);
    expect(isStructuredThreadSessionKey("agent:main:telegram:direct:123")).toBe(false);
    expect(isStructuredThreadSessionKey("agent:main:telegram:direct:123:thread:")).toBe(false);
    expect(
      isStructuredThreadSessionKey("agent:main:telegram:direct:123:thread:one:thread:two"),
    ).toBe(false);
  });

  it("trusts structured thread keys only when the context thread id matches", () => {
    expect(
      isTrustedStructuredThreadSessionKey({
        sessionKey: "agent:main:telegram:direct:123:thread:435427284:300118",
        threadId: "435427284:300118",
      }),
    ).toBe(true);
    expect(
      isTrustedStructuredThreadSessionKey({
        sessionKey: "agent:main:telegram:direct:123:thread:caller",
        threadId: "provider-thread",
      }),
    ).toBe(false);
    expect(
      isTrustedStructuredThreadSessionKey({
        sessionKey: "agent:main:telegram:direct:123:thread:one:thread:two",
        threadId: "two",
      }),
    ).toBe(false);
  });

  it("treats webchat as direct by default and unknown surfaces as internal", () => {
    expect(classifySilentReplyConversationType({ surface: "webchat" })).toBe("direct");
    expect(classifySilentReplyConversationType({ surface: "subagent" })).toBe("internal");
  });
});

describe("resolveSilentReplyRewriteFromPolicies", () => {
  it("uses defaults when no overrides exist", () => {
    expect(resolveSilentReplyRewriteFromPolicies({ conversationType: "direct" })).toBe(
      DEFAULT_SILENT_REPLY_REWRITE.direct,
    );
    expect(resolveSilentReplyRewriteFromPolicies({ conversationType: "group" })).toBe(
      DEFAULT_SILENT_REPLY_REWRITE.group,
    );
  });

  it("prefers surface rewrite settings over defaults", () => {
    expect(
      resolveSilentReplyRewriteFromPolicies({
        conversationType: "direct",
        defaultRewrite: { direct: true },
        surfaceRewrite: { direct: false },
      }),
    ).toBe(false);
  });
});

describe("resolveSilentReplyRewriteText", () => {
  it("picks a deterministic rewrite for a given seed", () => {
    const first = resolveSilentReplyRewriteText({ seed: "main:NO_REPLY" });
    const second = resolveSilentReplyRewriteText({ seed: "main:NO_REPLY" });
    expect(first).toBe(second);
    expect(first).not.toBe("NO_REPLY");
    expect(first.length).toBeGreaterThan(0);
  });
});

describe("resolveSilentReplyPolicyFromPolicies", () => {
  it("uses defaults when no overrides exist", () => {
    expect(resolveSilentReplyPolicyFromPolicies({ conversationType: "direct" })).toBe(
      DEFAULT_SILENT_REPLY_POLICY.direct,
    );
    expect(resolveSilentReplyPolicyFromPolicies({ conversationType: "group" })).toBe(
      DEFAULT_SILENT_REPLY_POLICY.group,
    );
  });

  it("prefers surface policy over defaults", () => {
    expect(
      resolveSilentReplyPolicyFromPolicies({
        conversationType: "direct",
        defaultPolicy: { direct: "disallow" },
        surfacePolicy: { direct: "allow" },
      }),
    ).toBe("allow");
  });
});
