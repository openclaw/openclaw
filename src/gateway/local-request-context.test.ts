/**
 * Local gateway request-context tests.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayAuthorizationRuntime } from "./authorization/contracts.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { dispatchGatewayMethodInProcessRaw } from "./server-plugins.js";

describe("local gateway request context", () => {
  let response: Awaited<ReturnType<typeof dispatchGatewayMethodInProcessRaw>>;
  let authorization: GatewayAuthorizationRuntime | undefined;

  beforeAll(async () => {
    const cfg = {
      agents: {
        defaults: {},
      },
    } as OpenClawConfig;

    response = await withLocalGatewayRequestScope(
      {
        deps: {} as CliDeps,
        getRuntimeConfig: () => cfg,
      },
      () => {
        authorization = getPluginRuntimeGatewayRequestScope()?.context?.authorization;
        return dispatchGatewayMethodInProcessRaw("agent.identity.get", {
          agentId: "main",
        });
      },
    );
  });

  it("lets embedded local runs dispatch gateway methods in-process", () => {
    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({ agentId: "main" });
  });

  it("keeps embedded local authorization explicitly dormant", () => {
    expect(authorization).toEqual({ mode: "legacy" });
  });
});
