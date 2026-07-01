import { describe, expect, it } from "vitest";
import { buildDurableIntakeEnvelope, DURABLE_INTAKE_ENVELOPE_SCHEMA } from "./intake-envelope.js";

describe("durable intake envelope", () => {
  it("stores bounded previews by default without making replay claims", () => {
    const envelope = buildDurableIntakeEnvelope({
      operationKind: "openclaw.agent.turn",
      runId: "run-1",
      sourceType: "agent.turn",
      sessionKey: "agent:bo:main",
      message: "hello durable world",
      messageHash: "hash-1",
      env: {
        OPENCLAW_DURABLE_INPUT_PREVIEW_CHARS: "5",
      },
    });

    expect(envelope).toMatchObject({
      schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
      operationKind: "openclaw.agent.turn",
      runId: "run-1",
      message: {
        length: 19,
        hash: "hash-1",
        preview: "hello",
        previewTruncated: true,
      },
      replay: {
        inputAvailability: "preview_only",
        canReplay: false,
      },
    });
    expect(envelope.message.text).toBeUndefined();
  });

  it("can opt into full inline snapshots for local-first replay experiments", () => {
    const envelope = buildDurableIntakeEnvelope({
      operationKind: "openclaw.chat.send",
      runId: "run-2",
      sourceType: "chat.send",
      sessionKey: "agent:bo:main",
      message: "please continue",
      messageHash: "hash-2",
      env: {
        OPENCLAW_DURABLE_INPUT_TEXT: "full",
        OPENCLAW_DURABLE_INPUT_FULL_MAX_CHARS: "100",
      },
    });

    expect(envelope.message.text).toBe("please continue");
    expect(envelope.replay).toMatchObject({
      inputAvailability: "inline_snapshot",
      canReplay: true,
    });
  });

  it("records a context manifest ref without requiring large inline input", () => {
    const envelope = buildDurableIntakeEnvelope({
      operationKind: "openclaw.agent.turn",
      runId: "run-3",
      sourceType: "agent.turn",
      sessionKey: "agent:bo:main",
      message: "summarize the linked work",
      messageHash: "hash-3",
      contextRefs: [{ type: "work_unit", id: "wu-1" }],
      contextManifestRef: "ctx-manifest:run-3",
      env: {
        OPENCLAW_DURABLE_INPUT_PREVIEW_CHARS: "0",
      },
    });

    expect(envelope.contextManifestRef).toBe("ctx-manifest:run-3");
    expect(envelope.replay).toMatchObject({
      inputAvailability: "metadata_only",
      canReplay: false,
      contextManifestRef: "ctx-manifest:run-3",
    });
    expect(envelope.contextRefs).toEqual([{ type: "work_unit", id: "wu-1" }]);
  });
});
