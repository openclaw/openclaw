export const DURABLE_INTAKE_ENVELOPE_SCHEMA = "openclaw.durable.intake-envelope.v1";

export type DurableIntakeEnvelope = {
  schema: typeof DURABLE_INTAKE_ENVELOPE_SCHEMA;
  operationKind: string;
  runId: string;
  sourceOwner: string;
  sourceRef: string;
  agentId?: string;
  sessionKey?: string;
  transport?: string;
  deliver?: boolean;
  message: {
    length: number;
    hash: string;
  };
  attachmentCount?: number;
  contextRefs?: readonly Record<string, unknown>[];
  replay: {
    inputAvailability: "metadata_only";
    canReplay: false;
    reason: string;
  };
};

export function buildDurableIntakeEnvelope(params: {
  operationKind: string;
  runId: string;
  sourceOwner: string;
  sourceRef: string;
  agentId?: string;
  sessionKey?: string;
  transport?: string;
  deliver?: boolean;
  message: string;
  messageHash: string;
  attachmentCount?: number;
  contextRefs?: readonly Record<string, unknown>[];
}): DurableIntakeEnvelope {
  return {
    schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
    operationKind: params.operationKind,
    runId: params.runId,
    sourceOwner: params.sourceOwner,
    sourceRef: params.sourceRef,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.transport ? { transport: params.transport } : {}),
    ...(params.deliver !== undefined ? { deliver: params.deliver } : {}),
    message: {
      length: params.message.length,
      hash: params.messageHash,
    },
    ...(params.attachmentCount !== undefined ? { attachmentCount: params.attachmentCount } : {}),
    ...(params.contextRefs && params.contextRefs.length > 0
      ? { contextRefs: params.contextRefs }
      : {}),
    replay: {
      inputAvailability: "metadata_only",
      canReplay: false,
      reason: "durable intake stores metadata and hashes only; retry requires the source owner",
    },
  };
}
