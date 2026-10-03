import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveGatewayStatusSummary } from "./status.gateway.js";

describe("resolveGatewayStatusSummary", () => {
  it("ignores non-string host and base path values from an invalid config", async () => {
    const daemonCfg = {
      gateway: { bind: "custom", customBindHost: 42, controlUi: { basePath: 42 } },
    } as unknown as OpenClawConfig;

    const summary = await resolveGatewayStatusSummary({
      daemonCfg,
      cliCfg: daemonCfg,
      mergedDaemonEnv: {},
      localPortOverride: 19001,
    });

    expect(summary.gateway.customBindHost).toBeUndefined();
    expect(summary.gateway.controlUiLinks?.httpUrl).toMatch(/^http:\/\/[^/]+:19001\/$/);
  });
});
