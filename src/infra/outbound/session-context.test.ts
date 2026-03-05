import { describe, expect, it } from "vitest";
import { buildOutboundSessionContext } from "./session-context.js";

describe("buildOutboundSessionContext", () => {
  const cfg = {};

  it("returns undefined when neither sessionKey nor agentId is provided", () => {
    expect(buildOutboundSessionContext({ cfg })).toBeUndefined();
  });

  it("returns key and agentId when sessionKey is provided", () => {
    const result = buildOutboundSessionContext({ cfg, sessionKey: "agent:bot:main" });
    expect(result).toEqual({ key: "agent:bot:main", agentId: "bot" });
  });

  it("derives key from agentId when sessionKey is not provided", () => {
    const result = buildOutboundSessionContext({ cfg, agentId: "mybot" });
    expect(result).toEqual({ key: "agent:mybot:main", agentId: "mybot" });
  });

  it("prefers explicit sessionKey over derived key", () => {
    const result = buildOutboundSessionContext({
      cfg,
      sessionKey: "agent:mybot:custom",
      agentId: "mybot",
    });
    expect(result).toEqual({ key: "agent:mybot:custom", agentId: "mybot" });
  });

  it("normalizes blank/null sessionKey and derives from agentId", () => {
    expect(buildOutboundSessionContext({ cfg, sessionKey: "  ", agentId: "x" })).toEqual({
      key: "agent:x:main",
      agentId: "x",
    });
    expect(buildOutboundSessionContext({ cfg, sessionKey: null, agentId: "x" })).toEqual({
      key: "agent:x:main",
      agentId: "x",
    });
  });

  it("returns undefined for blank agentId without sessionKey", () => {
    expect(buildOutboundSessionContext({ cfg, agentId: "  " })).toBeUndefined();
    expect(buildOutboundSessionContext({ cfg, agentId: null })).toBeUndefined();
  });

  it("respects session.mainKey config when deriving key from agentId", () => {
    const cfgWithMainKey = { session: { mainKey: "custom" } };
    const result = buildOutboundSessionContext({ cfg: cfgWithMainKey, agentId: "mybot" });
    expect(result).toEqual({ key: "agent:mybot:custom", agentId: "mybot" });
  });
});
