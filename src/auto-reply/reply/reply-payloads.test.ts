import { describe, expect, it } from "vitest";
import {
  filterMessagingToolMediaDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";

describe("filterMessagingToolMediaDuplicates", () => {
  it("strips mediaUrl when it matches sentMediaUrls", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("preserves mediaUrl when it is not in sentMediaUrls", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/other.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }]);
  });

  it("filters matching entries from mediaUrls array", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [
        {
          text: "gallery",
          mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/b.jpg", "file:///tmp/c.jpg"],
        },
      ],
      sentMediaUrls: ["file:///tmp/b.jpg"],
    });
    expect(result).toEqual([
      { text: "gallery", mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/c.jpg"] },
    ]);
  });

  it("clears mediaUrls when all entries match", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "gallery", mediaUrls: ["file:///tmp/a.jpg"] }],
      sentMediaUrls: ["file:///tmp/a.jpg"],
    });
    expect(result).toEqual([{ text: "gallery", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("returns payloads unchanged when no media present", () => {
    const payloads = [{ text: "plain text" }];
    const result = filterMessagingToolMediaDuplicates({
      payloads,
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toStrictEqual(payloads);
  });

  it("returns payloads unchanged when sentMediaUrls is empty", () => {
    const payloads = [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }];
    const result = filterMessagingToolMediaDuplicates({
      payloads,
      sentMediaUrls: [],
    });
    expect(result).toBe(payloads);
  });

  it("dedupes equivalent file and local path variants", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "/tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("dedupes encoded file:// paths against local paths", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "/tmp/photo one.jpg" }],
      sentMediaUrls: ["file:///tmp/photo%20one.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });
});

describe("shouldSuppressMessagingToolReplies", () => {
  it("suppresses when provider and target match", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "whatsapp",
        messagingToolSentTargets: [{ tool: "whatsapp", provider: "whatsapp", to: "+15551234567" }],
        originatingTo: "+15551234567",
      }),
    ).toBe(true);
  });

  it("does not suppress when provider mismatches sent target", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "cron-event",
        messagingToolSentTargets: [{ tool: "whatsapp", provider: "whatsapp", to: "+15551234567" }],
        originatingTo: "+15551234567",
      }),
    ).toBe(false);
  });

  it("does not suppress when target differs", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "whatsapp",
        messagingToolSentTargets: [{ tool: "whatsapp", provider: "whatsapp", to: "+15559999999" }],
        originatingTo: "+15551234567",
      }),
    ).toBe(false);
  });

  it("does not suppress when no targets were sent", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "whatsapp",
        messagingToolSentTargets: [],
        originatingTo: "+15551234567",
      }),
    ).toBe(false);
  });

  it("does not suppress when provider is undefined", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: undefined,
        messagingToolSentTargets: [{ tool: "whatsapp", provider: "whatsapp", to: "+15551234567" }],
        originatingTo: "+15551234567",
      }),
    ).toBe(false);
  });
});
