import { isLoopbackHostname } from "../lib/gateway-locality.ts";

export function resolveGatewayHttpOrigin(gatewayUrl: string, hostOrigin: string): string {
  const gateway = new URL(gatewayUrl || hostOrigin, hostOrigin);
  if (gateway.protocol === "ws:") {
    gateway.protocol = "http:";
  } else if (gateway.protocol === "wss:") {
    gateway.protocol = "https:";
  }
  if (gateway.protocol !== "http:" && gateway.protocol !== "https:") {
    throw new Error("Gateway URL is invalid");
  }
  return gateway.origin;
}

export function resolveSandboxHostUrl(
  value: string,
  sandboxPort: number,
  sandboxOrigin: string | undefined,
  gatewayUrl: string,
  hostOrigin: string,
  invalidMessage = "Sandbox host URL is invalid",
  /** Exact capability shell path returned by the authenticated session-file preview RPC. */
  expectedSandboxPath?: string,
): string {
  if (!Number.isInteger(sandboxPort) || sandboxPort < 1 || sandboxPort > 65535) {
    throw new Error(invalidMessage);
  }
  let activeGatewayOrigin: string;
  try {
    activeGatewayOrigin = resolveGatewayHttpOrigin(gatewayUrl, hostOrigin);
  } catch {
    throw new Error(invalidMessage);
  }
  const base = sandboxOrigin ? new URL(sandboxOrigin) : new URL(activeGatewayOrigin);
  if (sandboxOrigin) {
    if (
      base.origin !== sandboxOrigin.replace(/\/$/u, "") ||
      base.username !== "" ||
      base.password !== ""
    ) {
      throw new Error(invalidMessage);
    }
  } else {
    base.port = String(sandboxPort);
  }
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  const resolved = new URL(value, base);
  const allowedPath = expectedSandboxPath
    ? value === expectedSandboxPath &&
      expectedSandboxPath.startsWith("/__openclaw__/file-preview/") &&
      resolved.pathname === expectedSandboxPath &&
      resolved.search === "" &&
      resolved.hash === ""
    : resolved.pathname === "/mcp-app-sandbox";
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.origin === new URL(hostOrigin).origin ||
    base.origin === activeGatewayOrigin ||
    resolved.origin !== base.origin ||
    !allowedPath
  ) {
    throw new Error(invalidMessage);
  }
  return resolved.href;
}

/** True when no explicit sandbox origin is set and the derived one is not loopback. */
export function isDerivedRemoteSandboxOrigin(
  explicitOrigin: string | undefined,
  resolvedOrigin: string,
): boolean {
  return (
    !explicitOrigin &&
    Boolean(resolvedOrigin) &&
    !isLoopbackHostname(new URL(resolvedOrigin).hostname)
  );
}
