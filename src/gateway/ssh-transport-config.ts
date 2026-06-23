export function isGatewayRemoteSshTransport(
  remote: { transport?: "ssh" | "direct" } | undefined,
): boolean {
  return Boolean(remote) && remote?.transport !== "direct";
}
