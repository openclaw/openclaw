import { describe, expect, it } from "vitest";
import type { MediaAttachment } from "./types.js";
import { selectAttachments } from "./attachments.js";

describe("media-understanding selectAttachments guards", () => {
  it("does not throw when attachments is undefined", () => {
    const run = () =>
      selectAttachments({
        capability: "image",
        attachments: undefined as unknown as MediaAttachment[],
        policy: { prefer: "path" },
      });

    expect(run).not.toThrow();
    expect(run()).toEqual([]);
  });

  it("does not throw when attachments is not an array", () => {
    const run = () =>
      selectAttachments({
        capability: "audio",
        attachments: { malformed: true } as unknown as MediaAttachment[],
        policy: { prefer: "url" },
      });

    expect(run).not.toThrow();
    expect(run()).toEqual([]);
  });
});
