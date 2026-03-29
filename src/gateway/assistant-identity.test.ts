import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity, resolveUserAvatar } from "./assistant-identity.js";

describe("resolveAssistantIdentity avatar normalization", () => {
  it("drops sentence-like avatar placeholders", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          avatar: "workspace-relative path, http(s) URL, or data URI",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe(
      DEFAULT_ASSISTANT_IDENTITY.avatar,
    );
  });

  it("keeps short text avatars", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          avatar: "PS",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe("PS");
  });

  it("keeps path avatars", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          avatar: "avatars/openclaw.png",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe("avatars/openclaw.png");
  });
});

describe("resolveUserAvatar", () => {
  it("returns null when userAvatar not set", () => {
    const cfg: OpenClawConfig = {};
    expect(resolveUserAvatar(cfg)).toBeNull();
  });

  it("returns null when userAvatar is empty string", () => {
    const cfg: OpenClawConfig = { ui: { userAvatar: "" } };
    expect(resolveUserAvatar(cfg)).toBeNull();
  });

  it("keeps valid short text avatar", () => {
    const cfg: OpenClawConfig = { ui: { userAvatar: "U" } };
    expect(resolveUserAvatar(cfg)).toBe("U");
  });

  it("keeps valid avatar path", () => {
    const cfg: OpenClawConfig = { ui: { userAvatar: "avatars/user.png" } };
    expect(resolveUserAvatar(cfg)).toBe("avatars/user.png");
  });

  it("drops sentence-like avatar (too long with spaces)", () => {
    const cfg: OpenClawConfig = { ui: { userAvatar: "this is a sentence" } };
    expect(resolveUserAvatar(cfg)).toBeNull();
  });

  it("keeps URL avatars", () => {
    const cfg: OpenClawConfig = { ui: { userAvatar: "https://example.com/avatar.png" } };
    expect(resolveUserAvatar(cfg)).toBe("https://example.com/avatar.png");
  });
});
