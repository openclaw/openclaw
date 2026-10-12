import { streamSubagentRegistryInWorker } from "../agents/subagents/registry/subagent-registry.store.worker.js";
import type { WorkerTaskChannel } from "../infra/worker-task-server.js";
import { streamTranscriptExportInWorker } from "../transcripts/store-export.worker.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

export async function readStateStream(
  input: OpenClawStateReadRequest,
  command: Extract<
    OpenClawStateReadCommand,
    { type: "subagents.restore" | "meetingTranscripts.export" }
  >,
  channel: WorkerTaskChannel | undefined,
  onAdmitted: () => void,
): Promise<OpenClawStateReadReply> {
  if (!channel) {
    const operation =
      command.type === "subagents.restore" ? "Subagent restore" : "Transcript export";
    throw new Error(`${operation} requires a bounded receiver`);
  }
  if (command.type === "subagents.restore") {
    const count = await streamSubagentRegistryInWorker(input, channel, onAdmitted);
    return { ok: true, type: command.type, sourceAdmitted: true, count };
  }
  const result = await streamTranscriptExportInWorker(input, command, channel, onAdmitted);
  return { ok: true, type: command.type, sourceAdmitted: true, result };
}
