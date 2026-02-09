import { describe, expect, it } from "vitest";
import type { EasyHubConfig } from "../config/config.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";

describe("resolveAssistantIdentity avatar normalization", () => {
  it("drops sentence-like avatar placeholders", () => {
    const cfg: EasyHubConfig = {
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
    const cfg: EasyHubConfig = {
      ui: {
        assistant: {
          avatar: "PS",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe("PS");
  });

  it("keeps path avatars", () => {
    const cfg: EasyHubConfig = {
      ui: {
        assistant: {
          avatar: "avatars/EasyHub.png",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe("avatars/EasyHub.png");
  });
});
