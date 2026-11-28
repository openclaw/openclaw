import { formatErrorMessage } from "../../infra/errors.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  countChannelIngressQueuePressureInDatabase,
  countFailedChannelIngressQueueEntriesInDatabase,
} from "./ingress-queue-health.kernel.js";
import type {
  ChannelIngressHealthSnapshot,
  ChannelIngressReadCommand,
  ChannelIngressReadReply,
} from "./ingress-queue-read-contract.js";
import { listChannelIngressAccountsInDatabase } from "./ingress-queue.kernel.js";

export function readChannelIngressInDatabase(
  db: EngineConnection,
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
  const result: ChannelIngressHealthSnapshot = { errors: {} };
  if (command.input.failed) {
    try {
      result.failed = countFailedChannelIngressQueueEntriesInDatabase(db);
    } catch (error) {
      result.errors.failed = formatErrorMessage(error);
    }
  }
  if (command.input.pressure) {
    try {
      result.pressure = countChannelIngressQueuePressureInDatabase(db, command.input.now);
    } catch (error) {
      result.errors.pressure = formatErrorMessage(error);
    }
  }
  return {
    ok: true,
    sourceAdmitted: true,
    type: command.type,
    result,
  };
}
