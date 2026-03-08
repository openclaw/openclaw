import { describe, expect, it } from "vitest";
import { buildMessagePersistenceProvenance, createSessionEntityId } from "./hook-provenance.js";

describe("hook provenance helpers", () => {
  it("builds persistence provenance for tool results", () => {
    const provenance = buildMessagePersistenceProvenance({
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text: "ok" }],
      },
      sessionKey: "agent:main:slack:user:u1",
      toolName: "read",
      toolCallId: "call-1",
    });

    expect(provenance.entityId).toBeDefined();
    expect(provenance.parentEntityId).toBe(createSessionEntityId("agent:main:slack:user:u1"));
    expect(provenance.sourceRefs).toEqual(["agent:main:slack:user:u1", "call-1", "read"]);
    expect(provenance.confidence).toBe(1);
  });

  it("marks synthetic tool-result provenance as derived", () => {
    const provenance = buildMessagePersistenceProvenance({
      message: {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "read",
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text: "synthetic" }],
      },
      sessionKey: "agent:main:slack:user:u1",
      toolName: "read",
      toolCallId: "call-2",
      isSynthetic: true,
    });

    expect(provenance.derivedFrom).toEqual(["synthetic-tool-result"]);
  });
});
