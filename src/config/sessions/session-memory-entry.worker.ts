import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import { prepareSessionMemoryEntries } from "./session-memory-entry-preparation.worker.js";
import type { SessionEntriesWorkerInput } from "./session-transcript-worker-read.types.js";
import type { SessionTranscriptWorkerValues } from "./session-transcript-worker.types.js";
export { prepareSessionMemoryEntry } from "./session-memory-entry-preparation.worker.js";

/** The dispatcher delegates acknowledged delivery to the export owner. */
export async function deliverSessionMemoryEntries(
  entries: SessionEntriesWorkerInput["entries"],
  channel: WorkerTaskChannel | undefined,
  control: WorkerTaskControl,
): Promise<SessionTranscriptWorkerValues["session-entries"]> {
  if (!channel) {
    throw new Error("Session exports require their host delivery channel");
  }
  channel.consumeInput();
  await prepareSessionMemoryEntries(entries, async (index, value) => {
    control.throwIfCancelled();
    const response = await channel.request({ kind: "session-entries", index, value });
    response.consumed();
    control.throwIfCancelled();
  });
  return { entries: [] };
}
