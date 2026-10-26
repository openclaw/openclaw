import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  readAdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { createComputerTool } from "../agents/tools/computer-tool.js";
import * as mcp from "./mcp-http-request.test-support.js";
import {
  McpLoopbackToolCache as ToolCache,
  resolveMcpLoopbackPolicyTools as resolvePolicy,
  resolveMcpLoopbackScopedTools as resolveExact,
} from "./mcp-http.runtime.js";

const resolveGatewayScopedTools = vi.hoisted(() => vi.fn());
const listNodes = vi.hoisted(() => vi.fn());

vi.mock("../agents/tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/tools/gateway.js")>()),
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
  return { agentId: "main", tools: names.map((name) => ({ name, description: `${name} tool` })) };
}

const toolNames = (resolved: { tools: { name?: string }[] }) =>
  resolved.tools.map((tool) => tool.name);

function computerNode(nodeId: string, actions: string[]) {
  return {
    nodeId,
    connected: true,
    commands: ["screen.snapshot", "computer.act"],
    computerUse: {
      contractVersion: 2,
      provider: { id: "cua-driver", label: "CUA Driver", generation: `${nodeId}-generation` },
      actions,
      targets: ["screen", "window"],
      deliveryModes: ["foreground"],
      observations: ["image", "accessibility"],
      features: { recording: false, agentCursor: false, multiDisplay: false },
    },
  };
}

function readComputerActions(
  resolved: Awaited<ReturnType<ToolCache["resolve"]>>,
): string[] | undefined {
  const computer = resolved.toolSchema.find((tool) => tool.name === "computer");
  expect(computer).toBeDefined();
  return (computer?.inputSchema.properties as { action?: { enum?: string[] } } | undefined)?.action
    ?.enum;
}

type ScopeParams = Parameters<typeof resolveExact>[0];

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
  listNodes.mockReset().mockResolvedValue([]);
  resolveGatewayScopedTools
    .mockReset()
    .mockReturnValue(scopedToolFixture(["memory_search", "memory_get", "message", "cron"]));
});

describe("resolveMcpLoopbackScopedTools", () => {
  it("mediates an explicit wildcard policy while an omitted cap keeps native coding ownership", async () => {
    resolveGatewayScopedTools.mockReturnValue(scopedToolFixture(["read", "exec", "message"]));

    await resolvePolicy(scopeParams({ toolsAllow: ["*"] }));
    const wildcard = resolveGatewayScopedTools.mock.calls.at(-1)?.[0];
    expect(new Set(wildcard?.mediatedToolNames)).toContain("read");
    expect(new Set(wildcard?.mediatedToolNames)).toContain("exec");
    expect(new Set(wildcard?.excludeToolNames)).not.toContain("read");

    await resolvePolicy(scopeParams({}));
    const uncapped = resolveGatewayScopedTools.mock.calls.at(-1)?.[0];
    expect(new Set(uncapped?.mediatedToolNames)).toEqual(new Set());
    expect(new Set(uncapped?.excludeToolNames)).toContain("read");
  });

  it.each([
    { mode: "exact", allow: ["write"], expected: ["write"] },
    { mode: "policy", allow: ["write"], expected: ["write", "apply_patch"] },
    { mode: "policy", allow: [] as string[], expected: [] },
  ])(
    "resolves $mode names without confusing grants and policy: $allow",
    async ({ mode, allow, expected }) => {
      const exact = mode === "exact";
      resolveGatewayScopedTools.mockReturnValue(
        scopedToolFixture(
          exact ? ["write", "apply_patch"] : ["read", "write", "apply_patch", "message"],
        ),
      );
      const resolve = exact ? resolveExact : resolvePolicy;
      const scoped = await resolve(
        scopeParams({ toolsAllow: allow, nodeExecAllowed: exact || undefined }),
      );
      expect(toolNames(scoped)).toEqual(expected);
    },
  );
});

