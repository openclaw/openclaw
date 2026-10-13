import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { writeTranscriptArtifactFile } from "./store-artifacts.js";
import type { TranscriptStoreOperation } from "./store-worker-client.js";

export async function writeTranscriptJsonlArtifact(params: {
  sessionDir: string;
  session: TranscriptSessionDescriptor;
  operation: TranscriptStoreOperation;
  assertOwner: () => void;
  signal: AbortSignal;
}): Promise<string> {
  const digest = createHash("sha256");
  const session = { sessionId: params.session.sessionId, startedAt: params.session.startedAt };
  await writeTranscriptArtifactFile({
    rootDir: params.sessionDir,
    fileName: "transcript.jsonl",
    assertBeforeMutation: params.assertOwner,
    signal: params.signal,
    write: async (filePath) => {
      const handle = await fs.open(filePath, "wx", 0o600);
      try {
        await params.operation.streamExport(
          { type: "meetingTranscripts.export", format: "artifact", session },
          async (chunk, signal) => {
            signal.throwIfAborted();
            if (chunk.format !== "artifact") {
              throw new Error("Unexpected transcript artifact chunk.");
            }
            await handle.writeFile(chunk.jsonl, { signal });
            digest.update(chunk.jsonl);
          },
          params.signal,
        );
      } finally {
        await handle.close();
      }
    },
  });
  return digest.digest("hex");
}
