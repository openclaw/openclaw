import { createHash } from "node:crypto";
import { z } from "zod";
import { workerProtocolObject } from "./protocol-record.js";

export const NODE_WORKSPACE_EMPTY_MANIFEST = JSON.stringify({
  version: 1,
  baseCommit: null,
  entries: [],
});
export const NODE_WORKSPACE_EMPTY_MANIFEST_REF = `sha256:${createHash("sha256").update(NODE_WORKSPACE_EMPTY_MANIFEST).digest("hex")}`;

export const NODE_WORKSPACE_TRANSFER_PATH = "/__openclaw__/worker-transfer/v1";
export const NODE_WORKSPACE_TRANSFER_ERROR_CODE = "WORKSPACE_TRANSFER_FAILED";

const NODE_WORKSPACE_TRANSFER_INVALID_REASONS = [
  "content_length",
  "file_digest",
  "file_size",
  "manifest",
  "payload",
  "premature_eof",
  "staging",
  "trailing_bytes",
] as const;

export type NodeWorkspaceTransferInvalidReason =
  (typeof NODE_WORKSPACE_TRANSFER_INVALID_REASONS)[number];

export function isNodeWorkspaceTransferInvalidReason(
  value: unknown,
): value is NodeWorkspaceTransferInvalidReason {
  return (
    typeof value === "string" &&
    NODE_WORKSPACE_TRANSFER_INVALID_REASONS.some((reason) => reason === value)
  );
}

export class NodeWorkerWorkspaceTransferError extends Error {
  readonly code = NODE_WORKSPACE_TRANSFER_ERROR_CODE;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeWorkerWorkspaceTransferError";
  }
}

const ManifestRef = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const TransferToken = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes("\0"));
export const NodeWorkerWorkspaceTransferInputSchema = z.union([
  workerProtocolObject({
    direction: z.literal("download"),
    token: TransferToken,
    manifestRef: ManifestRef,
    /** Reuse this prepared project's immutable Git objects before downloading a pack. */
    seedKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    /** Install attachment files only; never replace or delete workspace entries. */
    attachments: z.literal(true).optional(),
    /** Restore only the checkpoint delta onto its independently cloned Git base. */
    checkpointBaseManifestRef: ManifestRef.optional(),
  }).refine(
    (value) =>
      (value.seedKey === undefined || value.attachments === undefined) &&
      (value.checkpointBaseManifestRef === undefined ||
        (value.attachments === undefined && value.seedKey === undefined)),
  ),
  workerProtocolObject({
    direction: z.literal("upload"),
    token: TransferToken,
    baseManifestRef: ManifestRef,
    /** Last accepted raw manifest; independent of the cumulative repository base. */
    referenceManifestRef: ManifestRef,
    /** Capture normalized publication artifacts under this pinned repository base. */
    publicationBaseCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .optional(),
  }),
]);
export type NodeWorkerWorkspaceTransferInput = z.infer<
  typeof NodeWorkerWorkspaceTransferInputSchema
>;

function nodeWorkspaceTransferEnvironmentPath(environmentId: string): string {
  return `${NODE_WORKSPACE_TRANSFER_PATH}/environments/${encodeURIComponent(environmentId)}`;
}

export function nodeWorkspaceTransferManifestPath(
  environmentId: string,
  manifestRef: string,
): string {
  return `${nodeWorkspaceTransferEnvironmentPath(environmentId)}/snapshots/${manifestRef.slice(
    "sha256:".length,
  )}/manifest`;
}

export function nodeWorkspaceTransferPackPath(environmentId: string, manifestRef: string): string {
  return `${nodeWorkspaceTransferEnvironmentPath(environmentId)}/snapshots/${manifestRef.slice(
    "sha256:".length,
  )}/pack`;
}

export function nodeWorkspaceTransferBlobPath(environmentId: string, sha256: string): string {
  return `${nodeWorkspaceTransferEnvironmentPath(environmentId)}/blobs/${sha256}`;
}

export function nodeWorkspaceTransferReconcilePath(
  environmentId: string,
  baseManifestRef: string,
): string {
  return `${nodeWorkspaceTransferEnvironmentPath(environmentId)}/reconciliations/${baseManifestRef.slice(
    "sha256:".length,
  )}`;
}
