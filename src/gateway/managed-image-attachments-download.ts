// Authenticated artifact-RPC reads for managed outgoing image bytes.
import { readLocalFileSafely } from "../infra/fs-safe.js";
import {
  parseManagedOutgoingRoute,
  recordMatchesTranscriptMessage,
  resolveManagedImageOriginalPath,
} from "./managed-image-attachments.js";
import { readManagedImageRecord } from "./managed-image-record-store.js";

export type ManagedOutgoingImageDownload = {
  data: Buffer;
  contentType: string;
  sizeBytes: number;
};

export async function readManagedOutgoingImageDownloadUrl(params: {
  url: string;
  expectedSessionKey: string;
  stateDir?: string;
}): Promise<ManagedOutgoingImageDownload | null> {
  const route = parseManagedOutgoingRoute(params.url);
  if (!route?.attachmentId || route.sessionKey !== params.expectedSessionKey) {
    return null;
  }
  const record = readManagedImageRecord(route.attachmentId, params.stateDir);
  if (!record || record.sessionKey !== route.sessionKey) {
    return null;
  }
  if (!(await recordMatchesTranscriptMessage(record))) {
    return null;
  }
  try {
    const { buffer } = await readLocalFileSafely({
      filePath: resolveManagedImageOriginalPath(record),
    });
    return {
      data: buffer,
      contentType: record.original.contentType || "application/octet-stream",
      sizeBytes: buffer.byteLength,
    };
  } catch {
    return null;
  }
}
