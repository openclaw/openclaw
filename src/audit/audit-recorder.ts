/** Gateway-owned recorder joining trusted run, tool, and message lifecycle streams. */
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createAgentEventAuditRecorder,
  type AgentEventAuditRecorder,
} from "./agent-event-audit.js";
import {
  isAuditLedgerEnabled,
  isExecutionIdentityCollectionEnabled,
  resolveAuditMessageMode,
} from "./audit-config.js";
import { createAuditEventWriter, type AuditEventWriter } from "./audit-event-writer.js";
import type { TrustedMessageAuditEvent } from "./message-audit-events.js";

const log = createSubsystemLogger("audit/events");
let persistenceFailureWarned = false;

type AuditEventRecorder = AgentEventAuditRecorder & {
  recordMessage: (event: TrustedMessageAuditEvent) => void;
  recordExecutionIdentity: AuditEventWriter["recordExecutionIdentity"];
  recordExecutionDecision: AuditEventWriter["recordExecutionDecision"];
  recordExecutionDecisionWork: AuditEventWriter["recordExecutionDecisionWork"];
};

export function createAuditEventRecorder(options: {
  getConfig: () => OpenClawConfig;
  writer?: AuditEventWriter;
  stateDir?: string;
  terminalSettleMs?: number;
}): AuditEventRecorder {
  let nextAcceptedMessageSequence = 0;
  const writer =
    options.writer ??
    createAuditEventWriter({
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      onContention: (message) => log.warn(message),
      onError: (error) => {
        if (!persistenceFailureWarned) {
          persistenceFailureWarned = true;
          log.warn(`audit event persistence failed: ${error}`);
        }
      },
    });
  const agentRecorder = createAgentEventAuditRecorder({
    writer,
    getConfig: options.getConfig,
    terminalSettleMs: options.terminalSettleMs,
  });

  return {
    ...agentRecorder,
    recordExecutionIdentity: (work) =>
      isExecutionIdentityCollectionEnabled(options.getConfig()) &&
      writer.recordExecutionIdentity(work),
    recordExecutionDecision: (receipt) =>
      isExecutionIdentityCollectionEnabled(options.getConfig()) &&
      writer.recordExecutionDecision(receipt),
    recordExecutionDecisionWork: (work) =>
      isExecutionIdentityCollectionEnabled(options.getConfig()) &&
      writer.recordExecutionDecisionWork(work),
    recordMessage: (event) => {
      const config = options.getConfig();
      const messageMode = resolveAuditMessageMode(config);
      if (!isAuditLedgerEnabled(config) || messageMode === "off") {
        return;
      }
      if (messageMode === "direct" && event.conversationKind !== "direct") {
        return;
      }
      nextAcceptedMessageSequence += 1;
      writer.record({
        ...event,
        sourceId: event.sourceId?.trim() || `message:${randomUUID()}`,
        sourceSequence: nextAcceptedMessageSequence,
      });
    },
  };
}
