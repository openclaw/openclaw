import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as mcpConnectionResolverTesting } from "../../agents/mcp-connection-resolver.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { assertSupportedTurn } from "./worker-turn-payload.js";

describe("assertSupportedTurn", () => {
  afterEach(() => {
    mcpConnectionResolverTesting.setMcpServerConnectionResolversForTest();
  });

  it("accepts scheduled authority for the worker launch envelope", () => {
    expect(
      assertSupportedTurn({
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "run",
        timeoutMs: 1_000,
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        config: {
          agents: {
            defaults: {
              models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
        toolsAllow: ["write"],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "default",
        },
        scheduledNativePolicy: { version: 1, mode: "disabled" },
      } as SessionPlacementTurnParams),
    ).toEqual({ provider: "openai", model: "gpt-5.4" });
  });

  it("rejects inherited native authority with executable recovery guidance", () => {
    const base = {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
    } as SessionPlacementTurnParams;

    expect(() =>
      assertSupportedTurn({
        ...base,
        scheduledNativePolicy: { version: 1, mode: "inherit" },
      }),
    ).toThrow(
      /inherited native tool authority.*reauthorize.*explicit finite tool cap.*automations edit.*--tools.*sessions\.reclaim.*"key":"<session-key>".*retry locally/is,
    );
  });

  it("rejects reachable MCP with executable recovery guidance", () => {
    const base = {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
    } as SessionPlacementTurnParams;

    expect(() =>
      assertSupportedTurn({
        ...base,
        config: {
          ...base.config,
          mcp: { servers: { docs: { command: "docs" } } },
        },
        scheduledNativePolicy: { version: 1, mode: "disabled" },
      }),
    ).toThrow(/cannot currently preserve.*MCP tool authority.*sessions\.reclaim/is);
  });

  it("keeps configured MCP available to ordinary cloud turns", () => {
    const turn = {
      sessionId: "session-ordinary",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-ordinary",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
        mcp: { servers: { docs: { command: "docs" } } },
      },
      toolsAllow: ["*"],
    } as SessionPlacementTurnParams;

    expect(assertSupportedTurn(turn)).toEqual({ provider: "openai", model: "gpt-5.4" });
  });

  it("accepts scheduled configured MCP when the effective override disables it", () => {
    const turn = {
      sessionId: "session-disabled-override",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-disabled-override",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
        mcp: { servers: { docs: { command: "docs" } } },
      },
      toolOverrides: { mcpServers: { docs: false } },
      toolsAllow: ["*"],
      scheduledNativePolicy: { version: 1, mode: "disabled" },
    } as SessionPlacementTurnParams;

    expect(assertSupportedTurn(turn)).toEqual({ provider: "openai", model: "gpt-5.4" });
  });

  it("accepts scheduled configured MCP when its tool filter excludes the whole server", () => {
    const turn = {
      sessionId: "session-filtered-server",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-filtered-server",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
        mcp: {
          servers: {
            docs: { command: "docs", toolFilter: { exclude: ["*"] } },
            shared: { command: "shared" },
          },
        },
      },
      toolsAllow: ["docs__read_docs"],
      scheduledNativePolicy: { version: 1, mode: "disabled" },
    } as SessionPlacementTurnParams;

    expect(assertSupportedTurn(turn)).toEqual({ provider: "openai", model: "gpt-5.4" });
    expect(() => assertSupportedTurn({ ...turn, toolsAllow: ["shared__search"] })).toThrow(
      /cannot currently preserve.*MCP tool authority/is,
    );
  });

  it("keeps exact per-tool filters fail-closed with reauthorization guidance", () => {
    const turn = {
      sessionId: "session-filtered-tool",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-filtered-tool",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
        mcp: {
          servers: {
            docs: { command: "docs", toolFilter: { exclude: ["read_docs"] } },
          },
        },
      },
      toolsAllow: ["docs__read_docs"],
      scheduledNativePolicy: { version: 1, mode: "disabled" },
    } as SessionPlacementTurnParams;

    expect(() => assertSupportedTurn(turn)).toThrow(
      /cannot currently preserve.*MCP tool authority.*reauthorize.*sessions\.reclaim/is,
    );
  });

  it("accepts a finite cap that cannot reach configured MCP", () => {
    const turn = {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
        mcp: { servers: { docs: { command: "docs" } } },
      },
      toolsAllow: ["read"],
      scheduledNativePolicy: { version: 1, mode: "disabled" },
    } as SessionPlacementTurnParams;

    expect(assertSupportedTurn(turn)).toEqual({ provider: "openai", model: "gpt-5.4" });
  });

  it("rejects wildcard caps that can overlap a configured MCP namespace", () => {
    const turn = {
      sessionId: "session-wildcard-mcp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-wildcard-mcp",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
        mcp: { servers: { docs: { command: "docs" } } },
      },
      toolsAllow: ["*__search"],
      scheduledNativePolicy: { version: 1, mode: "disabled" },
    } as SessionPlacementTurnParams;

    expect(() => assertSupportedTurn(turn)).toThrow(
      /cannot currently preserve.*MCP tool authority/is,
    );
  });

  it("accepts a final creator cap whose configured MCP tools were all denied", () => {
    const turn = {
      sessionId: "session-denied-mcp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-denied-mcp",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
        mcp: { servers: { docs: { command: "docs" } } },
      },
      // Creator caps contain only the final executable surface. The unrelated
      // namespaced tool must not make configured docs MCP look reachable.
      toolsAllow: ["maniple__check_idle_workers"],
      toolOverrides: { mcpToolsDeny: { docs: ["read_docs"] } },
      scheduledNativePolicy: { version: 1, mode: "disabled" },
    } as SessionPlacementTurnParams;

    expect(assertSupportedTurn(turn)).toEqual({ provider: "openai", model: "gpt-5.4" });
  });

  it("keeps same-namespace session denials fail-closed", () => {
    const turn = {
      sessionId: "session-denied-same-namespace",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-denied-same-namespace",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
        mcp: { servers: { docs: { command: "docs" } } },
      },
      toolsAllow: ["docs__read_docs"],
      toolOverrides: { mcpToolsDeny: { docs: ["read_docs"] } },
      scheduledNativePolicy: { version: 1, mode: "disabled" },
    } as SessionPlacementTurnParams;

    expect(() => assertSupportedTurn(turn)).toThrow(
      /cannot currently preserve.*MCP tool authority.*reauthorize.*sessions\.reclaim/is,
    );
  });

  it("accepts requester-scoped MCP that senderless scheduled turns cannot resolve", () => {
    const resolve = vi.fn(async () => null);
    mcpConnectionResolverTesting.setMcpServerConnectionResolversForTest([
      { serverName: "user-mail", resolve },
    ]);
    const turn = {
      sessionId: "session-requester-mcp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-requester-mcp",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
        mcp: {
          servers: {
            "user-mail": { transport: "streamable-http", url: "https://example.test/mcp" },
          },
        },
      },
      toolsAllow: ["user-mail__inbox"],
      scheduledNativePolicy: { version: 1, mode: "disabled" },
    } as SessionPlacementTurnParams;

    expect(assertSupportedTurn(turn)).toEqual({ provider: "openai", model: "gpt-5.4" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects only the retained static namespace in mixed scoped MCP config", () => {
    const resolve = vi.fn(async () => null);
    mcpConnectionResolverTesting.setMcpServerConnectionResolversForTest([
      { serverName: "user-mail", resolve },
    ]);
    const base = {
      sessionId: "session-mixed-mcp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-mixed-mcp",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
        mcp: {
          servers: {
            shared: { command: "shared" },
            "user-mail": { transport: "streamable-http", url: "https://example.test/mcp" },
          },
        },
      },
      scheduledNativePolicy: { version: 1 as const, mode: "disabled" as const },
    } as SessionPlacementTurnParams;

    expect(assertSupportedTurn({ ...base, toolsAllow: ["user-mail__inbox"] })).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(() => assertSupportedTurn({ ...base, toolsAllow: ["shared__search"] })).toThrow(
      /cannot currently preserve.*MCP tool authority/is,
    );
    expect(resolve).not.toHaveBeenCalled();
  });
});
