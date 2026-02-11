import { describe, expect, it } from "vitest";
import { classifySessionKeyShape } from "./session-key.js";

describe("classifySessionKeyShape", () => {
  it("classifies empty keys as missing", () => {
    expect(classifySessionKeyShape(undefined)).toBe("missing");
    expect(classifySessionKeyShape("   ")).toBe("missing");
  });

  it("classifies valid agent keys", () => {
    expect(classifySessionKeyShape("agent:main:main")).toBe("agent");
    expect(classifySessionKeyShape("agent:research:subagent:worker")).toBe("agent");
  });

  it("classifies malformed agent keys", () => {
    expect(classifySessionKeyShape("agent::broken")).toBe("malformed_agent");
    expect(classifySessionKeyShape("agent:main")).toBe("malformed_agent");
  });

  it("treats non-agent legacy or alias keys as non-malformed", () => {
    expect(classifySessionKeyShape("main")).toBe("legacy_or_alias");
    expect(classifySessionKeyShape("custom-main")).toBe("legacy_or_alias");
    expect(classifySessionKeyShape("subagent:worker")).toBe("legacy_or_alias");
  });
});

describe("session key backward compatibility", () => {
  it("classifies legacy :dm: session keys as valid agent keys", () => {
    // Legacy session keys use :dm: instead of :direct:
    // Both should be recognized as valid agent keys
    expect(classifySessionKeyShape("agent:main:telegram:dm:123456")).toBe("agent");
    expect(classifySessionKeyShape("agent:main:whatsapp:dm:+15551234567")).toBe("agent");
    expect(classifySessionKeyShape("agent:main:discord:dm:user123")).toBe("agent");
  });

  it("classifies new :direct: session keys as valid agent keys", () => {
    expect(classifySessionKeyShape("agent:main:telegram:direct:123456")).toBe("agent");
    expect(classifySessionKeyShape("agent:main:whatsapp:direct:+15551234567")).toBe("agent");
    expect(classifySessionKeyShape("agent:main:discord:direct:user123")).toBe("agent");
  });
});
