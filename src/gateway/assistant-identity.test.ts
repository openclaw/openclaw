import { describe, expect, it } from "vitest";
import { DEFAULT_ASSISTANT_IDENTITY } from "./assistant-identity.js";

describe("DEFAULT_ASSISTANT_IDENTITY", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_ASSISTANT_IDENTITY.agentId).toBe("main");
    expect(DEFAULT_ASSISTANT_IDENTITY.name).toBe("Assistant");
    expect(DEFAULT_ASSISTANT_IDENTITY.avatar).toBe("A");
  });

  it("avatar is single character", () => {
    expect(DEFAULT_ASSISTANT_IDENTITY.avatar.length).toBe(1);
  });
});
