import { assert, expect, it, type Mock } from "vitest";
import { setTestEnvValue } from "../../test-utils/env.js";
import type { gatherDaemonStatus } from "./status.gather.js";
import {
  callGatewayStatusProbe,
  inspectGatewayTlsCertificate,
} from "./status.gather.probes.test-support.js";

export function registerStatusDashboardTargetTests(params: {
  gatherStatus: (
    overrides?: Partial<Parameters<typeof gatherDaemonStatus>[0]>,
  ) => ReturnType<typeof gatherDaemonStatus>;
  setDaemonConfig: (config: Record<string, unknown>) => void;
  resolveGatewayPort: Mock<(cfg?: unknown, env?: unknown) => number>;
  resolveGatewayBindHost: { mockResolvedValueOnce(host: string): unknown };
  serviceReadCommand: {
    mockResolvedValueOnce(command: {
      programArguments: string[];
      environment?: Record<string, string>;
    }): unknown;
  };
  daemonEnvironment: Record<string, string>;
}): void {
  it.each([
    { args: ["--port", "19001"], port: 19002, role: "diagnostic-only" },
    { args: [], port: 19002, role: "diagnostic-only" },
    { args: ["--port", "19001"], port: 19001, role: "target" },
    { args: ["--port", "19001"], port: 19001, role: "target", host: "10.0.0.5", tls: true },
    { args: ["--port", "19001"], port: 19001, role: "target", host: "10.0.0.5", tls: false },
    { args: ["--port", "19001"], port: 19001, role: "target", host: "10.0.0.5", tls: "unreadable" },
    {
      args: ["--port", "19001"],
      port: 19001,
      role: "diagnostic-only",
      host: "10.0.0.9",
      tls: true,
    },
  ])(
    "probes the dashboard port $port on $host (tls $tls) with installed args $args ($role)",
    async ({ args, port, role, host, tls }) => {
      const gateway = { port: 19001, auth: { token: "daemon-token" } };
      // With a host: a custom bind to 10.0.0.5, so only that host is the service's endpoint.
      params.setDaemonConfig({
        gateway: host
          ? {
              ...gateway,
              bind: "custom",
              customBindHost: "10.0.0.5",
              tls: { enabled: tls !== false },
            }
          : gateway,
      });
      if (tls === "unreadable") {
        inspectGatewayTlsCertificate.mockResolvedValueOnce({ ok: false, error: "unreadable" });
      }
      if (host) {
        params.resolveGatewayBindHost.mockResolvedValueOnce("10.0.0.5");
      }
      setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));
      params.resolveGatewayPort.mockImplementationOnce((cfg, env) => {
        const configPort = (cfg as { gateway?: { port?: number } }).gateway?.port;
        const envPort = (env as NodeJS.ProcessEnv).OPENCLAW_GATEWAY_PORT;
        return envPort ? Number(envPort) : (configPort ?? 18789);
      });
      params.serviceReadCommand.mockResolvedValueOnce({
        programArguments: ["/bin/node", "cli", "gateway", "run", ...args],
        environment: params.daemonEnvironment,
      });

      const probeUrl = host ? `${tls ? "wss" : "ws"}://${host}:${port}` : "ws://127.0.0.1:" + port;
      const status = await params.gatherStatus({ dashboardTarget: { port, probeUrl } });

      const input = callGatewayStatusProbe.mock.calls[0]?.[0];
      assert(input, "expected status probe");
      expect(status.rpc?.url).toBe(probeUrl);
      expect(status.service.targetRole).toBe(role);
      expect(input.url).toBe(probeUrl);
      // Off loopback, only the local certificate pin lets the probe borrow service credentials.
      const native = role === "target" && (!host || tls === true);
      expect(input.token).toBe(native ? "daemon-token" : undefined);
      expect(input.tlsFingerprint).toBe(native && host ? "sha256:11:22:33:44" : undefined);
    },
  );
}
