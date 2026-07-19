import { describe, expect, it } from "vitest";
import { buildDurableIntakeEnvelope, DURABLE_INTAKE_ENVELOPE_SCHEMA } from "./intake-envelope.js";

describe("durable intake envelope", () => {
  it("stores bounded metadata without raw input or replay claims", () => {
    const envelope = buildDurableIntakeEnvelope({
      operationKind: "openclaw.agent.turn",
      runId: "run-1",
      sourceOwner: "session_store",
      sourceRef: "agent:main:main",
      sessionKey: "agent:main:main",
      message: "sensitive user input",
      messageHash: "hash-1",
    });

    expect(envelope).toEqual({
      schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
      operationKind: "openclaw.agent.turn",
      runId: "run-1",
      sourceOwner: "session_store",
      sourceRef: "agent:main:main",
      sessionKey: "agent:main:main",
      message: { length: 20, hash: "hash-1" },
      replay: {
        inputAvailability: "metadata_only",
        canReplay: false,
        reason: "durable intake stores metadata and hashes only; retry requires the source owner",
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("sensitive user input");
  });
});
