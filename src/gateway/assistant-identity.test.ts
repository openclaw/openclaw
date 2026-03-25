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
});

describe("resolveAssistantIdentity subagent priority", () => {
  function buildCfg(opts: {
    globalName?: string;
    globalAvatar?: string;
    agents?: Array<{
      id: string;
      default?: boolean;
      identity?: { name?: string; avatar?: string; emoji?: string };
    }>;
  }): OpenClawConfig {
    return {
      ui:
        opts.globalName || opts.globalAvatar
          ? { assistant: { name: opts.globalName, avatar: opts.globalAvatar } }
          : undefined,
      agents: opts.agents ? { list: opts.agents } : undefined,
    } as OpenClawConfig;
  }

  it("default agent uses global ui.assistant over per-agent identity", () => {
    const cfg = buildCfg({
      globalName: "Jarvis 2.0",
      globalAvatar: "J",
      agents: [{ id: "main", default: true, identity: { name: "Main Agent", avatar: "🤖" } }],
    });
    const result = resolveAssistantIdentity({ cfg, agentId: "main", workspaceDir: "" });
    expect(result.name).toBe("Jarvis 2.0");
    expect(result.avatar).toBe("J");
  });

  it("subagent uses per-agent identity over global ui.assistant", () => {
    const cfg = buildCfg({
      globalName: "Jarvis 2.0",
      globalAvatar: "J",
      agents: [
        { id: "main", default: true, identity: { name: "Jarvis 2.0" } },
        { id: "sub1", identity: { name: "sub1", emoji: "🎨" } },
      ],
    });
    const result = resolveAssistantIdentity({ cfg, agentId: "sub1", workspaceDir: "" });
    expect(result.name).toBe("sub1");
    expect(result.emoji).toBe("🎨");
  });

  it("subagent falls back to global when no per-agent identity", () => {
    const cfg = buildCfg({
      globalName: "Jarvis 2.0",
      globalAvatar: "J",
      agents: [{ id: "main", default: true }, { id: "sub2" }],
    });
    const result = resolveAssistantIdentity({ cfg, agentId: "sub2", workspaceDir: "" });
    expect(result.name).toBe("Jarvis 2.0");
    expect(result.avatar).toBe("J");
  });

  it("subagent with partial identity keeps its name, falls back avatar to global", () => {
    const cfg = buildCfg({
      globalName: "Jarvis 2.0",
      globalAvatar: "J",
      agents: [
        { id: "main", default: true },
        { id: "sub3", identity: { name: "sub3" } },
      ],
    });
    const result = resolveAssistantIdentity({ cfg, agentId: "sub3", workspaceDir: "" });
    expect(result.name).toBe("sub3");
    expect(result.avatar).toBe("J");
  });
});
