import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import type { PortalSummary } from "../../../packages/gateway-protocol/src/index.js";
import * as security from "../../security/dangerous-tools.js";
import * as gateway from "./in-process-gateway.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createAvailablePortalTools } from "./portal-tool.js";

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
const localPortal: PortalSummary = {
  ...portal,
  publicUrl: "http://127.0.0.1:43123/",
  url: `http://127.0.0.1:43123/?${portal.tokenQuery}`,
  exposure: { kind: "loopback-only", browserReachability: "unverified" },
};
function recorder(summary: PortalSummary = portal) {
  const calls: Array<[string, unknown]> = [];
  const requestScopes: Array<readonly string[] | undefined> = [];
  async function call<T>(method: string, params: unknown): Promise<T> {
    calls.push([method, params]);
    return (
      method.endsWith(".list")
        ? { portals: [summary] }
        : method.endsWith(".close")
          ? { closed: true }
          : summary
    ) as T;
  }
  vi.spyOn(gateway, "callInProcessGatewayTool").mockImplementation(call);
  vi.spyOn(gateway, "callAgentToolGatewayRequest").mockImplementation(
    async <T>(request: Parameters<AgentToolGatewayRequestCaller>[0]): Promise<T> => {
      requestScopes.push(request.scopes);
      return call<T>(request.method, request.params ?? {});
    },
  );
  return { calls, requestScopes };
}

it.each(["host", "worker", "bound"] as const)(
  "routes %s portals without rewriting URLs",
  async (mode) => {
    const summary = mode === "worker" ? localPortal : portal;
    const recorded = recorder(summary);
    const bound = { sessionKey: "agent:main:p", agentId: "main", environmentId: "worker:p" };
    let current = true;
    const target = {
      ...bound,
      assertCurrent() {
        if (!current) {
          throw new Error("retired target");
        }
      },
    };
    const selected = createAvailablePortalTools({
      senderIsOwner: mode !== "bound",
      sessionPortalTarget: mode === "bound" ? target : undefined,
    })[0]!;
    const environment =
      mode === "bound" ? bound : mode === "worker" ? { environmentId: bound.environmentId } : {};
    const args = mode === "worker" ? { environmentId: bound.environmentId } : {};
    const open = { port: 3000, title: "App", description: "P", path: "/app" };
    const opened = await selected.execute("open", { action: "open", ...open, ...args });
    const listed = await selected.execute("list", { action: "list", ...args });
    const closed = await selected.execute("close", { action: "close", id: "p3000", ...args });
    const prefix = mode === "bound" ? "portal.session" : "portal";
    expect(recorded.calls).toEqual([
      [`${prefix}.open`, { ...environment, ...open }],
      [`${prefix}.list`, environment],
      [`${prefix}.close`, { ...environment, id: "p3000" }],
    ]);
    expect([opened.details, listed.details, closed.details]).toEqual([
      summary,
      { portals: [summary] },
      { closed: true },
    ]);
    expect(recorded.requestScopes).toEqual(mode === "bound" ? [] : [["operator.write"]]);
    for (const result of summary === localPortal ? [opened, listed] : [opened]) {
      expect(result.content[0]).toMatchObject({
        type: "text",
        text:
          summary === localPortal
            ? expect.stringMatching(/^Loopback-only portal:.*local use is still valid/u)
            : expect.stringContaining("remain unverified from the requesting viewer"),
      });
    }
    if (mode === "bound") {
      current = false;
      await expect(selected.execute("stale", { action: "open", port: 3000 })).rejects.toThrow(
        "retired target",
      );
      expect(recorded.calls).toHaveLength(3);
    }
  },
);

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
