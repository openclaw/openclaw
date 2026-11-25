import type { WorkerTaskChannel } from "../infra/worker-task-server.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

export async function prepareStateStream(
  input: OpenClawStateReadRequest,
  command: Extract<
    OpenClawStateReadCommand,
    { type: "subagents.restore" | "meetingTranscripts.export" }
  >,
  channel: WorkerTaskChannel | undefined,
  onAdmitted: () => void,
): Promise<() => Promise<OpenClawStateReadReply>> {
  if (command.type === "subagents.restore") {
    // A separate restore entry keeps mixed read/write adapters out of the lazy worker graph.
    const { streamSubagentRegistryInWorker } =
      await import("../agents/subagents/registry/subagent-registry.store.restore.worker.js");
    return async () => {
      if (!channel) {
        throw new Error("Subagent restore requires a bounded receiver");
      }
      const count = await streamSubagentRegistryInWorker(input, channel, onAdmitted);
      return { ok: true, type: command.type, sourceAdmitted: true, count };
    };
  }
  const { streamTranscriptExportInWorker } = await import("../transcripts/store-export.worker.js");
  return async () => {
    if (!channel) {
      throw new Error("Transcript export requires a bounded receiver");
    }
    const result = await streamTranscriptExportInWorker(input, command, channel, onAdmitted);
    return { ok: true, type: command.type, sourceAdmitted: true, result };
  };
}
