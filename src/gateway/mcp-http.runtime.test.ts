import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { createComputerTool } from "../agents/tools/computer-tool.js";
import {
  McpLoopbackToolCache,
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "./mcp-http.runtime.js";

const resolveGatewayScopedTools = vi.hoisted(() => vi.fn());
const listNodes = vi.hoisted(() => vi.fn());

vi.mock("../agents/tools/gateway.js", () => ({
  callGatewayTool: async (
    method: string,
    _opts: unknown,
    _args: unknown,
    options: { signal?: AbortSignal },
  ) => {
    if (method === "node.list") {
      return { nodes: await listNodes(options.signal) };
    }
    if (method === "computer.status") {
      return { configured: false, available: false };
    }
    throw new Error(`Unexpected Gateway method: ${method}`);
  },
}));

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools,
}));

function scopedToolFixture(names: string[]) {
  return {
    agentId: "main",
    tools: names.map((name) => ({ name, description: `${name} tool` })),
  };
}

function computerNode(nodeId: string, actions: string[]) {
  return {
    nodeId,
    displayName: nodeId === "headless-windows-node" ? "E6540" : "Windows Companion",
    platform: "win32",
    connected: true,
    commands: ["screen.snapshot", "computer.act"],
    computerUse: {
      contractVersion: 2,
      provider: {
        id: "cua-driver",
        label: "CUA Driver",
        generation: `${nodeId}-generation`,
      },
      actions,
      targets: ["screen", "window"],
      deliveryModes: ["foreground"],
      observations: ["image", "accessibility"],
      features: { recording: false, agentCursor: false, multiDisplay: false },
    },
  };
}

function readComputerActions(
  resolved: Awaited<ReturnType<McpLoopbackToolCache["resolve"]>>,
): string[] | undefined {
  const computer = resolved.toolSchema.find((tool) => tool.name === "computer");
  expect(computer).toBeDefined();
  return (computer?.inputSchema.properties as { action?: { enum?: string[] } } | undefined)?.action
    ?.enum;
}

type ScopeParams = Parameters<typeof resolveMcpLoopbackScopedTools>[0];

function scopeParams({
  cfg = {},
  grantToken,
  ...context
}: Partial<ScopeParams["context"] & Pick<ScopeParams, "cfg" | "grantToken">> = {}): ScopeParams {
  return {
    cfg,
    grantToken,
    context: { sessionKey: "agent:main:recall", senderIsOwner: false, ...context },
  };
}

beforeEach(() => {
  listNodes.mockReset();
  listNodes.mockResolvedValue([]);
  resolveGatewayScopedTools.mockReset();
  resolveGatewayScopedTools.mockReturnValue(
    scopedToolFixture(["memory_search", "memory_get", "message", "cron"]),
  );
});

describe("resolveMcpLoopbackScopedTools", () => {
  it("mediates an explicit wildcard policy while an omitted cap keeps native coding ownership", async () => {
    resolveGatewayScopedTools.mockReturnValue(scopedToolFixture(["read", "exec", "message"]));

    await resolveMcpLoopbackPolicyTools(scopeParams({ toolsAllow: ["*"] }));
    const wildcard = resolveGatewayScopedTools.mock.calls.at(-1)?.[0];
    expect(new Set(wildcard?.mediatedToolNames)).toContain("read");
    expect(new Set(wildcard?.mediatedToolNames)).toContain("exec");
    expect(new Set(wildcard?.excludeToolNames)).not.toContain("read");

    await resolveMcpLoopbackPolicyTools(scopeParams({}));
    const uncapped = resolveGatewayScopedTools.mock.calls.at(-1)?.[0];
    expect(new Set(uncapped?.mediatedToolNames)).toEqual(new Set());
    expect(new Set(uncapped?.excludeToolNames)).toContain("read");
  });

  it("keeps exact grant names exact instead of reinterpreting policy shorthand", async () => {
    resolveGatewayScopedTools.mockReturnValue(scopedToolFixture(["write", "apply_patch"]));

    const scoped = await resolveMcpLoopbackScopedTools(
      scopeParams({ toolsAllow: ["write"], nodeExecAllowed: true }),
    );

    expect(scoped.tools.map((tool) => tool.name)).toEqual(["write"]);
    expect(resolveGatewayScopedTools.mock.calls[0]?.[0]).toMatchObject({
      mediatedToolNames: new Set(["write"]),
      includeNodeExecTool: false,
    });
  });

  it.each([
    { allow: ["write"], expected: ["write", "apply_patch"] },
    { allow: [] as string[], expected: [] },
  ])(
    "materializes policy expressions into concrete loopback tools: $allow",
    async ({ allow, expected }) => {
      resolveGatewayScopedTools.mockReturnValue(
        scopedToolFixture([
          "read",
          "write",
          "edit",
          "apply_patch",
          "web_search",
          "web_fetch",
          "message",
        ]),
      );

      const scoped = await resolveMcpLoopbackPolicyTools(scopeParams({ toolsAllow: allow }));

      expect(scoped.tools.map((tool) => tool.name)).toEqual(expected);
    },
  );
});

