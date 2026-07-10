/**
 * Gateway tool-resolution exclusion tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type CreateOpenClawToolsArg = {
  clientCaps?: string[];
  cronCreatorToolAllowlist?: Array<string | { name: string; pluginId?: string }>;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  pluginToolDenylist?: string[];
  sandboxed?: boolean;
};

type LazyExecToolDefaults = {
  host?: string;
  allowBackground?: boolean;
  node?: string;
};

type LazyExecToolPresentation = {
  description?: string;
  parameters?: Record<string, unknown>;
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
  const createLazyExecToolMock = vi.fn(
    (_defaults: LazyExecToolDefaults, presentation?: LazyExecToolPresentation) => ({
      ...makeTool("exec"),
      description: presentation?.description ?? "exec tool",
      parameters: presentation?.parameters ?? { type: "object", properties: {} },
    }),
  );
  return {
    makeTool,
    createLazyExecToolMock,
    createOpenClawToolsMock: vi.fn((_args: CreateOpenClawToolsArg) => [
      makeTool("read"),
      makeTool("sessions_spawn"),
      makeTool("cron"),
      makeTool("gateway"),
      makeTool("nodes"),
    ]),
  };
});

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: (args: CreateOpenClawToolsArg) => hoisted.createOpenClawToolsMock(args),
}));

vi.mock("../agents/lazy-exec-tool.js", () => ({
  createLazyExecTool: (defaults: LazyExecToolDefaults, presentation?: LazyExecToolPresentation) =>
    hoisted.createLazyExecToolMock(defaults, presentation),
  resolveExecToolConfig: vi.fn(() => ({})),
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools excludeToolNames", () => {
  beforeEach(() => {
    hoisted.createOpenClawToolsMock.mockClear();
    hoisted.createLazyExecToolMock.mockClear();
  });

  function readCreateToolsArgs(index = 0): {
    clientCaps?: string[];
    cronCreatorToolAllowlist?: Array<string | { name: string; pluginId?: string }>;
    inheritedToolAllowlist?: string[];
    inheritedToolDenylist?: string[];
    pluginToolDenylist?: string[];
    sandboxed?: boolean;
  } {
    const args = hoisted.createOpenClawToolsMock.mock.calls[index]?.[0];
    if (!args || typeof args !== "object") {
      throw new Error("expected createOpenClawTools args");
    }
    return args as {
      clientCaps?: string[];
      cronCreatorToolAllowlist?: Array<string | { name: string; pluginId?: string }>;
      inheritedToolAllowlist?: string[];
      inheritedToolDenylist?: string[];
      pluginToolDenylist?: string[];
      sandboxed?: boolean;
    };
  }

  it("passes gateway client capabilities into tool construction", () => {
    resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      clientCaps: ["tool-events", "inline-widgets"],
    });

    expect(readCreateToolsArgs().clientCaps).toEqual(["tool-events", "inline-widgets"]);
  });

  it("filters loopback dedup exclusions without inheriting policy denies", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      excludeToolNames: ["read", "apply_patch"],
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "sessions_spawn",
      "cron",
      "gateway",
      "nodes",
    ]);
    const args = readCreateToolsArgs();
    expect(args.pluginToolDenylist).toEqual([]);
    expect(args.inheritedToolDenylist).toEqual([]);
  });

  it("keeps owner-only core tools visible only for owner loopback callers", () => {
    const ownerResult = resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { allow: ["gateway"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
    });
    const nonOwnerResult = resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { allow: ["gateway"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: false,
    });

    expect(ownerResult.tools.map((tool) => tool.name)).toEqual([
      "read",
      "sessions_spawn",
      "cron",
      "gateway",
      "nodes",
    ]);
    expect(nonOwnerResult.tools.map((tool) => tool.name)).toEqual(["read", "sessions_spawn"]);
    const args = readCreateToolsArgs(1);
    expect(args.pluginToolDenylist).toEqual(["cron", "gateway", "nodes", "computer"]);
    expect(args.inheritedToolDenylist).toEqual(["cron", "gateway", "nodes", "computer"]);
  });

  it("keeps real gateway deny policy inheritable while excluding native dedup tools", () => {
    resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { deny: ["exec"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      excludeToolNames: ["read", "apply_patch"],
    });

    const args = readCreateToolsArgs();
    expect(args.pluginToolDenylist).toEqual(["exec"]);
    expect(args.inheritedToolDenylist).toEqual(["exec"]);
  });

  it("adds a synchronous node-forced exec tool to allowed owner loopback scopes", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name).filter((name) => name === "exec")).toEqual([
      "exec",
    ]);
    expect(hoisted.createLazyExecToolMock).toHaveBeenCalledOnce();
    expect(hoisted.createLazyExecToolMock.mock.calls[0]?.[0]).toMatchObject({
      host: "node",
      allowBackground: false,
    });
    const presentation = hoisted.createLazyExecToolMock.mock.calls[0]?.[1];
    expect(presentation?.description).toContain("node-only");
    const schemaProperties = presentation?.parameters?.properties;
    expect(
      Object.keys(schemaProperties && typeof schemaProperties === "object" ? schemaProperties : {}),
    ).toEqual(["command", "workdir", "env", "timeout", "host", "node"]);
    const hostSchema = (
      schemaProperties && typeof schemaProperties === "object"
        ? (schemaProperties as Record<string, unknown>).host
        : undefined
    ) as { enum?: unknown } | undefined;
    expect(hostSchema?.enum).toEqual(["node"]);
  });

  it("omits all exec variants when host policy forbids node execution", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const gatewayOnly = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      execSession: { execHost: "gateway" },
    });
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const sandboxAuto = resolveGatewayScopedTools({
      cfg: { agents: { defaults: { sandbox: { mode: "all" } } } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(gatewayOnly.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(sandboxAuto.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(hoisted.createLazyExecToolMock).not.toHaveBeenCalled();
  });

  it("does not honor the internal node-exec flag on HTTP surfaces", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "http",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(hoisted.createLazyExecToolMock).not.toHaveBeenCalled();
  });

  it("filters node exec through the existing gateway deny policy", () => {
    const result = resolveGatewayScopedTools({
      cfg: { gateway: { tools: { deny: ["exec"] } } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
  });

  it("filters node exec through immutable sender-scoped policy", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: {
          toolsBySender: {
            "id:blocked-sender": { deny: ["exec"] },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:discord:channel:dev",
      surface: "loopback",
      senderIsOwner: false,
      messageProvider: "discord",
      channelContext: { sender: { id: "blocked-sender" } },
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it("filters node exec through group sender-scoped policy", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        channels: {
          telegram: {
            groups: {
              dev: {
                toolsBySender: {
                  "id:blocked-sender": { deny: ["exec"] },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:dev",
      surface: "loopback",
      senderIsOwner: false,
      messageProvider: "telegram",
      channelContext: { sender: { id: "blocked-sender" } },
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it("does not inherit node-only exec as a generic child or cron capability", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { allow: ["exec", "sessions_spawn", "cron"] } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).toContain("exec");
    expect(readCreateToolsArgs().inheritedToolAllowlist).not.toContain("exec");
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).not.toContainEqual({ name: "exec" });
  });

  it("passes sandbox context and inherited sandbox denies into loopback tools", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        tools: { sandbox: { tools: { deny: ["cron"] } } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "sessions_spawn"]);
    const args = readCreateToolsArgs();
    expect(args.sandboxed).toBe(true);
    expect(args.pluginToolDenylist).toEqual(["cron"]);
    expect(args.inheritedToolDenylist).toEqual(["cron"]);
  });

  it("passes final filtered tool surface to gateway cron jobs", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("cron"),
      hoisted.makeTool("exec"),
    ]);

    const result = resolveGatewayScopedTools({
      cfg: {
        tools: { allow: ["read", "cron"] },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "cron"]);
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).toEqual([
      { name: "read" },
      { name: "cron" },
    ]);
  });
});
