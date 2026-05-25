import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { SecurityFinding } from "./types.js";

const execAsync = promisify(exec);

export async function auditNetwork(): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  try {
    const { stdout: ssOutput } = await execAsync(
      "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo ''",
    );
    const lines = ssOutput.split("\n");

    const gatewayPorts = new Set<number>();
    const unexpectedServices: Array<{ port: number; process: string }> = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("State")) continue;

      // Parse ss output: tcp LISTEN 0 128 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=1234,fd=5))
      const portMatch = trimmed.match(/:(\d+)\s/);
      const processMatch = trimmed.match(/users:\(\("([^"]+)"/);

      if (portMatch) {
        const port = Number.parseInt(portMatch[1], 10);
        const processName = processMatch?.[1] ?? "unknown";

        // Known OpenClaw gateway ports
        if ([8080, 3000, 8443, 443].includes(port)) {
          gatewayPorts.add(port);
        } else if (port < 1024 || (port > 1024 && port !== 22 && port !== 53)) {
          unexpectedServices.push({ port, process: processName });
        }
      }
    }

    // Flag unexpected listening services
    for (const svc of unexpectedServices) {
      findings.push({
        id: `net:unexpected-port-${svc.port}`,
        severity: "MEDIUM",
        category: "network",
        message: `Unexpected service listening on port ${svc.port} (${svc.process})`,
        remediation: `Verify this service is intended: ss -tlnp | grep :${svc.port}`,
      });
    }

    // Flag gateway listening on all interfaces
    for (const line of lines) {
      if (line.includes("0.0.0.0:") && line.includes("LISTEN")) {
        const portMatch = line.match(/:(\d+)\s/);
        if (portMatch && gatewayPorts.has(Number.parseInt(portMatch[1], 10))) {
          findings.push({
            id: `net:gateway-all-interfaces`,
            severity: "HIGH",
            category: "network",
            message: `Gateway appears to be listening on 0.0.0.0 (all interfaces)`,
            remediation:
              "Bind the gateway to 127.0.0.1 unless remote access is explicitly required.",
          });
          break; // Only report once
        }
      }
    }
  } catch {
    // ss/netstat not available — skip network audit
  }

  return findings;
}
