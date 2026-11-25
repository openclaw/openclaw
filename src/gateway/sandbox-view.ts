import { createHash } from "node:crypto";
import { buildSandboxHostProxyHtml, decodeSandboxHostCsp } from "../agents/sandbox-host.js";
import { resolveOpenClawIdClawOrigin } from "./openclaw-id/claw-origin.js";
import type { GatewayClient } from "./server-methods/client-types.js";

/** A fixed DNS label: unpadded lowercase RFC 4648 base32 of the first 160 SHA-256 bits. */
function sandboxHostLabel(clawHost: string): string {
  const digest = createHash("sha256")
    .update(clawHost.toLowerCase(), "utf8")
    .digest()
    .subarray(0, 20);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let value = 0;
  let bits = 0;
  let label = "sbx--";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      label += alphabet[(value >>> bits) & 31];
    }
  }
  return label;
}

/** The linked claw origin when this connection's sandbox is the claw-loader sibling origin. */
function clawSandboxOrigin(client: GatewayClient | null | undefined): string | undefined {
  return client?.browserOrigin?.openclawIdTunnel ? resolveOpenClawIdClawOrigin() : undefined;
}

/** True when this connection's sandbox is served by claw-loader, which cannot serve Gateway files. */
export function usesClawSandbox(client: GatewayClient | null | undefined): boolean {
  return clawSandboxOrigin(client) !== undefined;
}

/** Projects the same view policy onto the sandbox reachable by this connection. */
export function resolveSandboxView(
  sandboxPath: string,
  client: GatewayClient | null | undefined,
  configuredOrigin?: string,
): { sandboxUrl: string; sandboxOrigin?: string; sandboxShellHtml?: string } {
  const clawOrigin = clawSandboxOrigin(client);
  if (clawOrigin) {
    const sandbox = new URL(sandboxPath, clawOrigin);
    const separator = sandbox.hostname.indexOf(".");
    sandbox.searchParams.set("claw", sandbox.hostname.slice(0, separator));
    sandbox.hostname = `${sandboxHostLabel(sandbox.host)}${sandbox.hostname.slice(separator)}`;
    sandbox.searchParams.set("cspv", "1");
    return {
      sandboxUrl: sandbox.href,
      sandboxOrigin: sandbox.origin,
      sandboxShellHtml: buildSandboxHostProxyHtml(
        decodeSandboxHostCsp(sandbox.searchParams.get("csp")),
      ),
    };
  }
  const ingress = client?.remoteControlUiIngress;
  const origin = ingress?.sandboxOrigin ?? configuredOrigin;
  return {
    sandboxUrl: ingress ? new URL(sandboxPath, ingress.sandboxOrigin).href : sandboxPath,
    ...(origin ? { sandboxOrigin: new URL(origin).origin } : {}),
  };
}
