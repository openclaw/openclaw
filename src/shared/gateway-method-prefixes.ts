export const ADMIN_GATEWAY_METHOD_PREFIXES = [
  "exec.approvals.",
  "config.",
  "wizard.",
  "update.",
] as const;

export function isReservedAdminGatewayMethod(method: string): boolean {
  return ADMIN_GATEWAY_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}
