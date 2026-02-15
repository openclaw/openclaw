import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaAttachmentCache } from "./attachments.js";
import { normalizeMediaUnderstandingChatType, resolveMediaUnderstandingScope } from "./scope.js";

describe("media understanding scope", () => {
  it("normalizes chatType", () => {
    expect(normalizeMediaUnderstandingChatType("channel")).toBe("channel");
    expect(normalizeMediaUnderstandingChatType("dm")).toBe("direct");
    expect(normalizeMediaUnderstandingChatType("room")).toBeUndefined();
  });

  it("matches channel chatType explicitly", () => {
    const scope = {
      rules: [{ action: "deny", match: { chatType: "channel" } }],
    } as const;

    expect(resolveMediaUnderstandingScope({ scope, chatType: "channel" })).toBe("deny");
  });
});

const originalFetch = globalThis.fetch;

describe("media understanding attachments SSRF", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("blocks private IP URLs before fetching", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    const cache = new MediaAttachmentCache([{ index: 0, url: "http://127.0.0.1/secret.jpg" }]);

    await expect(
      cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toThrow(/private|internal|blocked/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
