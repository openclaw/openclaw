import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PortalCloseResult,
  PortalListResult,
  PortalSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../../security/dangerous-tools.js";
import * as gateway from "./in-process-gateway.js";
import type {
  AgentToolGatewayRequestCaller,
  InProcessGatewayCaller,
} from "./in-process-gateway.js";
import { createAvailablePortalTools } from "./portal-tool.js";

type AgentToolGatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];

afterEach(() => vi.restoreAllMocks());

const portal: PortalSummary = {
  id: "p3000",
  title: "App",
  port: 3000,
  listenPort: 43123,
  tokenQuery: `openclaw_portal=${"a".repeat(64)}`,
  url: `https://preview.example.test:8443/app?view=one%2Ftwo&openclaw_portal=${"a".repeat(64)}`,
  publicUrl: "https://preview.example.test:8443/app?view=one%2Ftwo",
  exposure: { kind: "non-loopback", browserReachability: "unverified" },
  createdAtMs: 1,
};

function recorder(summary: PortalSummary = portal) {
  const calls: Array<[string, unknown]> = [];
  const requestScopes: Array<[string, readonly string[] | undefined]> = [];
  const reply = (method: string) => {
    if (method === "portal.list" || method === "portal.session.list") {
      return { portals: [summary] } as PortalListResult;
    }
    if (method === "portal.close" || method === "portal.session.close") {
      return { closed: true } as PortalCloseResult;
    }
    return summary;
  };
  const callGateway: InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    calls.push([method, params]);
    return reply(method) as T;
  };
  const callGatewayRequest: AgentToolGatewayRequestCaller = async <T>(
    request: AgentToolGatewayRequest,
  ): Promise<T> => {
    calls.push([request.method, request.params ?? {}]);
    requestScopes.push([request.method, request.scopes]);
    return reply(request.method) as T;
  };
  vi.spyOn(gateway, "callInProcessGatewayTool").mockImplementation(callGateway);
  vi.spyOn(gateway, "callAgentToolGatewayRequest").mockImplementation(callGatewayRequest);
  return { calls, requestScopes };
}

describe("portal tool", () => {
  it("keeps a restricted tool on its captured worker and refuses host or alternate target selection", async () => {
    const recorded = recorder();
    let current = true;
    const target = {
      sessionKey: "agent:main:preview",
      agentId: "main",
      environmentId: "worker:preview",
      assertCurrent() {
        if (!current) {
          throw new Error("retired target");
        }
      },
    };
    const tool = createAvailablePortalTools({
      senderIsOwner: false,
      sessionPortalTarget: target,
    })[0]!;
    // The session target keeps the host definition so the prompt prefix stays stable;
    // the bound target refuses host or alternate selection when the call runs.
    expect(tool.parameters).toEqual(createAvailablePortalTools()[0]!.parameters);
    for (const action of ["open", "list", "close"]) {
      await tool.execute(action, { action, port: 3000, id: "p3000" });
    }
    const bound = {
      sessionKey: target.sessionKey,
      agentId: target.agentId,
      environmentId: target.environmentId,
    };
    expect(recorded.calls).toEqual([
      ["portal.session.open", { ...bound, port: 3000 }],
      ["portal.session.list", bound],
      ["portal.session.close", { ...bound, id: "p3000" }],
    ]);
    await expect(
      tool.execute("host", { action: "open", port: 3000, environmentId: "other" }),
    ).rejects.toThrow("bound");
    current = false;
    await expect(tool.execute("stale", { action: "open", port: 3000 })).rejects.toThrow(
      "retired target",
    );
    expect(recorded.calls).toHaveLength(3);
  });
  it("uses a flat closed action schema and owner-only security gate", () => {
    const tool = createAvailablePortalTools()[0]!;
    expect(tool.parameters).toMatchObject({
      additionalProperties: false,
      properties: { action: { enum: ["open", "list", "close"] } },
    });
    expect(Value.Check(tool.parameters, { action: "open", port: 3000, path: "/app" })).toBe(true);
    expect(Value.Check(tool.parameters, { action: "open", port: 0 })).toBe(false);
    expect(Value.Check(tool.parameters, { action: "open", port: 3000, path: "app" })).toBe(false);
    expect(Value.Check(tool.parameters, { action: "unknown" })).toBe(false);
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("portal");
    expect(DEFAULT_GATEWAY_HTTP_TOOL_DENY).toContain("portal");
  });

  it("maps open, list, and close through the in-process gateway caller", async () => {
    const recorded = recorder();
    const tool = createAvailablePortalTools()[0]!;
    const opened = await tool.execute("open", {
      action: "open",
      port: 3000,
      title: "App",
      description: "Preview",
      path: "/app",
    });
    const listed = await tool.execute("list", { action: "list" });
    const closed = await tool.execute("close", { action: "close", id: "p3000" });

    expect(recorded.calls).toEqual([
      ["portal.open", { port: 3000, title: "App", description: "Preview", path: "/app" }],
      ["portal.list", {}],
      ["portal.close", { id: "p3000" }],
    ]);
    expect(opened.details).toEqual(portal);
    expect(opened.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("remain unverified from the requesting viewer"),
    });
    expect(listed.details).toEqual({ portals: [portal] });
    // Listing asks for write scope so the bearer URL is not redacted away from a
    // caller that can mint the same portal through action=open.
    expect(recorded.requestScopes).toEqual([["portal.list", ["operator.write"]]]);
    expect((listed.details as PortalListResult).portals[0]?.url).toBe(portal.url);
    expect(closed.details).toEqual({ closed: true });
    expect(Value.Check(tool.outputSchema!, opened.details)).toBe(true);
    expect(Value.Check(tool.outputSchema!, listed.details)).toBe(true);
    expect(Value.Check(tool.outputSchema!, closed.details)).toBe(true);
  });

  it("warns before loopback launch instructions without refusing local use or rewriting URLs", async () => {
    const localPortal: PortalSummary = {
      ...portal,
      publicUrl: "http://127.0.0.1:43123/",
      url: `http://127.0.0.1:43123/?${portal.tokenQuery}`,
      exposure: { kind: "loopback-only", browserReachability: "unverified" },
    };
    recorder(localPortal);
    const tool = createAvailablePortalTools()[0]!;
    for (const action of ["open", "list"]) {
      const result = await tool.execute(action, { action, port: 3000 });
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/^Loopback-only portal:.*local use is still valid/u),
      });
      expect(result.details).toEqual(action === "open" ? localPortal : { portals: [localPortal] });
    }
  });

  it("keeps attached-environment portal operations on the selected machine", async () => {
    const recorded = recorder();
    const tool = createAvailablePortalTools()[0]!;
    await tool.execute("open", { action: "open", port: 3000, environmentId: "worker:preview" });
    await tool.execute("list", { action: "list", environmentId: "worker:preview" });
    await tool.execute("close", {
      action: "close",
      id: portal.id,
      environmentId: "worker:preview",
    });
    expect(recorded.calls).toEqual([
      ["portal.open", { port: 3000, environmentId: "worker:preview" }],
      ["portal.list", { environmentId: "worker:preview" }],
      ["portal.close", { id: portal.id, environmentId: "worker:preview" }],
    ]);
  });

  it("rejects action-specific missing and malformed fields before RPC", async () => {
    const recorded = recorder();
    const tool = createAvailablePortalTools()[0]!;

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow("port required");
    await expect(tool.execute("open", { action: "open", port: 3000, path: "app" })).rejects.toThrow(
      "path must start with /",
    );
    await expect(tool.execute("close", { action: "close" })).rejects.toThrow("id required");
    expect(recorded.calls).toEqual([]);
  });
});
