import { randomUUID } from "node:crypto";
import type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
export function legacyRecord(record: UpdateRecoveryRecord) {
  const historical = structuredClone(record);
  const receipt = historical.terminal?.receipt ?? historical.verification?.receipt;
  if (!receipt) {
    throw new Error("Fixture requires saved evidence");
  }
  const legacy = {
    runId: receipt.runId,
    gateway: receipt.gateway,
    verifiedAtMs: receipt.verifiedAtMs,
    agentId: "main",
    sessionKey: "agent:main:legacy",
    sessionId: "legacy-session",
    agentRunId: randomUUID(),
    transcript: {
      generation: "legacy",
      maxSeq: 2,
      user: { entryId: "u", seq: 1 },
      assistant: { entryId: "a", seq: 2 },
    },
  };
  return {
    ...historical,
    verification: historical.verification ? { ...historical.verification, receipt: legacy } : null,
    ...(historical.terminal ? { terminal: { ...historical.terminal, receipt: legacy } } : {}),
  };
}