describe("McpLoopbackToolCache", () => {
  it("does not let a source-less cached list hide a later admitted writer", async () => {
    const cache = new McpLoopbackToolCache();
    const params = scopeParams({ toolsAllow: ["sessions"] });
    const controller = new AbortController();
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "archive-writer",
      scopes: ["operator.write"],
      signal: controller.signal,
      assertCurrent: () => {},
    });
    const runId = "cached-session-controls";
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operatorAuthority: authority,
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "mcp-cache-test", state: "present" },
      },
    });
    resolveGatewayScopedTools.mockImplementation(
      ({ admittedRunContext }: Pick<ScopeParams, "admittedRunContext">) =>
        scopedToolFixture(readAdmittedRunOperatorAuthority(admittedRunContext) ? ["sessions"] : []),
    );
    try {
      const withoutSource = await cache.resolve(params);
      expect(withoutSource.toolSchema).toEqual([]);
      const admittedRunContext = await admission.admit("gateway");
      const writerParams = { ...params, admittedRunContext };
      const withSource = await cache.resolve(writerParams);
      expect(withSource.toolSchema.map((tool) => tool.name)).toEqual(["sessions"]);
      expect(resolveGatewayScopedTools.mock.calls[1]?.[0].admittedRunContext).toBe(
        admittedRunContext,
      );
      expect(resolveGatewayScopedTools.mock.calls[1]?.[0].senderIsOwner).toBe(false);
      expect(await cache.resolve(writerParams)).toBe(withSource);
      expect(await cache.resolve(params)).toBe(withoutSource);

      const reason = new Error("archive operator source revoked");
      controller.abort(reason);
      await expect(cache.resolve(writerParams)).rejects.toThrow(
        "admitted run operator authority is no longer active",
      );
      expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
    } finally {
      admission.close();
    }
  });

  it.each(["evict", "clear"])(
    "does not resurrect cache rows when %s overtakes discovery",
    async (action) => {
      const cache = new McpLoopbackToolCache();
      const params = scopeParams({ nodeExecAllowed: true, grantToken: "pending-grant" });
      const entered = createDeferred();
      const inventory = createDeferred<unknown[]>();
      listNodes.mockImplementationOnce(() => {
        entered.resolve();
        return inventory.promise;
      });
      const pending = cache.resolve(params);
      await entered.promise;
      if (action === "evict") {
        cache.evictGrant("pending-grant");
      } else {
        cache.clear();
      }
      inventory.resolve([]);
      await pending;
      expect(cache.evictGrant("pending-grant")).toBe(false);
      await cache.resolve(params);
      expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["discovery", "construction"] as const)(
    "does not cache tools when cancellation overtakes %s",
    async (stage) => {
      const cache = new McpLoopbackToolCache();
      const params = scopeParams({ nodeExecAllowed: true, grantToken: "cancelled-grant" });
      const controller = new AbortController();
      const reason = new Error("synthetic request cancelled");
      const entered = createDeferred();
      const resume = createDeferred();
      if (stage === "discovery") {
        listNodes.mockImplementationOnce(async () => {
          entered.resolve();
          await resume.promise;
          return [];
        });
      } else {
        resolveGatewayScopedTools.mockImplementationOnce(async () => {
          entered.resolve();
          await resume.promise;
          return scopedToolFixture(["memory_search"]);
        });
      }
      const rejected = expect(cache.resolve({ ...params, signal: controller.signal })).rejects.toBe(
        reason,
      );
      await entered.promise;
      expect(listNodes).toHaveBeenCalledWith(controller.signal);
      controller.abort(reason);
      resume.resolve();
      await rejected;
      expect(cache.evictGrant("cancelled-grant")).toBe(false);
      const next = new AbortController();
      await cache.resolve({ ...params, signal: next.signal });
      next.abort();
      await cache.resolve({ ...params, signal: new AbortController().signal });
      expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(stage === "discovery" ? 1 : 2);
      expect(resolveGatewayScopedTools.mock.calls[0]?.[0]).not.toHaveProperty("signal");
    },
  );

  it("refreshes cached bound tools when node display names change", async () => {
    const cache = new McpLoopbackToolCache();
    const params = scopeParams({ nodeExecAllowed: true, execOverrides: { node: "shared-name" } });
    resolveGatewayScopedTools.mockImplementation(({ nodeExecAvailable, execOverrides }) =>
      scopedToolFixture(nodeExecAvailable(execOverrides.node) ? ["exec"] : []),
    );
    for (const eligibleMatches of [false, true, false]) {
      listNodes.mockResolvedValue([
        {
          nodeId: "phone",
          displayName: eligibleMatches ? "other-name" : "shared-name",
          connected: true,
          commands: [],
        },
        {
          nodeId: "worker",
          displayName: eligibleMatches ? "shared-name" : "other-name",
          connected: true,
          commands: ["system.run"],
        },
      ]);
      const scoped = await cache.resolve(params);
      expect(scoped.tools.map((tool) => tool.name)).toEqual(eligibleMatches ? ["exec"] : []);
    }
  });

  it("does not share cache rows across different grant allowlists", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {};

    const unrestricted = await cache.resolve(scopeParams({ cfg }));
    const restricted = await cache.resolve(scopeParams({ cfg, toolsAllow: ["memory_search"] }));
    const denied = await cache.resolve(scopeParams({ cfg, toolsAllow: [] }));

    expect(unrestricted.tools.map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_get",
      "message",
      "cron",
    ]);
    expect(restricted.tools.map((tool) => tool.name)).toEqual(["memory_search"]);
    expect(denied.tools).toEqual([]);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);

    // Duplicate entries do not change the granted set.
    await cache.resolve(scopeParams({ cfg, toolsAllow: ["memory_search", "memory_search"] }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);
  });

  it("does not share loopback tools across prepared vision capabilities", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {};

    await cache.resolve(scopeParams({ cfg, modelHasVision: true }));
    await cache.resolve(scopeParams({ cfg, modelHasVision: false }));
    await cache.resolve(scopeParams({ cfg, modelHasVision: true }));

    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
    expect(resolveGatewayScopedTools.mock.calls[0]?.[0]).toMatchObject({
      modelHasVision: true,
    });
    expect(resolveGatewayScopedTools.mock.calls[1]?.[0]).toMatchObject({
      modelHasVision: false,
    });
  });

  it("keeps pinned widget authoring out of capless cached tool lists", async () => {
    const cache = new McpLoopbackToolCache();
    const params = scopeParams();
    resolveGatewayScopedTools.mockImplementation(({ pinnedWidgetAuthoring }) =>
      scopedToolFixture(pinnedWidgetAuthoring ? ["dashboard", "show_widget"] : ["dashboard"]),
    );

    for (const pinnedWidgetAuthoring of [true, undefined, true, false]) {
      const result = await cache.resolve({
        ...params,
        context: { ...params.context, pinnedWidgetAuthoring },
      });
      expect(result.tools.map((tool) => tool.name)).toEqual(
        pinnedWidgetAuthoring ? ["dashboard", "show_widget"] : ["dashboard"],
      );
    }
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
  });

  it("evicts only the revoked grant's cached tool closures", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {};

    await cache.resolve(scopeParams({ cfg, grantToken: "grant-a" }));
    await cache.resolve(scopeParams({ cfg, grantToken: "grant-b" }));
    await cache.resolve(scopeParams({ cfg, grantToken: "grant-a" }));
    await cache.resolve(scopeParams({ cfg, grantToken: "grant-b" }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);

    expect(cache.evictGrant("grant-a")).toBe(true);
    await cache.resolve(scopeParams({ cfg, grantToken: "grant-a" }));
    await cache.resolve(scopeParams({ cfg, grantToken: "grant-b" }));

    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);
  });
});

