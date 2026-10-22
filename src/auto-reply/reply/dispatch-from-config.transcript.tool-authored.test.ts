import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildPayloads } from "../../agents/embedded-agent-runner/run/payloads.test-helpers.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { mirrorDeliveredReplyToTranscript } from "./dispatch-from-config.transcript.js";

const sessionKey = "agent:main:telegram:direct:123";
const sessionId = "tool-authored-session";
const replyText = "Pedido SO1 creado. 18 botellas.";

describe("tool-authored source reply transcript mirror", () => {
  const tempDirs = useSessionStoreTempDirs(afterAll, "tool-authored-mirror-");
  let storePath: string;
  beforeEach(async () => {
    storePath = path.join(tempDirs.make(), "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, {
      sessionId,
      updatedAt: 1,
      lifecycleRevision: "rev-1",
      activeWriterRunId: "run-a",
    } as SessionEntry);
  });

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
      storePath,
    };
  }

  async function assistantTexts() {
    const events = (await loadTranscriptEvents({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
    })) as Array<{ message?: { role?: string; content?: unknown } }>;
    return events
      .filter((event) => event.message?.role === "assistant")
      .map((event) => JSON.stringify(event.message?.content));
  }

  it("writes the assistant row once for the admitted writer", async () => {
    const metadata = fencedMirrorForCapturedReply();
    await mirrorDeliveredReplyToTranscript({ metadata, cfg: {} });
    await mirrorDeliveredReplyToTranscript({ metadata, cfg: {} });

    const texts = await assistantTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(replyText);
  });

  it("writes nothing after the session writer is replaced", async () => {
    const metadata = fencedMirrorForCapturedReply();
    await updateSessionEntry(
      { agentId: "main", sessionKey, storePath },
      async () => ({ activeWriterRunId: "run-b" }) as Partial<InternalSessionEntry>,
    );

    await mirrorDeliveredReplyToTranscript({ metadata, cfg: {} });

    expect(await assistantTexts()).toEqual([]);
  });
});
