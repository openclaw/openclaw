import { createHash } from "node:crypto";
import { z } from "zod";
import { WorkerWorkspaceGitHistorySchema } from "../gateway/worker-environments/workspace-result-inventory.js";
import { NODE_WORKSPACE_RESULT_VERSION } from "../infra/node-runner-inventory.js";
import { workerProtocolObject } from "./protocol-record.js";

export const NODE_WORKSPACE_EMPTY_MANIFEST = JSON.stringify({
  version: 1,
  baseCommit: null,
  entries: [],
});
export const NODE_WORKSPACE_EMPTY_MANIFEST_REF = `sha256:${createHash("sha256").update(NODE_WORKSPACE_EMPTY_MANIFEST).digest("hex")}`;

export const NODE_WORKSPACE_TRANSFER_PATH = "/__openclaw__/worker-transfer/v1";
export const MAX_WORKSPACE_RESULT_GIT_PACK_BYTES = 256 * 1024 * 1024;

/** Shared by native and SSH transfers; only the dispatch base is borrowed from the receiver. */
export const NODE_WORKSPACE_GIT_HISTORY_SCRIPT = String.raw`
const fs = require("node:fs");
const cp = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const [root, baseCommit, packPath] = process.argv.slice(1);
const git = (args) => cp.spawnSync("git", ["-C", root, ...args], {encoding:"utf8"});
(async () => {
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.status !== 0) throw new Error("Worker Git HEAD is unavailable");
  const headCommit = head.stdout.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(headCommit)) throw new Error("Invalid worker Git HEAD");
  const ancestry = git(["merge-base", "--is-ancestor", baseCommit, headCommit]);
  // A rewritten worker can have pruned the dispatch commit; it cannot be adopted.
  if (ancestry.status !== 0 && ancestry.status !== 1 && ancestry.status !== 128) throw new Error("Worker Git ancestry is unavailable");
  const descendsFromBase = ancestry.status === 0;
  let unavailableReason;
  if (descendsFromBase && headCommit !== baseCommit) {
    const child = cp.spawn("git", ["-C", root, "pack-objects", "--revs", "--stdout"], {stdio:["pipe","pipe","pipe"]});
    let bytes = 0;
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
    const exit = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve() : reject(new Error("Worker Git pack failed: " + stderr)));
    });
    child.stdin.end(headCommit + "\n^" + baseCommit + "\n");
    try {
      await Promise.all([exit, pipeline(child.stdout, new Transform({transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > ${MAX_WORKSPACE_RESULT_GIT_PACK_BYTES} ? new Error("Worker Git pack exceeds its byte limit") : null, chunk);
      }}), fs.createWriteStream(packPath, {flags:"wx", mode:0o600}))]);
    } catch (error) {
      child.kill("SIGKILL");
      await exit.catch(() => {});
      fs.rmSync(packPath, {force:true});
      unavailableReason = (error instanceof Error ? error.message : String(error)).slice(0, 512);
    }
  }
  process.stdout.write(JSON.stringify({baseCommit, headCommit, descendsFromBase, unavailableReason}));
})().catch(reportFailure);
/** @param {unknown} error */
function reportFailure(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

export const NODE_WORKSPACE_TRANSFER_ERROR_CODE = "WORKSPACE_TRANSFER_FAILED";

export type NodeWorkerWorkspaceTransferOperation = "download" | "upload";
export type NodeWorkerWorkspaceTransferStage =
  | "recover"
  | "manifest"
  | "base"
  | "materialize"
  | "verify"
  | "replace"
  | "capture"
  | "snapshot"
  | "reconcile"
  | "acknowledgement";

type NodeWorkerWorkspaceTransferErrorOptions = ErrorOptions & {
  operation?: NodeWorkerWorkspaceTransferOperation;
  stage?: NodeWorkerWorkspaceTransferStage;
};

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
  return NODE_WORKSPACE_TRANSFER_INVALID_REASONS.some((reason) => reason === value);
}

/** Retains private transfer context until the node boundary serializes a safe diagnostic. */
export class NodeWorkerWorkspaceTransferError extends Error {
  readonly code = NODE_WORKSPACE_TRANSFER_ERROR_CODE;
  readonly operation?: NodeWorkerWorkspaceTransferOperation;
  readonly stage?: NodeWorkerWorkspaceTransferStage;

  constructor(message: string, options?: NodeWorkerWorkspaceTransferErrorOptions) {
    super(message, options);
    this.name = "NodeWorkerWorkspaceTransferError";
    this.operation = options?.operation;
    this.stage = options?.stage;
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
    checkpointGitHistory: WorkerWorkspaceGitHistorySchema.optional(),
  }).refine(
    (value) =>
      (value.seedKey === undefined || value.attachments === undefined) &&
      (value.checkpointBaseManifestRef === undefined ||
        (value.attachments === undefined && value.seedKey === undefined)) &&
      (value.checkpointGitHistory === undefined || value.checkpointBaseManifestRef !== undefined),
  ),
  workerProtocolObject({
    direction: z.literal("upload"),
    token: TransferToken,
    baseManifestRef: ManifestRef,
    resultVersion: z.literal(NODE_WORKSPACE_RESULT_VERSION).optional(),
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
