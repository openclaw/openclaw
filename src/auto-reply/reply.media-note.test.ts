import { describe, expect, it } from "vitest";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import { REPLY_MEDIA_HINT, buildReplyPromptBodies } from "./reply/prompt-prelude.js";

describe("getReplyFromConfig media note plumbing", () => {
  it("includes all MediaPaths in the agent prompt", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "hello",
      BodyForAgent: "hello",
      From: "+1001",
      To: "+2000",
      MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
      MediaUrls: ["/tmp/a.png", "/tmp/b.png"],
    });
    const prompt = buildReplyPromptBodies({
      ctx: sessionCtx,
      sessionCtx,
      effectiveBaseBody: sessionCtx.BodyForAgent,
      prefixedBody: sessionCtx.BodyForAgent,
    }).prefixedCommandBody;

    expect(prompt).toContain("[media attached: 2 files]");
    const idxA = prompt.indexOf("[media attached 1/2: /tmp/a.png");
    const idxB = prompt.indexOf("[media attached 2/2: /tmp/b.png");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB);
    expect(prompt).toContain("hello");
  });

  it("keeps the real image attachment note after image understanding rewrites the body", () => {
    const describedBody = [
      "[Image]",
      "User text:",
      "make this widescreen",
      "Description:",
      "a red barn at sunset",
    ].join("\n");
    const sessionCtx = finalizeInboundContext({
      Body: describedBody,
      BodyForAgent: describedBody,
      From: "+1001",
      To: "+2000",
      MediaPaths: ["/tmp/media-store/real-image.png"],
      MediaUrls: ["https://example.com/real-image.png"],
      MediaTypes: ["image/png"],
      MediaUnderstanding: [
        {
          kind: "image.description",
          attachmentIndex: 0,
          text: "a red barn at sunset",
          provider: "openai",
        },
      ],
    });
    const prompt = buildReplyPromptBodies({
      ctx: sessionCtx,
      sessionCtx,
      effectiveBaseBody: sessionCtx.BodyForAgent,
      prefixedBody: sessionCtx.BodyForAgent,
    }).prefixedCommandBody;

    expect(prompt).toContain(
      "[media attached: /tmp/media-store/real-image.png (image/png) | https://example.com/real-image.png]",
    );
    expect(prompt).toContain(describedBody);
  });
});

describe("buildReplyPromptBodies transcriptCommandBody asymmetry", () => {
  it("excludes REPLY_MEDIA_HINT from transcriptCommandBody but includes it in prefixedCommandBody and queuedBody", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "send me a picture",
      BodyForAgent: "send me a picture",
      From: "+1001",
      To: "+2000",
      MediaPaths: ["/tmp/photo.png"],
      MediaUrls: ["https://example.com/photo.png"],
      MediaTypes: ["image/png"],
    });
    const result = buildReplyPromptBodies({
      ctx: sessionCtx,
      sessionCtx,
      effectiveBaseBody: sessionCtx.BodyForAgent,
      prefixedBody: sessionCtx.BodyForAgent,
    });

    expect(result.mediaNote).toBeTruthy();
    expect(result.mediaReplyHint).toBe(REPLY_MEDIA_HINT);

    // The model-only routing hint must not leak into the user-visible
    // transcript. The prefix and queue paths (which feed the model) do
    // include it; the transcript path (which feeds visible history) does not.
    expect(result.transcriptCommandBody).not.toContain(REPLY_MEDIA_HINT);
    expect(result.prefixedCommandBody).toContain(REPLY_MEDIA_HINT);
    expect(result.queuedBody).toContain(REPLY_MEDIA_HINT);

    // The mediaNote itself is user-visible context (not a routing hint), so
    // it appears in all three paths.
    const mediaNote = result.mediaNote;
    expect(mediaNote).toBeDefined();
    if (mediaNote) {
      expect(result.transcriptCommandBody).toContain(mediaNote);
      expect(result.prefixedCommandBody).toContain(mediaNote);
      expect(result.queuedBody).toContain(mediaNote);
    }
  });

  it("defaults transcriptCommandBody to effectiveBaseBody when transcriptBody is omitted", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "hello",
      BodyForAgent: "hello rewritten for agent",
      From: "+1001",
      To: "+2000",
    });
    const result = buildReplyPromptBodies({
      ctx: sessionCtx,
      sessionCtx,
      effectiveBaseBody: sessionCtx.BodyForAgent,
      prefixedBody: sessionCtx.BodyForAgent,
    });

    expect(result.mediaNote).toBeUndefined();
    expect(result.transcriptCommandBody).toBe("hello rewritten for agent");
  });

  it("uses transcriptBody override without affecting prefixedCommandBody or queuedBody", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "raw user text",
      BodyForAgent: "agent-rewritten body",
      From: "+1001",
      To: "+2000",
    });
    const result = buildReplyPromptBodies({
      ctx: sessionCtx,
      sessionCtx,
      effectiveBaseBody: sessionCtx.BodyForAgent,
      prefixedBody: sessionCtx.BodyForAgent,
      transcriptBody: "raw user text",
    });

    expect(result.transcriptCommandBody).toBe("raw user text");
    expect(result.prefixedCommandBody).toContain("agent-rewritten body");
    expect(result.queuedBody).toContain("agent-rewritten body");
    expect(result.prefixedCommandBody).not.toContain("raw user text");
    expect(result.queuedBody).not.toContain("raw user text");
  });
});
