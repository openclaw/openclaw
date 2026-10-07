import type { DatabaseSync } from "node:sqlite";
import {
  countChannelIngressQueuePressureInDatabase,
  countFailedChannelIngressQueueEntriesInDatabase,
} from "./ingress-queue-health.kernel.js";
import type {
  ChannelIngressReadCommand,
  ChannelIngressReadReply,
} from "./ingress-queue-read-contract.js";
import { listChannelIngressAccountsInDatabase } from "./ingress-queue.kernel.js";

export function readChannelIngressInDatabase(
  db: DatabaseSync,
  command: ChannelIngressReadCommand,
): ChannelIngressReadReply {
  if (command.type === "channelIngress.accounts") {
    return {
      ok: true,
      sourceAdmitted: true,
      type: command.type,
      result: listChannelIngressAccountsInDatabase(db, command.input),
    };
  }
  if (command.type === "channelIngress.failedHealth") {
    return {
      ok: true,
      sourceAdmitted: true,
      type: command.type,
      result: countFailedChannelIngressQueueEntriesInDatabase(db),
    };
  }
  return {
    ok: true,
    sourceAdmitted: true,
    type: command.type,
    result: countChannelIngressQueuePressureInDatabase(db, command.input.now),
  };
}
