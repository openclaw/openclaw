import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import type { PortalSummary } from "../../../packages/gateway-protocol/src/index.js";
import * as security from "../../security/dangerous-tools.js";
import * as gateway from "./in-process-gateway.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createAvailablePortalTools } from "./portal-tool.js";

type AgentToolGatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];
const tool = createAvailablePortalTools()[0]!;

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
  async function callGateway<T>(method: string, params: unknown): Promise<T> {
    calls.push([method, params]);
    return (
      ["portal.list", "portal.session.list"].includes(method)
        ? { portals: [summary] }
        : ["portal.close", "portal.session.close"].includes(method)
          ? { closed: true }
          : summary
    ) as T;
  }
  const callGatewayRequest = async <T>(request: AgentToolGatewayRequest): Promise<T> => {
    requestScopes.push([request.method, request.scopes]);
    return callGateway<T>(request.method, request.params ?? {});
  };
  vi.spyOn(gateway, "callInProcessGatewayTool").mockImplementation(callGateway);
  vi.spyOn(gateway, "callAgentToolGatewayRequest").mockImplementation(callGatewayRequest);
  return { calls, requestScopes };
}

it("keeps a restricted tool on its captured worker and refuses host or alternate target selection", async () => {
  const recorded = recorder();
  let current = true;
  const bound = {
    sessionKey: "agent:main:preview",
    agentId: "main",
    environmentId: "worker:preview",
  };
  const target = {
    ...bound,
    assertCurrent() {
      if (!current) {
        throw new Error("retired target");
      }
    },
  };
  const boundTool = createAvailablePortalTools({
    senderIsOwner: false,
    sessionPortalTarget: target,
  })[0]!;
  expect(boundTool.parameters).toEqual(tool.parameters);
  for (const action of ["open", "list", "close"]) {
    await boundTool.execute(action, { action, port: 3000, id: "p3000" });
  }
  expect(recorded.calls).toEqual([
    ["portal.session.open", { ...bound, port: 3000 }],
    ["portal.session.list", bound],
    ["portal.session.close", { ...bound, id: "p3000" }],
  ]);
  await expect(
    boundTool.execute("host", { action: "open", port: 3000, environmentId: "other" }),
  ).rejects.toThrow("bound");
  current = false;
  await expect(boundTool.execute("stale", { action: "open", port: 3000 })).rejects.toThrow(
    "retired target",
  );
  expect(recorded.calls).toHaveLength(3);
});
it("uses a flat closed action schema and owner-only security gate", () => {
  expect(tool.parameters).toMatchObject({
    additionalProperties: false,
    properties: { action: { enum: ["open", "list", "close"] } },
  });
  expect(Value.Check(tool.parameters, { action: "open", port: 3000, path: "/app" })).toBe(true);
  expect(Value.Check(tool.parameters, { action: "open", port: 0 })).toBe(false);
  expect(Value.Check(tool.parameters, { action: "open", port: 3000, path: "app" })).toBe(false);
  expect(Value.Check(tool.parameters, { action: "unknown" })).toBe(false);
  expect(security.GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("portal");
  expect(security.DEFAULT_GATEWAY_HTTP_TOOL_DENY).toContain("portal");
});

const localPortal: PortalSummary = {
  ...portal,
  publicUrl: "http://127.0.0.1:43123/",
  url: `http://127.0.0.1:43123/?${portal.tokenQuery}`,
  exposure: { kind: "loopback-only", browserReachability: "unverified" },
};
it.each([
  [undefined, portal],
  ["worker:preview", portal],
  [undefined, localPortal],
] as const)("routes portals on %s without rewriting URLs", async (environmentId, summary) => {
  const recorded = recorder(summary);
  const environment = environmentId ? { environmentId } : {};
  const openParams = { ...environment, port: 3000, title: "App", description: "P", path: "/app" };
  const opened = await tool.execute("open", { action: "open", ...openParams });
  const listed = await tool.execute("list", { action: "list", ...environment });
  const closed = await tool.execute("close", { action: "close", id: "p3000", ...environment });

  expect(recorded.calls).toEqual([
    ["portal.open", openParams],
    ["portal.list", environment],
    ["portal.close", { id: "p3000", ...environment }],
  ]);
  expect(opened.details).toEqual(summary);
  expect(listed.details).toEqual({ portals: [summary] });
  // Listing a bearer URL requires the authority that can mint it.
  expect(recorded.requestScopes).toEqual([["portal.list", ["operator.write"]]]);
  expect(closed.details).toEqual({ closed: true });
  for (const result of [opened, listed, closed]) {
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
  }
  for (const result of summary === localPortal ? [opened, listed] : [opened]) {
    expect(result.content[0]).toMatchObject({
      type: "text",
      text:
        summary === localPortal
          ? expect.stringMatching(/^Loopback-only portal:.*local use is still valid/u)
          : expect.stringContaining("remain unverified from the requesting viewer"),
    });
  }
});

it("rejects action-specific missing and malformed fields before RPC", async () => {
  const recorded = recorder();
  for (const [params, error] of [
    [{ action: "open" }, "port required"],
    [{ action: "open", port: 3000, path: "app" }, "path must start with /"],
    [{ action: "close" }, "id required"],
  ] as const) {
    await expect(tool.execute(params.action, params)).rejects.toThrow(error);
  }
  expect(recorded.calls).toEqual([]);
});