describe("McpLoopbackToolCache", () => {
  let cache: ToolCache;
  beforeEach(() => {
    cache = new ToolCache();
  });
  it("does not let a source-less cached list hide a later admitted writer", async () => {
    const params = scopeParams({ toolsAllow: ["sessions"] });
    const controller = new AbortController();
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "archive-writer",
      scopes: ["operator.write"],
      signal: controller.signal,
      assertCurrent: () => {},
    });
    const admission = mcp.prepareAdmission("cached-session-controls", "mcp-cache-test", {
      operatorAuthority: authority,
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

  it.each([
    { action: "evict", stage: "discovery" },
    { action: "clear", stage: "discovery" },
    { action: "abort", stage: "discovery" },
    { action: "abort", stage: "construction" },
  ])("does not cache tools when $action overtakes $stage", async ({ action, stage }) => {
    const params = scopeParams({ nodeExecAllowed: true, grantToken: "pending-grant" });
    const controller = new AbortController();
    const reason = new Error("synthetic request cancelled");
    const entered = createDeferred();
    const resume = createDeferred();
    const pause = async <T>(value: T) => {
      entered.resolve();
      await resume.promise;
      return value;
    };
    if (stage === "discovery") {
      listNodes.mockImplementationOnce(() => pause([]));
    } else {
      resolveGatewayScopedTools.mockImplementationOnce(() =>
        pause(scopedToolFixture(["memory_search"])),
      );
    }
    const pending = cache.resolve(
      action === "abort" ? { ...params, signal: controller.signal } : params,
    );
    const settled = action === "abort" ? expect(pending).rejects.toBe(reason) : pending;
    await entered.promise;
    if (action === "abort") {
      controller.abort(reason);
    } else if (action === "evict") {
      cache.evictGrant("pending-grant");
    } else {
      cache.clear();
    }
    resume.resolve();
    await settled;
    expect(cache.evictGrant("pending-grant")).toBe(false);
    if (action === "abort") {
      const next = new AbortController();
      await cache.resolve({ ...params, signal: next.signal });
      next.abort();
      await cache.resolve({ ...params, signal: new AbortController().signal });
    } else {
      await cache.resolve(params);
    }
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(
      action === "abort" && stage === "discovery" ? 1 : 2,
    );
  });

  it("refreshes cached bound tools when node display names change", async () => {
    const params = scopeParams({ nodeExecAllowed: true, execOverrides: { node: "shared-name" } });
    resolveGatewayScopedTools.mockImplementation(({ nodeExecAvailable, execOverrides }) =>
      scopedToolFixture(nodeExecAvailable(execOverrides.node) ? ["exec"] : []),
    );
    for (const eligibleMatches of [false, true, false]) {
      listNodes.mockResolvedValue(
        ["phone", "worker"].map((nodeId) => ({
          nodeId,
          displayName: eligibleMatches === (nodeId === "worker") ? "shared-name" : "other-name",
          connected: true,
          commands: nodeId === "worker" ? ["system.run"] : [],
        })),
      );
      const scoped = await cache.resolve(params);
      expect(toolNames(scoped)).toEqual(eligibleMatches ? ["exec"] : []);
    }
  });

  it("does not share cache rows across different grant allowlists", async () => {
    const cfg = {};

    const unrestricted = await cache.resolve(scopeParams({ cfg }));
    const restricted = await cache.resolve(scopeParams({ cfg, toolsAllow: ["memory_search"] }));
    const denied = await cache.resolve(scopeParams({ cfg, toolsAllow: [] }));

    expect(toolNames(unrestricted)).toEqual(["memory_search", "memory_get", "message", "cron"]);
    expect(toolNames(restricted)).toEqual(["memory_search"]);
    expect(denied.tools).toEqual([]);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);

    // Duplicate entries do not change the granted set.
    await cache.resolve(scopeParams({ cfg, toolsAllow: ["memory_search", "memory_search"] }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);
  });

  it.each(["modelHasVision", "pinnedWidgetAuthoring"] as const)(
    "keys cached tools by %s, normalizing only equivalent capabilities",
    async (property) => {
      const params = scopeParams();
      const widget = property === "pinnedWidgetAuthoring";
      if (widget) {
        resolveGatewayScopedTools.mockImplementation(({ pinnedWidgetAuthoring }) =>
          scopedToolFixture(pinnedWidgetAuthoring ? ["dashboard", "show_widget"] : ["dashboard"]),
        );
      }
      for (const value of widget ? [true, undefined, true, false] : [true, false, true]) {
        const result = await cache.resolve({
          ...params,
          context: { ...params.context, [property]: value },
        });
        if (widget) {
          expect(toolNames(result)).toEqual(value ? ["dashboard", "show_widget"] : ["dashboard"]);
        }
      }
      expect(resolveGatewayScopedTools.mock.calls.map(([options]) => options[property])).toEqual([
        true,
        widget ? undefined : false,
      ]);
    },
  );

  it("evicts only the revoked grant's cached tool closures", async () => {
    const cfg = {};

    for (const grantToken of ["grant-a", "grant-b", "grant-a", "grant-b"]) {
      await cache.resolve(scopeParams({ cfg, grantToken }));
    }
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

  it.each([
    { boundary: "grant", toolsAllow: ["memory_search"] },
    { boundary: "configured policy", cfg: { tools: { deny: ["computer"] } } },
  ])(
    "does not query node inventory when $boundary excludes computer",
    async ({ boundary: _boundary, ...policy }) => {
      listNodes.mockImplementation(() => {
        throw new Error("node inventory must not be queried");
      });

      const resolved = await new ToolCache().resolve(
        scopeParams({
          ...policy,
          sessionKey: "agent:main:main",
          senderIsOwner: true,
          modelHasVision: true,
        }),
      );

      expect(resolved.toolSchema.some((tool) => tool.name === "computer")).toBe(false);
      expect(listNodes).not.toHaveBeenCalled();
    },
  );

  it("unions approved actions across distinct paired node identities", async () => {
    const cache = new ToolCache();
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
