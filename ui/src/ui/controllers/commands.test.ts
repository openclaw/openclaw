import { describe, expect, it, vi } from "vitest";
import { loadChatCommandCatalog, type ChatCommandCatalogState } from "./commands.ts";

function createState(): {
  state: ChatCommandCatalogState;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  const state: ChatCommandCatalogState = {
    client: {
      request,
    } as unknown as ChatCommandCatalogState["client"],
    connected: true,
    chatCommandCatalogLoading: false,
    chatCommandCatalogLoadingAgentId: null,
    chatCommandCatalogAgentId: null,
    chatCommandCatalogRequestId: 0,
    chatCommandCatalogError: null,
    chatCommandCatalogResult: null,
  };
  return { state, request };
}

describe("loadChatCommandCatalog", () => {
  it("loads the text command catalog for the active agent", async () => {
    const { state, request } = createState();
    const payload = {
      commands: [
        {
          name: "help",
          textAliases: ["/help"],
          description: "Show available commands.",
          acceptsArgs: false,
          source: "native",
          scope: "both",
          category: "status",
        },
        {
          name: "office_hours",
          textAliases: ["/office_hours", "/office-hours"],
          description: "Run office hours workflow.",
          acceptsArgs: true,
          source: "skill",
          scope: "both",
          category: "tools",
        },
      ],
    } as const;
    request.mockResolvedValue(payload);

    await loadChatCommandCatalog(state, "main");

    expect(request).toHaveBeenCalledWith("commands.list", {
      agentId: "main",
      scope: "text",
      includeArgs: true,
    });
    expect(state.chatCommandCatalogResult).toEqual(payload);
    expect(state.chatCommandCatalogAgentId).toBe("main");
    expect(state.chatCommandCatalogError).toBeNull();
    expect(state.chatCommandCatalogLoading).toBe(false);
  });

  it("ignores stale responses when the newer request resolves first", async () => {
    const { state, request } = createState();
    const resolvers: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const firstPending = loadChatCommandCatalog(state, "main");
    const secondPending = loadChatCommandCatalog(state, "research");

    resolvers[1]?.({
      commands: [
        {
          name: "office_hours",
          textAliases: ["/office_hours"],
          description: "Run office hours workflow.",
          acceptsArgs: true,
          source: "skill",
          scope: "both",
          category: "tools",
        },
      ],
    });
    await secondPending;

    resolvers[0]?.({
      commands: [
        {
          name: "help",
          textAliases: ["/help"],
          description: "Show available commands.",
          acceptsArgs: false,
          source: "native",
          scope: "both",
          category: "status",
        },
      ],
    });
    await firstPending;

    expect(state.chatCommandCatalogResult).toEqual({
      commands: [
        {
          name: "office_hours",
          textAliases: ["/office_hours"],
          description: "Run office hours workflow.",
          acceptsArgs: true,
          source: "skill",
          scope: "both",
          category: "tools",
        },
      ],
    });
    expect(state.chatCommandCatalogAgentId).toBe("research");
    expect(state.chatCommandCatalogError).toBeNull();
    expect(state.chatCommandCatalogLoading).toBe(false);
  });

  it("allows a forced same-agent refresh to supersede an older in-flight request", async () => {
    const { state, request } = createState();
    const resolvers: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const firstPending = loadChatCommandCatalog(state, "main");
    const secondPending = loadChatCommandCatalog(state, "main", { force: true });

    resolvers[1]?.({
      commands: [
        {
          name: "office_hours",
          textAliases: ["/office_hours"],
          description: "Run office hours workflow.",
          acceptsArgs: true,
          source: "skill",
          scope: "both",
          category: "tools",
        },
      ],
    });
    await secondPending;

    resolvers[0]?.({
      commands: [
        {
          name: "help",
          textAliases: ["/help"],
          description: "Show available commands.",
          acceptsArgs: false,
          source: "native",
          scope: "both",
          category: "status",
        },
      ],
    });
    await firstPending;

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.chatCommandCatalogAgentId).toBe("main");
    expect(state.chatCommandCatalogResult).toEqual({
      commands: [
        {
          name: "office_hours",
          textAliases: ["/office_hours"],
          description: "Run office hours workflow.",
          acceptsArgs: true,
          source: "skill",
          scope: "both",
          category: "tools",
        },
      ],
    });
  });

  it("captures request errors so UI callers can fall back to static commands", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("gateway unavailable"));

    await loadChatCommandCatalog(state, "main");

    expect(state.chatCommandCatalogResult).toBeNull();
    expect(state.chatCommandCatalogError).toContain("gateway unavailable");
    expect(state.chatCommandCatalogLoading).toBe(false);
  });
});
