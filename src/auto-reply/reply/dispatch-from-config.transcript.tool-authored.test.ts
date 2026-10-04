// A tool-authored source reply is mirrored into the transcript by delivery, after
// the send, under the dispatching run's writer fence: a writer replaced after the
// tool captured the reply cannot receive that assistant row.
import { describe, expect, it } from "vitest";
import { buildPayloads } from "../../agents/embedded-agent-runner/run/payloads.test-helpers.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { mirrorDeliveredReplyToTranscript } from "./dispatch-from-config.transcript.js";

const sessionKey = "agent:main:telegram:direct:123";
const sessionId = "tool-authored-session";
const replyText = "Pedido SO1 creado. 18 botellas.";

describe("tool-authored source reply transcript mirror", () => {
  const fixture = useTempSessionsFixture("tool-authored-mirror-");

  async function seedSession() {
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() }, {
      sessionId,
      updatedAt: 1,
      lifecycleRevision: "rev-1",
      activeWriterRunId: "run-a",
    } as SessionEntry);
  }

  // The mirror metadata exactly as dispatch fences it for run "run-a".
  function fencedMirrorForCapturedReply() {
    const [payload] = buildPayloads({
      messagingToolSourceReplyPayloads: [
        {
          text: replyText,
          idempotencyKey: "run-a:tool-source-reply:tc-1",
          sourceReplyFinal: true,
          toolAuthored: true,
        },
      ],
      sourceReplyDeliveryMode: "automatic",
      sessionKey,
      runId: "run-a",
      agentId: "main",
    });
    const mirror = getReplyPayloadMetadata(payload as object)?.sourceReplyTranscriptMirror;
    if (!mirror) {
      throw new Error("tool-authored reply carries no transcript mirror");
    }
    return {
      ...mirror,
      expectedSessionId: sessionId,
      expectedLifecycleRevision: "rev-1",
      expectedWriterRunId: "run-a",
      storePath: fixture.storePath(),
    };
  }

  async function assistantTexts() {
    const events = (await loadTranscriptEvents({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: fixture.storePath(),
    })) as Array<{ message?: { role?: string; content?: unknown } }>;
    return events
      .filter((event) => event.message?.role === "assistant")
      .map((event) => JSON.stringify(event.message?.content));
  }

  it("writes the assistant row once for the admitted writer", async () => {
    await seedSession();
    const metadata = fencedMirrorForCapturedReply();

    await mirrorDeliveredReplyToTranscript({ metadata, cfg: {} as OpenClawConfig });
    await mirrorDeliveredReplyToTranscript({ metadata, cfg: {} as OpenClawConfig });

    const texts = await assistantTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(replyText);
  });

  it("writes nothing after the session writer is replaced", async () => {
    await seedSession();
    const metadata = fencedMirrorForCapturedReply();
    await updateSessionEntry(
      { agentId: "main", sessionKey, storePath: fixture.storePath() },
      async () => ({ activeWriterRunId: "run-b" }) as Partial<InternalSessionEntry>,
    );

    await mirrorDeliveredReplyToTranscript({ metadata, cfg: {} as OpenClawConfig });

    expect(await assistantTexts()).toEqual([]);
  });
});
