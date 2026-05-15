/**
 * Tests that the failure-fallback path honors the agents.defaults.silentReply
 * policy set by the operator (issue #82060).
 *
 * Previously, resolveExternalRunFailureTextForConversation() hardcoded
 * SILENT_REPLY_TOKEN for any non-direct context regardless of the configured
 * silentReply policy. Now it delegates to resolveSilentReplyPolicy(), so
 * operators can opt groups/channels into receiving failure copy by setting
 * `agents.defaults.silentReply.group: "disallow"`.
 */

import { describe, it, expect } from "vitest";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-execution.js";

function makeGroupCtx(overrides?: Partial<TemplateContext>): TemplateContext {
  return {
    SessionKey: "telegram:group:12345",
    ChatType: "group",
    Surface: "telegram",
    Provider: "telegram",
    ...overrides,
  } as unknown as TemplateContext;
}

function makeDirectCtx(overrides?: Partial<TemplateContext>): TemplateContext {
  return {
    SessionKey: "telegram:direct:67890",
    ChatType: "direct",
    Surface: "telegram",
    Provider: "telegram",
    ...overrides,
  } as unknown as TemplateContext;
}

const RATE_LIMIT_ERR = Object.assign(new Error("Too Many Requests - rate limit exceeded"), {
  status: 429,
});

describe("buildKnownAgentRunFailureReplyPayload — silentReply policy", () => {
  it("silences failure copy in group context by default (group policy: allow)", () => {
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: RATE_LIMIT_ERR,
      sessionCtx: makeGroupCtx(),
      resolvedVerboseLevel: undefined,
      cfg: {
        // Default: agents.defaults.silentReply not set → group defaults to "allow"
      },
    });
    expect(payload?.text).toBe(SILENT_REPLY_TOKEN);
  });

  it("delivers failure copy in group context when silentReply.group is 'disallow'", () => {
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: RATE_LIMIT_ERR,
      sessionCtx: makeGroupCtx(),
      resolvedVerboseLevel: undefined,
      cfg: {
        agents: {
          defaults: {
            silentReply: { group: "disallow" },
          },
        },
      },
    });
    expect(payload?.text).not.toBe(SILENT_REPLY_TOKEN);
    expect(payload?.text).toBeTruthy();
  });

  it("delivers failure copy in direct context regardless of group policy", () => {
    // Direct context: policy defaults to "disallow", so text should be returned.
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: RATE_LIMIT_ERR,
      sessionCtx: makeDirectCtx(),
      resolvedVerboseLevel: undefined,
      cfg: {},
    });
    expect(payload?.text).not.toBe(SILENT_REPLY_TOKEN);
    expect(payload?.text).toBeTruthy();
  });

  it("silences failure copy in direct context when silentReply.direct is 'allow'", () => {
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: RATE_LIMIT_ERR,
      sessionCtx: makeDirectCtx(),
      resolvedVerboseLevel: undefined,
      cfg: {
        agents: {
          defaults: {
            silentReply: { direct: "allow" },
          },
        },
      },
    });
    expect(payload?.text).toBe(SILENT_REPLY_TOKEN);
  });

  it("falls back to silencing when cfg is undefined (safe default)", () => {
    // Without cfg, resolveSilentReplyPolicy uses DEFAULT_SILENT_REPLY_POLICY
    // where group defaults to "allow", so group contexts should still be silenced.
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: RATE_LIMIT_ERR,
      sessionCtx: makeGroupCtx(),
      resolvedVerboseLevel: undefined,
    });
    expect(payload?.text).toBe(SILENT_REPLY_TOKEN);
  });
});
