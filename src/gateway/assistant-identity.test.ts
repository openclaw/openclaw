import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";

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

  it("preserves long image data URLs without truncating past 200 chars", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(50_000)}`;
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          avatar: dataUrl,
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe(dataUrl);
  });
});

describe("resolveAssistantIdentity agent identity precedence", () => {
  it("keeps global ui assistant identity first for the default agent", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          name: "Default UI",
          avatar: "DU",
        },
      },
      agents: {
        list: [
          {
            id: "main",
            identity: {
              name: "Main Agent",
              avatar: "MA",
            },
          },
        ],
      },
    };

    expect(resolveAssistantIdentity({ cfg, agentId: "main", workspaceDir: "" })).toMatchObject({
      agentId: "main",
      name: "Default UI",
      avatar: "DU",
    });
  });

  it("prefers per-agent name over global ui assistant name for non-default agents", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          name: "Default UI",
        },
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
          },
          {
            id: "lottery",
            identity: {
              name: "Lottery",
            },
          },
        ],
      },
    };

    expect(resolveAssistantIdentity({ cfg, agentId: "lottery", workspaceDir: "" })).toMatchObject({
      agentId: "lottery",
      name: "Lottery",
    });
  });

  it("prefers per-agent avatar over global ui assistant avatar for non-default agents", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          avatar: "DU",
        },
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
          },
          {
            id: "lottery",
            identity: {
              emoji: "🐕",
            },
          },
        ],
      },
    };

    expect(resolveAssistantIdentity({ cfg, agentId: "lottery", workspaceDir: "" })).toMatchObject({
      agentId: "lottery",
      avatar: "🐕",
      emoji: "🐕",
    });
  });
});
