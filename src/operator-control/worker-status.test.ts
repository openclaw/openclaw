import { beforeEach, describe, expect, it, vi } from "vitest";

const compileOperatorAgentRegistryMock = vi.hoisted(() => vi.fn());

vi.mock("./agent-registry.js", () => ({
  compileOperatorAgentRegistry: compileOperatorAgentRegistryMock,
}));

import { withEnvAsync } from "../test-utils/env.js";
import { getOperatorDelegatedTransportStatus } from "./worker-status.js";

describe("operator worker status", () => {
  beforeEach(() => {
    compileOperatorAgentRegistryMock.mockReset();
    compileOperatorAgentRegistryMock.mockReturnValue({
      operatorRuntime: {
        transports: {
          delegatedHttp: {
            globalDefaultAlias: "angela",
          },
        },
      },
      teams: [
        {
          id: "marketing",
          dispatchTransport: "angela-http",
          lead: "angela",
          dispatchDefaultAlias: "angela",
          dispatchEndpointEnv: "OPENCLAW_MARKETING_GATEWAY_URL",
          dispatchAuthEnv: "OPENCLAW_MARKETING_GATEWAY_SECRET",
          dispatchPath: "/api/message",
        },
        {
          id: "engineering",
          dispatchTransport: "angela-http",
          lead: "bobby-digital",
          dispatchDefaultAlias: "bobby-digital",
          dispatchEndpointEnv: "OPENCLAW_ENGINEERING_GATEWAY_URL",
          dispatchAuthEnv: "OPENCLAW_ENGINEERING_GATEWAY_SECRET",
          dispatchPath: "/delegated/tasks",
        },
        {
          id: "project-ops",
          dispatchTransport: "deb-http",
          lead: "deb",
        },
        {
          id: "execution-fleet",
          dispatchTransport: "2tony-http",
          lead: "raekwon",
        },
      ],
    });
  });

  it("reports all delegated first-class-agent teams", async () => {
    const snapshot = await withEnvAsync(
      {
        OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL: "http://tonya.internal:18789",
        OPENCLAW_OPERATOR_INTERNAL_CONTROL_SHARED_SECRET: "shared-secret",
        OPENCLAW_ENGINEERING_GATEWAY_URL: "http://gateway-k8s.internal:18789",
        OPENCLAW_ENGINEERING_GATEWAY_SECRET: "eng-secret",
      },
      async () => getOperatorDelegatedTransportStatus(),
    );

    expect(snapshot).toMatchObject({
      dispatchTransport: "delegated-http",
      transportAliases: ["angela-http"],
      role: "delegated-lead-boundary",
      configured: true,
      baseUrl: "http://tonya.internal:18789",
      authConfigured: true,
      globalDefaultAlias: "angela",
      servedTeams: ["engineering", "marketing"],
      leadAliases: ["angela", "bobby-digital"],
      defaultAliasByTeam: {
        engineering: "bobby-digital",
        marketing: "angela",
      },
      legacyTeams: ["execution-fleet"],
    });
    expect(snapshot.teamTopology).toEqual([
      {
        teamId: "engineering",
        declaredTransport: "angela-http",
        resolvedTransport: "delegated-http",
        leadAlias: "bobby-digital",
        defaultAlias: "bobby-digital",
        dispatchEndpointEnv: "OPENCLAW_ENGINEERING_GATEWAY_URL",
        dispatchPath: "/delegated/tasks",
        dispatchAuthEnv: "OPENCLAW_ENGINEERING_GATEWAY_SECRET",
        resolvedBaseUrl: "http://gateway-k8s.internal:18789",
        resolvedEndpoint: "http://gateway-k8s.internal:18789/delegated/tasks",
        authConfigured: true,
      },
      {
        teamId: "marketing",
        declaredTransport: "angela-http",
        resolvedTransport: "delegated-http",
        leadAlias: "angela",
        defaultAlias: "angela",
        dispatchEndpointEnv: "OPENCLAW_MARKETING_GATEWAY_URL",
        dispatchPath: "/api/message",
        dispatchAuthEnv: "OPENCLAW_MARKETING_GATEWAY_SECRET",
        resolvedBaseUrl: "http://tonya.internal:18789",
        resolvedEndpoint: "http://tonya.internal:18789/api/message",
        authConfigured: true,
      },
    ]);
  });
});
