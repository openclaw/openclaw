import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { deriveGroupSessionPatch } from "./metadata.js";
import type { SessionEntry } from "./types.js";

describe("deriveGroupSessionPatch auto-labeling", () => {
  const baseCtx: MsgContext = {
    Provider: "discord",
    From: "discord:channel:123",
    ChatType: "channel",
  };

  it("sets label from groupChannel for new channel sessions", () => {
    const ctx = { ...baseCtx, GroupChannel: "#config" };
    const patch = deriveGroupSessionPatch({ ctx, sessionKey: "test-key" });
    expect(patch?.label).toBe("#config");
    expect(patch?.groupChannel).toBe("#config");
  });

  it("sets label from subject for group sessions", () => {
    const ctx = { ...baseCtx, ChatType: "group", GroupSubject: "My Group Chat" };
    const patch = deriveGroupSessionPatch({ ctx, sessionKey: "test-key" });
    expect(patch?.label).toBe("My Group Chat");
    expect(patch?.subject).toBe("My Group Chat");
  });

  it("does not overwrite an existing label", () => {
    const ctx = { ...baseCtx, GroupChannel: "#config" };
    const existing: SessionEntry = {
      sessionId: "s1",
      updatedAt: 123,
      label: "My Custom Label",
    };
    const patch = deriveGroupSessionPatch({ ctx, sessionKey: "test-key", existing });
    expect(patch?.label).toBeUndefined();
  });

  it("falls back to existing groupChannel when no new channel is derived", () => {
    const ctx = { ...baseCtx }; // No GroupChannel in context
    const existing: SessionEntry = {
      sessionId: "s1",
      updatedAt: 123,
      groupChannel: "#existing-channel",
    };
    const patch = deriveGroupSessionPatch({ ctx, sessionKey: "test-key", existing });
    expect(patch?.label).toBe("#existing-channel");
  });
});
