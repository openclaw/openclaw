import fs from "node:fs";
import { Socket } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readPackageActivationContinuation } from "../../infra/package-update-activation.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { resolveUpdateRoot, type UpdateCommandOptions } from "./shared.js";
import {
  withDelegatedUpdateCommandExecutor,
  type UpdateCommandChildGrant,
} from "./update-command-executor.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";
import { assertUpdatePackageActivationAdmission } from "./update-command-run.js";

export const POST_CORE_EXECUTOR_FD = 3;
export const POST_CORE_EXECUTOR_MAX_BYTES = 64 * 1024;

/** The private pipe must end before any preparation or persistent observation. */
async function readPostCoreExecutorGrant(): Promise<unknown> {
  const stat = fs.fstatSync(POST_CORE_EXECUTOR_FD);
  if (!stat.isFIFO() && !stat.isSocket()) {
    throw new Error("Post-core executor pipe is missing.");
  }
  const input = new Socket({ fd: POST_CORE_EXECUTOR_FD, readable: true, writable: false });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > POST_CORE_EXECUTOR_MAX_BYTES) {
        throw new Error("Post-core executor input exceeds its bound.");
      }
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    input.destroy();
  }
}

export async function withPostCoreUpdateExecutor<T>(
  opts: UpdateCommandOptions,
  operation: (admitted: UpdateCommandOptions) => Promise<T>,
): Promise<T> {
  if (process.env[POST_CORE_UPDATE_ENV] !== "1") {
    return operation(opts);
  }
  const root = resolveUpdateInstallRoot(await resolveUpdateRoot());
  let entered = false;
  try {
    const authority = readPackageActivationContinuation(root);
    if (!authority) {
      // v2026.4.29 and v2026.9.3 shipped ENV-only post-core parents. Preserve
      // that no-journal route; the marker never authorizes a pending operation.
      entered = true;
      return await operation(opts);
    }
    const input = await readPostCoreExecutorGrant();
    if (
      !isRecord(input) ||
      input.runId !== process.env[UPDATE_RUN_ID_ENV] ||
      typeof input.runId !== "string" ||
      !input.runId ||
      input.root !== root ||
      input.databasePath !== authority.databasePath ||
      !isDeepStrictEqual(input.databaseIdentity, authority) ||
      typeof input.childKey !== "string" ||
      input.childKey.length > 4096 ||
      !isRecord(input.parent)
    ) {
      throw new Error("Post-core executor input does not match its retained operation.");
    }
    // Shape checks only bound parsing. The existing receiver rereads both leases,
    // compares the complete parent row, and verifies this child's PID/start pair.
    // SAFETY: The delegated receiver verifies both full live lease rows before using this bounded input.
    const grant = input as UpdateCommandChildGrant;
    return await withDelegatedUpdateCommandExecutor(grant, grant.runId, root, async (fence) => {
      assertUpdatePackageActivationAdmission(root, { continuation: fence });
      entered = true;
      return operation({
        ...opts,
        run: { runId: grant.runId, env: process.env, executorFence: fence },
      });
    });
  } catch (cause) {
    if (entered || cause instanceof UpdateCommandPendingRecoveryFailure) {
      throw cause;
    }
    throw new UpdateCommandPendingRecoveryFailure(
      {
        status: "error",
        mode: "unknown",
        root,
        reason: "update-recovery-pending",
        steps: [],
        durationMs: 0,
      },
      "Post-core executor admission failed; package publication recovery remains pending.",
      { cause },
    );
  }
}
