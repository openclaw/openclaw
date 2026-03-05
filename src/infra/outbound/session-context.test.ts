import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildOutboundSessionContext } from "./session-context.js";

describe("buildOutboundSessionContext", () => {
  const cfg = {} as unknown as OpenClawConfig;

  it("keeps explicit session key when provided", () => {
    const ctx = buildOutboundSessionContext({
      cfg,
      sessionKey: "agent:main:telegram:dm:123",
      agentId: "main",
    });

    expect(ctx).toEqual({
      key: "agent:main:telegram:dm:123",
      agentId: "main",
    });
  });

  it("derives main session key from explicit agentId when sessionKey is missing", () => {
    const ctx = buildOutboundSessionContext({
      cfg,
      agentId: "main",
    });

    expect(ctx).toEqual({
      key: "agent:main:main",
      agentId: "main",
    });
  });
});
