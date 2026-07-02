// Skill tool dispatch tests cover policy-filtered tool surfaces.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type CreateOpenClawToolsArg = {
  agentChatType?: string;
  cronCreatorToolAllowlist?: Array<string | { name: string; pluginId?: string }>;
};

const hoisted = vi.hoisted(() => {
  function makeTool(name: string) {
    return {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };
  }
  return {
    createOpenClawToolsMock: vi.fn((args: CreateOpenClawToolsArg) => [
      makeTool("read"),
      makeTool("cron"),
      makeTool("exec"),
      ...(args.agentChatType === "direct" ? [makeTool("memory_store")] : []),
    ]),
  };
});

vi.mock("../../agents/openclaw-tools.runtime.js", () => ({
  createOpenClawTools: (args: CreateOpenClawToolsArg) => hoisted.createOpenClawToolsMock(args),
}));

import { resolveSkillDispatchTools } from "./tool-dispatch.js";

describe("resolveSkillDispatchTools", () => {
  it("passes final filtered tool surface to cron jobs", () => {
    const tools = resolveSkillDispatchTools({
      message: { surface: "telegram", senderId: "user-1" },
      cfg: {
        tools: { allow: ["read", "cron"] },
      } as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:telegram:group:restricted-room",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
    });

    const args = hoisted.createOpenClawToolsMock.mock.calls[0]?.[0];
    expect(tools.map((tool) => tool.name)).toEqual(["read", "cron"]);
    expect(args?.cronCreatorToolAllowlist).toEqual([{ name: "read" }, { name: "cron" }]);
  });

  it("passes stored shared chat type to plugin tools for opaque sessions", () => {
    resolveSkillDispatchTools({
      message: { surface: "telegram", senderId: "user-1" },
      cfg: {
        tools: { allow: ["read", "cron"] },
      } as OpenClawConfig,
      agentId: "main",
      sessionEntry: { sessionId: "opaque-shared-session", chatType: "group", updatedAt: 1 },
      sessionKey: "agent:main:acp:binding:telegram:acct:abc123",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
    });

    const args = hoisted.createOpenClawToolsMock.mock.calls.at(-1)?.[0];
    expect(args?.agentChatType).toBe("group");
  });

  it("lets live group chat type override stale direct metadata for plugin tools", () => {
    const tools = resolveSkillDispatchTools({
      message: { surface: "telegram", senderId: "user-1", chatType: "group" },
      cfg: {
        tools: { allow: ["read", "memory_store"] },
      } as OpenClawConfig,
      agentId: "main",
      sessionEntry: {
        sessionId: "stale-direct-session",
        chatType: "direct",
        longTermMemoryDefaultPolicy: "include",
        updatedAt: 1,
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
    });

    const args = hoisted.createOpenClawToolsMock.mock.calls.at(-1)?.[0];
    expect(args?.agentChatType).toBe("group");
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("keeps live direct chat type over a stale explicit-only stamp for plugin tools", () => {
    const tools = resolveSkillDispatchTools({
      message: { surface: "telegram", senderId: "user-1", chatType: "direct" },
      cfg: {
        tools: { allow: ["read", "memory_store"] },
      } as OpenClawConfig,
      agentId: "main",
      sessionEntry: {
        sessionId: "stale-explicit-session",
        chatType: "direct",
        longTermMemoryDefaultPolicy: "explicit-only",
        updatedAt: 1,
      },
      sessionKey: "agent:main:telegram:direct:user-1",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
    });

    const args = hoisted.createOpenClawToolsMock.mock.calls.at(-1)?.[0];
    expect(args?.agentChatType).toBe("direct");
    expect(tools.map((tool) => tool.name)).toEqual(["read", "memory_store"]);
  });

  it("uses target stored policy for cross-session live-direct skill dispatch", () => {
    const tools = resolveSkillDispatchTools({
      message: { surface: "telegram", senderId: "user-1", chatType: "direct" },
      cfg: {
        tools: { allow: ["read", "memory_store"] },
      } as OpenClawConfig,
      agentId: "main",
      sessionEntry: {
        sessionId: "target-explicit-only-session",
        chatType: "direct",
        longTermMemoryDefaultPolicy: "explicit-only",
        updatedAt: 1,
      },
      sourceSessionKey: "agent:main:telegram:direct:user-1",
      sessionKey: "agent:main:acp:binding:telegram:acct:abc123",
      workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
      provider: "openai",
      model: "gpt-5.5",
    });

    const args = hoisted.createOpenClawToolsMock.mock.calls.at(-1)?.[0];
    expect(args?.agentChatType).toBe("group");
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
  });
});
