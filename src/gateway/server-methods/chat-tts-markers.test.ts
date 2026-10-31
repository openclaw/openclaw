import "../../test-utils/prepare-compiled-subprocesses.js";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  buildMediaOnlyTtsSupplementTranscriptMarker,
  buildTtsSupplementTranscriptMarker,
} from "./chat-tts-markers.js";

// mock-isolation: Large code-aware extraction belongs to the worker, including after projection.
vi.mock("../../shared/text/code-ranges.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/text/code-ranges.js")>();
  return {
    ...actual,
    findCodeRegions(text: string) {
      if (text.length > 32_768) {
        throw new Error("Large TTS code extraction ran on the calling thread");
      }
      return actual.findCodeRegions(text);
    },
  };
});

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

it("hashes visible payload text and only marks media-only supplements without text", async () => {
  const payload = {
    text: "  Visible answer  ",
    mediaUrl: "https://example.invalid/tts.mp3",
    ttsSupplement: { spokenText: "Spoken answer" },
  };
  await expect(buildTtsSupplementTranscriptMarker(payload)).resolves.toEqual({
    textSha256: hash("Visible answer"),
  });
  await expect(buildMediaOnlyTtsSupplementTranscriptMarker(payload)).resolves.toBeUndefined();
  await expect(
    buildMediaOnlyTtsSupplementTranscriptMarker({ ...payload, text: undefined }),
  ).resolves.toEqual({ textSha256: hash("Spoken answer") });
});

it("keeps large indented code revealed by a control prefix in worker-owned extraction", async () => {
  const visible = `    ${"literal ".repeat(150_000)}`.trimEnd();
  await expect(
    buildTtsSupplementTranscriptMarker({
      text: `NO_REPLY\n${visible}`,
      mediaUrl: "https://example.invalid/tts.mp3",
      ttsSupplement: { spokenText: "Synthetic source" },
    }),
  ).resolves.toEqual({ textSha256: hash(visible) });
});
