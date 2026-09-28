import type { DatabaseSync } from "node:sqlite";
import { countFailedChannelIngressQueueEntriesInDatabase } from "./ingress-queue-health.kernel.js";
import type {
  ChannelIngressReadCommand,
  ChannelIngressReadReply,
} from "./ingress-queue-read-contract.js";

export function readChannelIngressInDatabase(
  db: DatabaseSync,
  command: ChannelIngressReadCommand,
): ChannelIngressReadReply {
  return {
    ok: true,
    sourceAdmitted: true,
    type: command.type,
    result: countFailedChannelIngressQueueEntriesInDatabase(db),
  };
}
