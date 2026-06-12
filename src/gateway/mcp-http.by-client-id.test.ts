import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verify the registry-driven plumbing: McpLoopbackToolCache reads the operator
// session's recorded client.id and forwards the matching
// gateway.tools.byClientId allow/deny into resolveGatewayScopedTools.

type MockTool = { name: string };

const resolveGatewayScopedToolsMock = vi.hoisted(() =>
  vi.fn<
    (params: { allowToolNames?: Iterable<string>; excludeToolNames?: Iterable<string> }) => {
      agentId: string;
      tools: MockTool[];
    }
  >(() => ({ agentId: "main", tools: [{ name: "browser" }] })),
);

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: (...args: Parameters<typeof resolveGatewayScopedToolsMock>) =>
    resolveGatewayScopedToolsMock(...args),
}));

vi.mock("../agents/tool-policy.js", () => ({
  applyOwnerOnlyToolPolicy: (tools: MockTool[]) => tools,
}));

vi.mock("./mcp-http.schema.js", () => ({
  buildMcpToolSchema: (tools: MockTool[]) => tools.map((t) => ({ name: t.name })),
}));

import { McpLoopbackToolCache } from "./mcp-http.runtime.js";
import {
  resetSessionOperatorClientIdsForTest,
  setSessionOperatorClientId,
} from "./session-client-id-registry.js";

const BROWSER_COPILOT = "openclaw-browser-copilot";

function makeCfg() {
  return {
    gateway: {
      tools: {
        byClientId: {
          [BROWSER_COPILOT]: {
            allow: ["browser", "memory_search", "memory_get"],
          },
        },
      },
    },
  } as never;
}

function lastCall() {
  const calls = resolveGatewayScopedToolsMock.mock.calls;
  return calls[calls.length - 1]?.[0];
}

beforeEach(() => {
  resolveGatewayScopedToolsMock.mockClear();
  resetSessionOperatorClientIdsForTest();
});

afterEach(() => {
  resetSessionOperatorClientIdsForTest();
});

describe("McpLoopbackToolCache gateway.tools.byClientId", () => {
  it("applies the allow list for a session whose operator is the browser extension", () => {
    const cache = new McpLoopbackToolCache();
    setSessionOperatorClientId("agent:main:main", BROWSER_COPILOT);
    cache.resolve({
      cfg: makeCfg(),
      sessionKey: "agent:main:main",
      messageProvider: undefined,
      accountId: undefined,
      senderIsOwner: true,
    });
    const params = lastCall();
    expect(Array.from(params?.allowToolNames ?? [])).toEqual([
      "browser",
      "memory_search",
      "memory_get",
    ]);
  });

  it("does not restrict a session whose operator has a different client.id", () => {
    const cache = new McpLoopbackToolCache();
    setSessionOperatorClientId("agent:main:main", "webchat-ui");
    cache.resolve({
      cfg: makeCfg(),
      sessionKey: "agent:main:main",
      messageProvider: undefined,
      accountId: undefined,
      senderIsOwner: true,
    });
    const params = lastCall();
    expect(params?.allowToolNames).toBeUndefined();
  });

  it("does not restrict when no client.id is recorded for the session", () => {
    const cache = new McpLoopbackToolCache();
    cache.resolve({
      cfg: makeCfg(),
      sessionKey: "agent:main:main",
      messageProvider: undefined,
      accountId: undefined,
      senderIsOwner: true,
    });
    const params = lastCall();
    expect(params?.allowToolNames).toBeUndefined();
  });

  it("merges byClientId.deny into excludeToolNames (alongside native excludes)", () => {
    const cache = new McpLoopbackToolCache();
    setSessionOperatorClientId("agent:main:main", BROWSER_COPILOT);
    const cfg = {
      gateway: {
        tools: {
          byClientId: {
            [BROWSER_COPILOT]: { deny: ["nodes"] },
          },
        },
      },
    } as never;
    cache.resolve({
      cfg,
      sessionKey: "agent:main:main",
      messageProvider: undefined,
      accountId: undefined,
      senderIsOwner: true,
    });
    const params = lastCall();
    const excludes = Array.from(params?.excludeToolNames ?? []);
    expect(excludes).toContain("nodes");
    // native excludes are preserved
    expect(excludes).toContain("exec");
  });

  it("keys the cache by client.id so the same session resolves differently per operator", () => {
    const cache = new McpLoopbackToolCache();
    const cfg = makeCfg();

    setSessionOperatorClientId("agent:main:main", BROWSER_COPILOT);
    cache.resolve({
      cfg,
      sessionKey: "agent:main:main",
      messageProvider: undefined,
      accountId: undefined,
      senderIsOwner: true,
    });
    expect(Array.from(lastCall()?.allowToolNames ?? [])).toHaveLength(3);

    setSessionOperatorClientId("agent:main:main", "webchat-ui");
    cache.resolve({
      cfg,
      sessionKey: "agent:main:main",
      messageProvider: undefined,
      accountId: undefined,
      senderIsOwner: true,
    });
    // A fresh resolve (not a cache hit) with no restriction.
    expect(lastCall()?.allowToolNames).toBeUndefined();
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(2);
  });
});
