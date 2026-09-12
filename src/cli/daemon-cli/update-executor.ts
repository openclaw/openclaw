import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import {
  withDelegatedUpdateCommandExecutor,
  type UpdateCommandChildGrant,
} from "../update-cli/update-command-executor.js";
import { writeGatewayServiceUpdateCapability } from "./update-capability.js";

type NativeUpdateAction = "install" | "restart" | "stop";

/** Private stdin is withheld by the updater until the actual PID/start is bound.
 * A capability probe never loads the action implementation or consumes a grant. */
export async function runGatewayServiceUpdateCommand(
  mode: string | undefined,
  action: NativeUpdateAction,
  operation: () => Promise<unknown>,
): Promise<void> {
  if (mode === undefined) {
    await operation();
    return;
  }
  if (mode === "check") {
    writeGatewayServiceUpdateCapability();
    return;
  }
  if (mode !== "run") {
    throw new Error("Unsupported update-owned native command mode.");
  }
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > 64 * 1024) {
        throw new Error("Update executor input exceeds its bound.");
      }
      chunks.push(buffer);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !isRecord(input) ||
      input.action !== action ||
      typeof input.targetRoot !== "string" ||
      !isRecord(input.executor) ||
      typeof input.executor.runId !== "string" ||
      typeof input.executor.root !== "string" ||
      typeof input.executor.databasePath !== "string" ||
      typeof input.executor.childKey !== "string" ||
      !isRecord(input.executor.parent) ||
      !isRecord(input.executor.originalParent) ||
      !isRecord(input.executor.databaseIdentity) ||
      typeof input.executor.originalChildKey !== "string" ||
      !isRecord(input.executor.spawner) ||
      ((Object.hasOwn(input.executor, "retainedParent") ||
        Object.hasOwn(input.executor, "retainedChildKey")) &&
        (!isRecord(input.executor.retainedParent) ||
          typeof input.executor.retainedChildKey !== "string"))
    ) {
      throw new Error("Invalid native update executor input.");
    }
    // SAFETY: Partial transport data is validated against live lease rows before effects.
    const grant = input.executor as UpdateCommandChildGrant;
    const root = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
    const targetRoot = input.targetRoot;
    if (
      !root ||
      resolveUpdateInstallRoot(root) !== targetRoot ||
      resolveUpdateInstallRoot(grant.root) !== targetRoot
    ) {
      throw new Error("Native update receiver installation binding does not match its target.");
    }
    // Destination admission never replaces the original installation's live authority.
    await withDelegatedUpdateCommandExecutor(grant, grant.runId, grant.root, async (fence) =>
      withGatewayServiceUpdateAuthority(fence.assertCurrent, async () => {
        await operation();
      }),
    );
  } catch (cause) {
    throw new Error(
      "UPDATE_NATIVE_AUTHORITY: " + (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
  }
}
