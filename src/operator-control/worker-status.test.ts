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
          angelaHttp: {
            globalDefaultAlias: "tonys-angels",
          },
        },
      },
      teams: [
        {
          id: "marketing",
          dispatchTransport: "angela-http",
          lead: "tonys-angels",
          dispatchDefaultAlias: "tonys-angels",
        },
        {
          id: "engineering",
          dispatchTransport: "angela-http",
          lead: "bobby-digital",
          dispatchDefaultAlias: "bobby-digital",
        },
        {
          id: "project-ops",
          dispatchTransport: "deb-http",
          lead: "deb",
        },
      ],
    });
  });

  it("reports all angela-http domain orchestrators", async () => {
    const snapshot = await withEnvAsync(
      {
        OPENCLAW_OPERATOR_ANGELA_URL: "http://tonya.internal:18789",
        OPENCLAW_OPERATOR_ANGELA_SHARED_SECRET: "shared-secret",
      },
      async () => getOperatorDelegatedTransportStatus(),
    );

    expect(snapshot).toMatchObject({
      dispatchTransport: "angela-http",
      configured: true,
      baseUrl: "http://tonya.internal:18789",
      authConfigured: true,
      globalDefaultAlias: "tonys-angels",
      servedTeams: ["engineering", "marketing"],
      leadAliases: ["bobby-digital", "tonys-angels"],
      defaultAliasByTeam: {
        engineering: "bobby-digital",
        marketing: "tonys-angels",
      },
    });
  });
});
