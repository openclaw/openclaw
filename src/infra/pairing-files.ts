import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";

export function resolvePairingPaths(baseDir: string | undefined, subdir: string) {
  const root = baseDir ?? resolveStateDir();
  const dir = path.join(root, subdir);
  return {
    dir,
    pendingPath: path.join(dir, "pending.json"),
    pairedPath: path.join(dir, "paired.json"),
  };
}

export function pruneExpiredPending<T extends { ts: number }>(
  pendingById: Record<string, T>,
  nowMs: number,
  ttlMs: number,
) {
  for (const [id, req] of Object.entries(pendingById)) {
    if (nowMs - req.ts > ttlMs) {
      delete pendingById[id];
    }
  }
}

export type PendingPairingRequestResult<TPending> = {
  status: "pending";
  request: TPending;
  created: boolean;
};

export async function upsertPendingPairingRequest<TPending extends { requestId: string }>(params: {
  pendingById: Record<string, TPending>;
  isExisting: (pending: TPending) => boolean;
  createRequest: (isRepair: boolean) => TPending;
  isRepair: boolean;
  persist: () => Promise<void>;
}): Promise<PendingPairingRequestResult<TPending>> {
  const existing = Object.values(params.pendingById).find(params.isExisting);
  if (existing) {
    return { status: "pending", request: existing, created: false };
  }

  const request = params.createRequest(params.isRepair);
  params.pendingById[request.requestId] = request;
  await params.persist();
  return { status: "pending", request, created: true };
}
