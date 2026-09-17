import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { createComputerTool } from "../agents/tools/computer-tool.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  McpLoopbackToolCache,
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "./mcp-http.runtime.js";
import { readMcpLoopbackToolName } from "./mcp-http.schema.js";

const resolveGatewayScopedTools = vi.hoisted(() => vi.fn());
const listNodes = vi.hoisted(() => vi.fn());
const nodeInvoke = vi.hoisted(() => vi.fn());

vi.mock("../agents/tools/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/tools/gateway.js")>();
  return {
    ...actual,
    callGatewayTool: async (
      method: string,
      _opts: unknown,
      args: unknown,
      options: { signal?: AbortSignal },
    ) => {
      if (method === "node.list") {
        return { nodes: await listNodes(options.signal) };
      }
      if (method === "computer.status") {
        return { configured: false, available: false };
      }
      if (method === "node.invoke") {
        return await nodeInvoke(args);
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    },
  };
});

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

type NodeInvokeRequest = {
  nodeId?: string;
  command?: string;
  params?: Record<string, unknown>;
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function readNodeInvokes(command: string): NodeInvokeRequest[] {
  return nodeInvoke.mock.calls
    .map((call) => call[0] as NodeInvokeRequest)
    .filter((request) => request.command === command);
}

function readSnapshotExecutionIds(): string[] {
  return readNodeInvokes("screen.snapshot").flatMap((request) => {
    const executionId = request.params?.executionId;
    return typeof executionId === "string" ? [executionId] : [];
  });
}

function readExecutionCloses(): Array<Record<string, unknown>> {
  return readNodeInvokes("computer.act")
    .map((request) => request.params ?? {})
    .filter((params) => params.action === "__close_execution");
}

function findLoopbackTool(
  resolved: Awaited<ReturnType<McpLoopbackToolCache["resolve"]>>,
  name: string,
) {
  const tool = resolved.tools.find((candidate) => readMcpLoopbackToolName(candidate) === name);
  if (!tool) {
    throw new Error(`missing loopback tool ${name}`);
  }
  return tool;
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
  nodeInvoke.mockReset();
  nodeInvoke.mockImplementation(async (request: NodeInvokeRequest) =>
    request.command === "screen.snapshot"
      ? {
          payload: {
            format: "png",
            base64: TINY_PNG_BASE64,
            displayFrameId: "display-0-frame",
            width: 1280,
            height: 800,
            screenIndex: 0,
          },
        }
      : { payload: { ok: true } },
  );
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
        await cache.clear();
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
      // Rows without a client grant build under the request's own signal; grant
      // rows share one build across requests (see the execution lifecycle below).
      const params = scopeParams({ nodeExecAllowed: true });
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
    resolveGatewayScopedTools.mockImplementation(
      ({ cfg, pairedNodeComputerUse, registerRunCleanup, computerExecutionId }) => {
        const computerDenied = cfg.tools?.deny?.includes("computer");
        return {
          agentId: "main",
          tools: computerDenied
            ? []
            : [
                createComputerTool({
                  pairedNodeComputerUse,
                  registerRunCleanup,
                  executionId: computerExecutionId,
                }),
              ],
        };
      },
    );
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

  describe("paired-node execution lifecycle", () => {
    const executionScope = (overrides: Partial<ScopeParams["context"]> = {}) =>
      scopeParams({
        cfg: { tools: { allow: ["computer"] } } as OpenClawConfig,
        grantToken: "grant-computer",
        sessionKey: "agent:main:main",
        senderIsOwner: true,
        modelHasVision: true,
        ...overrides,
      });

    beforeEach(() => {
      listNodes.mockResolvedValue([computerNode("headless-windows-node", ["screenshot"])]);
    });

    it("hands the tool builder a cleanup registrar and the grant's execution id", async () => {
      const cache = new McpLoopbackToolCache();
      await cache.resolve(executionScope());
      const first = resolveGatewayScopedTools.mock.lastCall?.[0];
      expect(first).toMatchObject({
        registerRunCleanup: expect.any(Function),
        computerExecutionId: expect.any(String),
      });

      await cache.resolve(executionScope({ sessionKey: "agent:main:other" }));
      const second = resolveGatewayScopedTools.mock.lastCall?.[0];
      expect(second?.computerExecutionId).toBe(first?.computerExecutionId);

      await cache.resolve(scopeParams({ cfg: {} as OpenClawConfig, grantToken: "grant-b" }));
      expect(resolveGatewayScopedTools.mock.lastCall?.[0].computerExecutionId).not.toBe(
        first?.computerExecutionId,
      );
    });

    it("closes the node execution with the run's outcome when the grant is revoked (#147420)", async () => {
      const cache = new McpLoopbackToolCache();
      const scope = executionScope();
      const first = await cache.resolve(scope);
      const computer = findLoopbackTool(first, "computer");
      await computer.execute("shot-1", { action: "screenshot" });
      const [executionId] = readSnapshotExecutionIds();
      expect(executionId).toEqual(expect.any(String));
      expect(readExecutionCloses()).toEqual([]);

      expect(cache.revokeGrant("grant-computer", "completion")).toBe(true);

      await vi.waitFor(() => {
        expect(readExecutionCloses()).toEqual([
          { action: "__close_execution", executionId, reason: "completion" },
        ]);
      });
      await expect(computer.execute("shot-after-close", { action: "screenshot" })).rejects.toThrow(
        "computer: execution is closed",
      );
      // A later run under a fresh grant starts its own execution.
      const next = await cache.resolve(scope);
      await findLoopbackTool(next, "computer").execute("shot-2", { action: "screenshot" });
      const executionIds = readSnapshotExecutionIds();
      expect(executionIds).toHaveLength(2);
      expect(executionIds[1]).not.toBe(executionId);
    });

    it.each(["cancel", "error", "timeout"] as const)(
      "passes a %s settlement to the node close unchanged",
      async (closeReason) => {
        const cache = new McpLoopbackToolCache();
        const resolved = await cache.resolve(executionScope());
        await findLoopbackTool(resolved, "computer").execute("shot-1", { action: "screenshot" });
        const [executionId] = readSnapshotExecutionIds();

        cache.revokeGrant("grant-computer", closeReason);

        await vi.waitFor(() => {
          expect(readExecutionCloses()).toEqual([
            { action: "__close_execution", executionId, reason: closeReason },
          ]);
        });
      },
    );

    it("keeps a grant's row and node execution across the schema-cache TTL", async () => {
      const cache = new McpLoopbackToolCache();
      const scope = executionScope();
      const first = await cache.resolve(scope);
      await findLoopbackTool(first, "computer").execute("shot-1", { action: "screenshot" });
      const [executionId] = readSnapshotExecutionIds();

      vi.useFakeTimers();
      vi.advanceTimersByTime(30_000);
      const second = await cache.resolve(scope);
      vi.useRealTimers();

      expect(second).toBe(first);
      await findLoopbackTool(second, "computer").execute("shot-2", { action: "screenshot" });
      expect(readSnapshotExecutionIds()).toEqual([executionId, executionId]);
      expect(readExecutionCloses()).toEqual([]);
    });

    it("replacing the grant's authority drops its rows but keeps the execution open", async () => {
      const cache = new McpLoopbackToolCache();
      const scope = executionScope();
      const first = await cache.resolve(scope);
      await findLoopbackTool(first, "computer").execute("shot-1", { action: "screenshot" });
      const [executionId] = readSnapshotExecutionIds();

      // Capture activation for the next turn replaces the authority behind the token.
      expect(cache.evictGrant("grant-computer")).toBe(true);
      const second = await cache.resolve(scope);

      expect(second).not.toBe(first);
      await findLoopbackTool(second, "computer").execute("shot-2", { action: "screenshot" });
      expect(readSnapshotExecutionIds()).toEqual([executionId, executionId]);
      expect(readExecutionCloses()).toEqual([]);

      cache.revokeGrant("grant-computer", "completion");
      await vi.waitFor(() => {
        expect(readExecutionCloses().length).toBeGreaterThan(0);
      });
      expect(
        readExecutionCloses().every(
          (close) => close.executionId === executionId && close.reason === "completion",
        ),
      ).toBe(true);
    });

    it("serves but does not publish a row whose authority was replaced mid-discovery", async () => {
      const cache = new McpLoopbackToolCache();
      const scope = executionScope();
      listNodes.mockImplementationOnce(async () => {
        cache.evictGrant("grant-computer");
        return [computerNode("headless-windows-node", ["screenshot"])];
      });
      const stale = await cache.resolve(scope);
      await findLoopbackTool(stale, "computer").execute("shot-1", { action: "screenshot" });
      const [executionId] = readSnapshotExecutionIds();
      const calls = resolveGatewayScopedTools.mock.calls.length;

      const fresh = await cache.resolve(scope);
      expect(fresh).not.toBe(stale);
      expect(resolveGatewayScopedTools.mock.calls.length).toBeGreaterThan(calls);

      cache.revokeGrant("grant-computer", "completion");
      await vi.waitFor(() => {
        expect(readExecutionCloses()).toContainEqual({
          action: "__close_execution",
          executionId,
          reason: "completion",
        });
      });
    });

    it("moves the execution to the successor token when the grant is transferred", async () => {
      const cache = new McpLoopbackToolCache();
      const first = await cache.resolve(executionScope());
      await findLoopbackTool(first, "computer").execute("shot-1", { action: "screenshot" });
      const [executionId] = readSnapshotExecutionIds();

      cache.transferGrant("grant-computer", "process-token");
      const successor = await cache.resolve(executionScope({}));
      expect(successor).not.toBe(first);
      const moved = await cache.resolve({ ...executionScope(), grantToken: "process-token" });
      await findLoopbackTool(moved, "computer").execute("shot-2", { action: "screenshot" });
      expect(readSnapshotExecutionIds()).toEqual([executionId, executionId]);
      expect(readExecutionCloses()).toEqual([]);

      cache.revokeGrant("process-token", "completion");
      await vi.waitFor(() => {
        expect(readExecutionCloses()).toContainEqual({
          action: "__close_execution",
          executionId,
          reason: "completion",
        });
      });
    });

    it("coalesces concurrent misses for one grant scope onto a single row", async () => {
      const cache = new McpLoopbackToolCache();
      const scope = executionScope();
      const entered = createDeferred();
      const inventory = createDeferred<unknown[]>();
      listNodes.mockImplementationOnce(() => {
        entered.resolve();
        return inventory.promise;
      });
      const first = cache.resolve(scope);
      await entered.promise;
      const second = cache.resolve(scope);
      inventory.resolve([computerNode("headless-windows-node", ["screenshot"])]);

      const [a, b] = await Promise.all([first, second]);
      expect(b).toBe(a);
      expect(listNodes).toHaveBeenCalledTimes(1);
    });

    it("builds its own row instead of joining a build the replaced authority started", async () => {
      const cache = new McpLoopbackToolCache();
      const scope = executionScope();
      const entered = createDeferred();
      const inventory = createDeferred<unknown[]>();
      listNodes.mockImplementationOnce(() => {
        entered.resolve();
        return inventory.promise;
      });
      const stale = cache.resolve(scope);
      await entered.promise;
      cache.evictGrant("grant-computer");
      const fresh = cache.resolve(scope);
      inventory.resolve([computerNode("headless-windows-node", ["screenshot"])]);

      const [a, b] = await Promise.all([stale, fresh]);
      expect(b).not.toBe(a);
      expect(listNodes).toHaveBeenCalledTimes(2);
      // Only the row built under the current authority is published.
      expect(await cache.resolve(scope)).toBe(b);
    });

    it.each(["starter", "joiner"] as const)(
      "rejects an aborted %s while shared discovery is pending and serves the other request",
      async (abortedRequest) => {
        const cache = new McpLoopbackToolCache();
        const scope = executionScope();
        const entered = createDeferred();
        const inventory = createDeferred<unknown[]>();
        listNodes.mockImplementationOnce(() => {
          entered.resolve();
          return inventory.promise;
        });
        const controller = new AbortController();
        const reason = new Error("synthetic request cancelled");
        const withSignal = (request: "starter" | "joiner") =>
          request === abortedRequest ? { ...scope, signal: controller.signal } : scope;
        const starter = cache.resolve(withSignal("starter"));
        await entered.promise;
        const joiner = cache.resolve(withSignal("joiner"));
        // Let the joiner reach the shared build before its request is cancelled.
        await nextEventLoopTurn();
        controller.abort(reason);

        // Discovery is still pending: the aborted request settles on its own signal.
        await expect(abortedRequest === "starter" ? starter : joiner).rejects.toBe(reason);
        inventory.resolve([computerNode("headless-windows-node", ["screenshot"])]);
        const row = await (abortedRequest === "starter" ? joiner : starter);
        expect(listNodes).toHaveBeenCalledTimes(1);
        expect(await cache.resolve(scope)).toBe(row);
      },
    );

    it("waits for a retired execution's close before serving a cached successor row", async () => {
      const cache = new McpLoopbackToolCache();
      const previous = await cache.resolve(executionScope());
      await findLoopbackTool(previous, "computer").execute("shot-1", { action: "screenshot" });
      // The successor listed its tools while the previous run was still active.
      const successorScope = executionScope({ sessionKey: "agent:main:successor" });
      const successor = await cache.resolve({ ...successorScope, grantToken: "grant-successor" });
      const closing = createDeferred<unknown>();
      nodeInvoke.mockImplementation((request: NodeInvokeRequest) =>
        request.params?.action === "__close_execution"
          ? closing.promise
          : { payload: { ok: true } },
      );

      expect(cache.revokeGrant("grant-computer", "completion")).toBe(true);
      const serving = cache.resolve({ ...successorScope, grantToken: "grant-successor" });
      const settled = vi.fn();
      void serving.then(settled, settled);
      await nextEventLoopTurn();
      expect(settled).not.toHaveBeenCalled();

      closing.resolve({ payload: { ok: true } });
      expect(await serving).toBe(successor);
    });

    it("closes a row the global cap pushed out when its grant ends", async () => {
      const cache = new McpLoopbackToolCache();
      const scope = executionScope();
      const first = await cache.resolve(scope);
      await findLoopbackTool(first, "computer").execute("shot-1", { action: "screenshot" });
      const [executionId] = readSnapshotExecutionIds();
      for (let index = 0; index < 256; index += 1) {
        await cache.resolve(executionScope({ currentMessageId: `message-${index}` }));
      }
      const rebuilt = await cache.resolve(scope);
      expect(rebuilt).not.toBe(first);
      await findLoopbackTool(rebuilt, "computer").execute("shot-2", { action: "screenshot" });
      expect(readSnapshotExecutionIds()).toEqual([executionId, executionId]);

      cache.revokeGrant("grant-computer", "completion");

      await vi.waitFor(() => {
        expect(readExecutionCloses().length).toBeGreaterThan(0);
      });
      expect(readExecutionCloses().every((close) => close.executionId === executionId)).toBe(true);
    });

    it("waits for closes already in flight when the cache is cleared", async () => {
      const cache = new McpLoopbackToolCache();
      const resolved = await cache.resolve(executionScope());
      await findLoopbackTool(resolved, "computer").execute("shot-1", { action: "screenshot" });
      const [executionId] = readSnapshotExecutionIds();

      // The loopback server revokes its grants, then clears the cache.
      expect(cache.revokeGrant("grant-computer", "completion")).toBe(true);
      await cache.clear();

      expect(readExecutionCloses()).toEqual([
        { action: "__close_execution", executionId, reason: "completion" },
      ]);
    });

    it("retires a row whose grant was revoked while it was still discovering nodes", async () => {
      const cache = new McpLoopbackToolCache();
      const closeReasons: string[] = [];
      const build = resolveGatewayScopedTools.getMockImplementation();
      resolveGatewayScopedTools.mockImplementation((params) => {
        params.registerRunCleanup?.(async (reason: string) => {
          closeReasons.push(reason);
        });
        return build?.(params) ?? scopedToolFixture([]);
      });
      listNodes.mockImplementationOnce(async () => {
        cache.revokeGrant("grant-computer", "completion");
        return [computerNode("headless-windows-node", ["screenshot"])];
      });

      const stale = await cache.resolve(executionScope());

      await expect(
        findLoopbackTool(stale, "computer").execute("shot-1", { action: "screenshot" }),
      ).rejects.toThrow("computer: execution is closed");
      expect(readSnapshotExecutionIds()).toEqual([]);
      // The row closes with the run's real settlement, not a made-up cancel.
      expect(closeReasons).toEqual(["completion"]);
    });

    it("keeps a row built during another grant's revocation reachable for its own cleanup", async () => {
      const cache = new McpLoopbackToolCache();
      listNodes.mockImplementationOnce(async () => {
        // Revocation of another grant lands while this row is still discovering nodes.
        cache.revokeGrant("grant-other", "completion");
        return [computerNode("headless-windows-node", ["screenshot"])];
      });
      const row = await cache.resolve(executionScope());
      await findLoopbackTool(row, "computer").execute("shot-1", { action: "screenshot" });
      const [executionId] = readSnapshotExecutionIds();
      expect(readExecutionCloses()).toEqual([]);

      cache.revokeGrant("grant-computer", "completion");

      await vi.waitFor(() => {
        expect(readExecutionCloses()).toEqual([
          { action: "__close_execution", executionId, reason: "completion" },
        ]);
      });
    });

    it("leaves rows without a client grant untracked and without a cleanup owner", async () => {
      const cache = new McpLoopbackToolCache();
      const cfg = { tools: { allow: ["computer"] } } as OpenClawConfig;
      const resolved = await cache.resolve({ ...executionScope(), cfg, grantToken: undefined });
      expect(resolveGatewayScopedTools.mock.lastCall?.[0]).toMatchObject({
        registerRunCleanup: undefined,
        computerExecutionId: undefined,
      });
      await findLoopbackTool(resolved, "computer").execute("shot-1", { action: "screenshot" });
      expect(readSnapshotExecutionIds()).toHaveLength(1);

      await cache.clear();

      expect(readExecutionCloses()).toEqual([]);
    });
  });
});
