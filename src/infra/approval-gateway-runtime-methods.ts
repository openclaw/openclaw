export const GATEWAY_NATIVE_APPROVAL_METHODS = [
  "approval.resolve",
  "exec.approval.get",
  "exec.approval.list",
  "exec.approval.resolve",
  "plugin.approval.list",
  "plugin.approval.resolve",
  "openclaw.approval.list",
] as const;

export type GatewayNativeApprovalMethod = (typeof GATEWAY_NATIVE_APPROVAL_METHODS)[number];

const gatewayNativeApprovalMethods = new Set<string>(GATEWAY_NATIVE_APPROVAL_METHODS);

export function isGatewayNativeApprovalMethod(
  method: string,
): method is GatewayNativeApprovalMethod {
  return gatewayNativeApprovalMethods.has(method);
}

// Dispatch classification is broader than the internal approval principal's allowlist.
const gatewayWorkerApprovalMethods = new Set<string>([
  ...GATEWAY_NATIVE_APPROVAL_METHODS,
  "approval.get",
  "approval.history",
  "exec.approval.request",
  "exec.approval.waitDecision",
  "exec.approval.grants.list",
  "exec.approval.grants.revoke",
  "plugin.approval.request",
  "plugin.approval.waitDecision",
]);

export function isGatewayWorkerApprovalMethod(method: string): boolean {
  return gatewayWorkerApprovalMethods.has(method);
}
