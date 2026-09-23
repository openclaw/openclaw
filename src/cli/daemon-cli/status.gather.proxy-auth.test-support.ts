import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { REDACTED_SENTINEL } from "../../config/redact-sentinel.js";
import { setTestEnvValue } from "../../test-utils/env.js";
import type { gatherDaemonStatus } from "./status.gather.js";
import {
  callGatewayStatusProbe,
  capturePrintedDaemonStatus,
} from "./status.gather.probes.test-support.js";

export function registerProxyAuthStatusTests(params: {
  setDaemonConfig: (config: Record<string, unknown>) => void;
  gatherStatus: (
    overrides?: Partial<Parameters<typeof gatherDaemonStatus>[0]>,
  ) => ReturnType<typeof gatherDaemonStatus>;
  serviceReadCommand: {
    mockResolvedValueOnce(command: {
      programArguments: string[];
      environment?: Record<string, string>;
    }): unknown;
  };
}): void {
  const { gatherStatus, serviceReadCommand } = params;
  it.each(["configured", "environment"] as const)(
    "uses the trusted-proxy local-direct password from %s",
    async (source) => {
      params.setDaemonConfig({
        gateway: {
          bind: "loopback",
          auth: {
            mode: "trusted-proxy",
            ...(source === "configured" ? { password: "local-config-password" } : {}),
          },
          remote: { url: "wss://peer.example", password: "peer-password" },
        },
      });
      serviceReadCommand.mockResolvedValueOnce({
        programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
        environment: {
          OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
          OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
          OPENCLAW_GATEWAY_PASSWORD: "local-service-password",
        },
      });
      setTestEnvValue("OPENCLAW_GATEWAY_PASSWORD", "ambient-password");

      await gatherStatus();

      const input = expectDefined(callGatewayStatusProbe.mock.calls[0]?.[0], "status probe call");
      expect(input.password).toBe(
        source === "configured" ? "local-config-password" : "local-service-password",
      );
      expect(input.token).toBeUndefined();
      expect(input.urlOverride).toBeUndefined();
      expect(input.config?.gateway?.auth).toEqual({ mode: "trusted-proxy" });
      expect(input.config?.gateway?.remote?.password).toBeUndefined();
    },
  );

  it.each(["configured", "environment"] as const)(
    "records a redacted optional proxy password from %s even when the probe succeeds",
    async (source) => {
      params.setDaemonConfig({
        gateway: {
          auth: {
            mode: "trusted-proxy",
            ...(source === "configured" ? { password: REDACTED_SENTINEL } : {}),
          },
        },
      });
      if (source === "environment") {
        setTestEnvValue("OPENCLAW_GATEWAY_PASSWORD", REDACTED_SENTINEL);
      }
      callGatewayStatusProbe.mockResolvedValueOnce({ ok: true, url: "ws://127.0.0.1:19001" });
      const status = await gatherStatus({ deep: true });
      expect(status.rpc?.ok).toBe(true);
      expect(status.rpc?.authWarning).toContain("local password fallback");
      const input = expectDefined(callGatewayStatusProbe.mock.calls[0]?.[0], "status probe call");
      expect(input.password).toBeUndefined();
      expect(capturePrintedDaemonStatus(status, { json: false, deep: true }).errors).toContain(
        "redaction sentinel",
      );
    },
  );
}
