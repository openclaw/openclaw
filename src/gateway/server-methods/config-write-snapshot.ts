import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { readConfigFileSnapshotForWrite, resolveConfigSnapshotHash } from "../../config/io.js";
import { invalidateConfigGetResponseCache } from "../config-get-response.js";
import type { GatewayConfigRevisionProjector } from "../config-revision-token.js";
import { resolveBaseHashParam } from "./base-hash.js";
import { respondError } from "./response.js";
import type { RespondFn } from "./types.js";

function requireConfigBaseHash(
  params: unknown,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>["snapshot"],
  respond: RespondFn,
  revisionProjector: GatewayConfigRevisionProjector,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  const snapshotHash = resolveConfigSnapshotHash(snapshot);
  const baseHash = resolveBaseHashParam(params);
  if (!snapshotHash || !baseHash) {
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      `config base hash ${snapshotHash ? "required" : "unavailable"}; re-run config.get and retry`,
    );
    return false;
  }
  if (baseHash !== revisionProjector.projectRawHash(snapshotHash)) {
    // A fresh write snapshot can observe an edit before the watcher invalidates reads.
    invalidateConfigGetResponseCache();
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      "config changed since last load; re-run config.get and retry",
    );
    return false;
  }
  return true;
}

export async function readConfigWriteSnapshotOrRespond(
  params: unknown,
  respond: RespondFn,
  revisionProjector: GatewayConfigRevisionProjector,
): Promise<Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>> | null> {
  const result = await readConfigFileSnapshotForWrite();
  if (!requireConfigBaseHash(params, result.snapshot, respond, revisionProjector)) {
    return null;
  }
  return result;
}