describe("MCP loopback Computer Use schema", () => {
  beforeEach(() => {
    resolveGatewayScopedTools.mockImplementation(({ cfg, pairedNodeComputerUse }) => {
      const computerDenied = cfg.tools?.deny?.includes("computer");
      return {
        agentId: "main",
        tools: computerDenied ? [] : [createComputerTool({ pairedNodeComputerUse })],
      };
    });
  });

  it("does not query node inventory when the grant excludes computer", async () => {
    const resolved = await new McpLoopbackToolCache().resolve(
      scopeParams({
        sessionKey: "agent:main:main",
        senderIsOwner: true,
        modelHasVision: true,
        toolsAllow: ["memory_search"],
      }),
    );

    expect(resolved.toolSchema.some((tool) => tool.name === "computer")).toBe(false);
    expect(listNodes).not.toHaveBeenCalled();
  });

  it("does not query node inventory when configured policy excludes computer", async () => {
    listNodes.mockImplementation(() => {
      throw new Error("node inventory must not be queried");
    });

    const resolved = await new McpLoopbackToolCache().resolve(
      scopeParams({
        cfg: { tools: { deny: ["computer"] } },
        sessionKey: "agent:main:main",
        senderIsOwner: true,
        modelHasVision: true,
      }),
    );

    expect(resolved.toolSchema.some((tool) => tool.name === "computer")).toBe(false);
    expect(listNodes).not.toHaveBeenCalled();
  });

  it("unions approved actions across distinct paired node identities", async () => {
    const cache = new McpLoopbackToolCache();
    const scope = scopeParams({
      cfg: { tools: { allow: ["computer"] } },
      sessionKey: "agent:main:main",
      senderIsOwner: true,
      modelHasVision: true,
    });
    listNodes.mockResolvedValue([
      computerNode("headless-windows-node", ["screenshot", "list_windows"]),
    ]);
    expect(readComputerActions(await cache.resolve(scope))).not.toContain("launch_app");

    listNodes.mockResolvedValue([
      computerNode("headless-windows-node", ["screenshot", "list_windows"]),
      computerNode("windows-companion-node", ["screenshot", "launch_app"]),
    ]);
    const resolved = await cache.resolve(scope);

    expect(readComputerActions(resolved)).toEqual(
      expect.arrayContaining(["screenshot", "list_windows", "launch_app", "wait"]),
    );
    expect(listNodes).toHaveBeenCalledTimes(2);
  });
});
