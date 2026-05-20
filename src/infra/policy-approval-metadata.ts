import type { ApprovalMetadataView } from "./approval-view-model.types.js";

export type ApprovalMetadataValue =
  | null
  | boolean
  | number
  | string
  | ApprovalMetadataValue[]
  | { [key: string]: ApprovalMetadataValue };

function asRecord(
  value: ApprovalMetadataValue | undefined,
): Record<string, ApprovalMetadataValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, ApprovalMetadataValue>)
    : null;
}

function recordString(
  record: Record<string, ApprovalMetadataValue> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function policyApprovalMetadataEntries(
  metadata: ApprovalMetadataValue | undefined,
): ApprovalMetadataView[] {
  const root = asRecord(metadata);
  if (!root || root.source !== "policy") {
    return [];
  }
  const policy = asRecord(root.policy);
  const attestation = asRecord(root.attestation);
  const workspace = asRecord(root.workspace);
  const entries: ApprovalMetadataView[] = [];
  const policyHash = recordString(policy, "hash") ?? recordString(policy, "expectedHash");
  if (policyHash) {
    entries.push({ label: "Policy Hash", value: policyHash });
  }
  const workspaceHash = recordString(workspace, "hash");
  if (workspaceHash) {
    entries.push({ label: "Workspace Hash", value: workspaceHash });
  }
  const attestationHash = recordString(attestation, "hash");
  if (attestationHash) {
    entries.push({ label: "Attestation Hash", value: attestationHash });
  }
  const expectedAttestationHash = recordString(attestation, "expectedHash");
  if (expectedAttestationHash) {
    entries.push({ label: "Expected Attestation", value: expectedAttestationHash });
  }
  const target = recordString(root, "target");
  if (target) {
    entries.push({ label: "Policy Target", value: target });
  }
  return entries;
}

export function policyApprovalMetadataLines(metadata: ApprovalMetadataValue | undefined): string[] {
  return policyApprovalMetadataEntries(metadata).map((entry) => `${entry.label}: ${entry.value}`);
}
