// Approval resolution references compact exact IDs for transport-private callbacks.
import { sha256Base64Url } from "./crypto-digest.js";

const APPROVAL_RESOLUTION_REF_LENGTH = 43;

/** Build the full SHA-256 base64url locator used only when a transport cannot carry the exact id. */
export function buildApprovalResolutionRef(params: {
  approvalId: string;
  approvalKind: "exec" | "plugin" | "system-agent";
}): string {
  return sha256Base64Url(`${params.approvalKind}\0${params.approvalId}`);
}

export function isApprovalResolutionRef(value: string): boolean {
  return value.length === APPROVAL_RESOLUTION_REF_LENGTH && /^[A-Za-z0-9_-]+$/u.test(value);
}
