import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok } from "@openclaw/normalization-core/result";
import { isGatewayProtocolResponseError } from "../../packages/gateway-client/src/protocol-request.js";
import { digestClawValue } from "../claws/digest.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import {
  clawRemovalJournalRequestSchema,
  clawRemovalJournalResultSchema,
  serializeClawRemovalJournal,
  type ClawRemovalJournalGateway,
} from "../claws/removal-journal-contract.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

export const clawRemovalJournalGateway: ClawRemovalJournalGateway = async (input, authority) => {
  authority.assertCurrent();
  const agentId = input.kind === "begin" ? input.entry.agentId : input.journal.agentId;
  const operationId = input.kind === "begin" ? input.operationId : input.journal.operationId;
  const request = clawRemovalJournalRequestSchema.parse({
    phase: input.kind,
    agentId,
    operationId,
    binding: resolveClawMonitorCleanupBinding(
      resolveCronJobsStorePathFromConfig(getRuntimeConfig()),
    ),
    lease: authority.identity,
    sourceIdentity: authority.sourceIdentity,
    expectedInstallDigest: input.expectedInstallDigest,
    expectedJournalDigest: digestClawValue(
      serializeClawRemovalJournal(input.kind === "begin" ? input.expectedJournal : input.journal),
    ),
    configDigest: input.configDigest,
  });
  let response: unknown;
  try {
    response = await callGatewayFromCli("claws.removalJournal", { timeout: "600000" }, request, {
      signal: authority.signal,
    });
  } catch (error) {
    if (
      isGatewayProtocolResponseError(error) &&
      ((isRecord(error.details) && error.details.outcomeUnknown === false) ||
        error.gatewayCode === "INVALID_REQUEST" ||
        error.gatewayCode === "FORBIDDEN")
    ) {
      return err(error);
    }
    throw error;
  }
  const result = clawRemovalJournalResultSchema.parse(response);
  if (!result.ok) {
    return err(new Error(result.error));
  }
  if (
    input.kind === "begin"
      ? !result.journal ||
        result.journal.agentId !== agentId ||
        result.journal.operationId !== operationId ||
        result.journal.cleanupCompleted
      : result.journal !== null
  ) {
    throw new Error(
      "Claw journal outcome is unknown: Gateway returned a different deletion operation; inspect claws status before retrying.",
    );
  }
  return ok(result.journal ? { ...result.journal, phase: "retiring" } : null);
};
