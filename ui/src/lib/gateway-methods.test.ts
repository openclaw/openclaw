import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { canCallGatewayMethod } from "./gateway-methods.ts";

function snapshot(params: {
  connected?: boolean;
  methods?: string[];
  scopes?: string[];
  includeAuth?: boolean;
  includeScopes?: boolean;
}): ApplicationGatewaySnapshot {
  const connected = params.connected ?? true;
  return {
    client: connected ? ({} as ApplicationGatewaySnapshot["client"]) : null,
    phase: connected ? "connected" : "offline",
    offlineStable: !connected,
    hello: {
      auth:
        params.includeAuth === false
          ? undefined
          : {
              role: "operator",
              scopes:
                params.includeScopes === false ? undefined : (params.scopes ?? ["operator.admin"]),
            },
      features: params.methods === undefined ? {} : { methods: params.methods },
    } as ApplicationGatewaySnapshot["hello"],
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
}

describe("canCallGatewayMethod", () => {
  it.each([
    ["models.list", "operator.read", true],
    ["chat.metadata", "operator.read", true],
    ["chat.startup", "operator.read", true],
    ["chat.history", "operator.read", true],
    ["sessions.create", "operator.write", false],
    ["chat.send", "operator.write", false],
    ["config.get", "operator.admin", false],
  ] as const)("uses the server scope for %s", (method, requestedScope, allowed) => {
    expect(
      canCallGatewayMethod(
        snapshot({ methods: [method], scopes: ["operator.sessions.write"] }),
        method,
        requestedScope,
      ),
    ).toBe(allowed);
  });

  it.each([
    ["disconnected", { connected: false }],
    ["method unavailable", { methods: [], scopes: ["operator.admin"] }],
    ["scope insufficient", { methods: ["skills.update"], scopes: ["operator.write"] }],
    ["method catalog omitted", { scopes: ["operator.admin"] }],
    ["auth omitted", { methods: ["skills.update"], includeAuth: false }],
    ["scopes omitted", { methods: ["skills.update"], includeScopes: false }],
  ])("blocks %s calls", (_name, params) => {
    expect(canCallGatewayMethod(snapshot(params), "skills.update", "operator.admin")).toBe(false);
  });

  it("supports registered methods that are intentionally not advertised", () => {
    expect(
      canCallGatewayMethod(
        snapshot({ methods: [], scopes: ["operator.admin"] }),
        "config.openFile",
        "operator.admin",
        { requireAdvertisement: false },
      ),
    ).toBe(true);
  });
});
