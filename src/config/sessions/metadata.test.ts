import { describe, expect, it, vi } from "vitest";

vi.mock("../../channels/plugins/index.js", () => ({
  normalizeChannelId: () => null,
}));
vi.mock("../../channels/dock.js", () => ({
  getChannelDock: () => undefined,
}));
vi.mock("../../channels/conversation-label.js", () => ({
  resolveConversationLabel: () => undefined,
}));

import type { MsgContext } from "../../auto-reply/templating.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { deriveGroupSessionPatch } from "./metadata.js";
import type { GroupKeyResolution, SessionEntry } from "./types.js";

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    GroupSubject: undefined,
    GroupSpace: undefined,
    GroupChannel: undefined,
    ...overrides,
  } as MsgContext;
}

describe("deriveGroupSessionPatch – auto-label", () => {
  const baseResolution: GroupKeyResolution = {
    key: "discord:1472892609285328988",
    channel: "discord",
    id: "1472892609285328988",
    chatType: "channel",
  };

  it("sets label from groupChannel for new channel sessions", () => {
    const patch = deriveGroupSessionPatch({
      ctx: makeCtx({ GroupSubject: "#config" }),
      sessionKey: "discord:1472892609285328988",
      groupResolution: baseResolution,
    });
    expect(patch).not.toBeNull();
    expect(patch!.groupChannel).toBe("#config");
    expect(patch!.label).toBe("#config");
  });

  it("sets label from subject for group sessions", () => {
    const patch = deriveGroupSessionPatch({
      ctx: makeCtx({ GroupSubject: "My Group Chat" }),
      sessionKey: "whatsapp:group:123",
      groupResolution: {
        key: "whatsapp:group:123",
        channel: "whatsapp",
        id: "123",
        chatType: "group",
      },
    });
    expect(patch).not.toBeNull();
    expect(patch!.subject).toBe("My Group Chat");
    expect(patch!.label).toBe("My Group Chat");
  });

  it("does not overwrite an existing label", () => {
    const existing: Partial<SessionEntry> = { label: "User-Set Label" };
    const patch = deriveGroupSessionPatch({
      ctx: makeCtx({ GroupSubject: "#config" }),
      sessionKey: "discord:1472892609285328988",
      existing: existing as SessionEntry,
      groupResolution: baseResolution,
    });
    expect(patch).not.toBeNull();
    expect(patch!.label).toBeUndefined();
  });

  it("falls back to existing groupChannel when no new channel is derived", () => {
    const existing: Partial<SessionEntry> = { groupChannel: "#general" };
    const patch = deriveGroupSessionPatch({
      ctx: makeCtx(),
      sessionKey: "discord:1472892609285328988",
      existing: existing as SessionEntry,
      groupResolution: baseResolution,
    });
    expect(patch).not.toBeNull();
    expect(patch!.label).toBe("#general");
  });

  it("skips auto-label when it exceeds the max length", () => {
    const longName = "#" + "a".repeat(SESSION_LABEL_MAX_LENGTH);
    const patch = deriveGroupSessionPatch({
      ctx: makeCtx({ GroupSubject: longName }),
      sessionKey: "discord:1472892609285328988",
      groupResolution: baseResolution,
    });
    expect(patch).not.toBeNull();
    expect(patch!.label).toBeUndefined();
  });

  it("skips auto-label when isLabelTaken returns true", () => {
    const patch = deriveGroupSessionPatch({
      ctx: makeCtx({ GroupSubject: "#general" }),
      sessionKey: "discord:1472892609285328988",
      groupResolution: baseResolution,
      isLabelTaken: (label) => label === "#general",
    });
    expect(patch).not.toBeNull();
    expect(patch!.label).toBeUndefined();
  });

  it("assigns auto-label when isLabelTaken returns false", () => {
    const patch = deriveGroupSessionPatch({
      ctx: makeCtx({ GroupSubject: "#unique-channel" }),
      sessionKey: "discord:1472892609285328988",
      groupResolution: baseResolution,
      isLabelTaken: () => false,
    });
    expect(patch).not.toBeNull();
    expect(patch!.label).toBe("#unique-channel");
  });
});
