import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs/promises before importing the module under test.
const mockLstat = vi.fn();
const mockReadFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  lstat: (...args: unknown[]) => mockLstat(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Mock the synchronous fs module (used elsewhere in chat.ts).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    default: {
      ...(actual["default"] as Record<string, unknown>),
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(),
      lstatSync: vi.fn(),
    },
  };
});

// Stub out heavy imports that chat.ts pulls in but we don't need.
vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return { ...actual, CURRENT_SESSION_VERSION: actual.CURRENT_SESSION_VERSION };
});
vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn(),
}));
vi.mock("../../agents/model-selection.js", () => ({
  resolveThinkingDefault: vi.fn(),
}));
vi.mock("../../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 60000),
}));
vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: vi.fn(),
}));
vi.mock("../../auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcher: vi.fn(),
}));
vi.mock("../../auto-reply/templating.js", () => ({}));
vi.mock("../../channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: vi.fn(),
}));
vi.mock("../../config/sessions.js", () => ({
  resolveSessionFilePath: vi.fn(),
}));
vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: vi.fn(),
}));
vi.mock("../../utils/directive-tags.js", () => ({
  stripInlineDirectiveTagsForDisplay: vi.fn((x: string) => x),
}));

import { __test } from "./chat.js";

const { extractMediaImagePaths, readImageAsBase64, injectMediaImagesIntoHistory } = __test;

// Helper: fake lstat result for a regular file.
function fakeLstat(size: number) {
  return {
    isSymbolicLink: () => false,
    isFile: () => true,
    size,
  };
}

// Helper: fake file content.
function fakeImageBuffer(content = "fake-png-data") {
  return Buffer.from(content);
}

describe("extractMediaImagePaths", () => {
  it("extracts absolute paths from MEDIA: lines", () => {
    const text = "MEDIA:/home/node/workspace/cat.png\nsome other text";
    const paths = extractMediaImagePaths(text);
    expect(paths).toEqual(["/home/node/workspace/cat.png"]);
  });

  it("handles backtick-wrapped paths", () => {
    const text = "MEDIA:`/tmp/photo.jpg`";
    expect(extractMediaImagePaths(text)).toEqual(["/tmp/photo.jpg"]);
  });

  it("is case-insensitive for extensions", () => {
    const text = "MEDIA:/tmp/PHOTO.JPG";
    expect(extractMediaImagePaths(text)).toEqual(["/tmp/PHOTO.JPG"]);
  });

  it("rejects relative paths", () => {
    const text = "MEDIA:./relative/image.png";
    expect(extractMediaImagePaths(text)).toEqual([]);
  });

  it("rejects paths with null bytes", () => {
    const text = "MEDIA:/tmp/evil\0.png";
    expect(extractMediaImagePaths(text)).toEqual([]);
  });

  it("rejects non-image extensions", () => {
    const text = "MEDIA:/tmp/script.sh";
    expect(extractMediaImagePaths(text)).toEqual([]);
  });

  it("extracts multiple paths from multiline text", () => {
    const text = "MEDIA:/a/cat.png\nMEDIA:/b/dog.jpg\ntext";
    expect(extractMediaImagePaths(text)).toEqual(["/a/cat.png", "/b/dog.jpg"]);
  });

  it("normalizes file:// URIs to bare absolute paths", () => {
    const text = "MEDIA:file:///home/node/workspace/cat.png";
    expect(extractMediaImagePaths(text)).toEqual(["/home/node/workspace/cat.png"]);
  });

  it("normalizes file:// URIs with backticks", () => {
    const text = "MEDIA:`file:///tmp/photo.jpg`";
    expect(extractMediaImagePaths(text)).toEqual(["/tmp/photo.jpg"]);
  });
});

describe("readImageAsBase64", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads a valid image file and returns base64", async () => {
    mockLstat.mockResolvedValue(fakeLstat(1024));
    mockReadFile.mockResolvedValue(fakeImageBuffer());
    const result = await readImageAsBase64("/tmp/cat.png");
    expect(result).toEqual({
      data: Buffer.from("fake-png-data").toString("base64"),
      media_type: "image/png",
    });
  });

  it("rejects paths containing .. before normalization to prevent traversal", async () => {
    // Check runs BEFORE path.normalize() so /tmp/../etc/shadow.png is rejected
    // even though normalize() would resolve it to /etc/shadow.png.
    const result = await readImageAsBase64("/tmp/../etc/image.png");
    expect(result).toBeNull();
  });

  it("returns null for symlinks", async () => {
    mockLstat.mockResolvedValue({
      isSymbolicLink: () => true,
      isFile: () => true,
      size: 100,
    });
    const result = await readImageAsBase64("/tmp/link.png");
    expect(result).toBeNull();
  });

  it("returns null for oversized files", async () => {
    mockLstat.mockResolvedValue(fakeLstat(100 * 1024 * 1024)); // 100MB
    mockReadFile.mockResolvedValue(Buffer.alloc(100 * 1024 * 1024));
    const result = await readImageAsBase64("/tmp/huge.png");
    expect(result).toBeNull();
  });

  it("returns null for zero-byte files", async () => {
    mockLstat.mockResolvedValue(fakeLstat(0));
    const result = await readImageAsBase64("/tmp/empty.png");
    expect(result).toBeNull();
  });

  it("returns null for unknown extensions", async () => {
    mockLstat.mockResolvedValue(fakeLstat(100));
    const result = await readImageAsBase64("/tmp/file.bmp");
    expect(result).toBeNull();
  });

  it("returns null when file read throws", async () => {
    mockLstat.mockRejectedValue(new Error("ENOENT"));
    const result = await readImageAsBase64("/nonexistent/file.png");
    expect(result).toBeNull();
  });

  it("returns null when file grows between lstat and readFile (TOCTOU)", async () => {
    // lstat reports a small file, but readFile returns a much larger buffer.
    mockLstat.mockResolvedValue(fakeLstat(1024));
    mockReadFile.mockResolvedValue(Buffer.alloc(100 * 1024 * 1024));
    const result = await readImageAsBase64("/tmp/swapped.png");
    expect(result).toBeNull();
  });

  it("returns null when file becomes empty between lstat and readFile (TOCTOU)", async () => {
    mockLstat.mockResolvedValue(fakeLstat(1024));
    mockReadFile.mockResolvedValue(Buffer.alloc(0));
    const result = await readImageAsBase64("/tmp/truncated.png");
    expect(result).toBeNull();
  });

  it("detects JPEG mime type from .jpg", async () => {
    mockLstat.mockResolvedValue(fakeLstat(1024));
    mockReadFile.mockResolvedValue(fakeImageBuffer());
    const result = await readImageAsBase64("/tmp/photo.jpg");
    expect(result?.media_type).toBe("image/jpeg");
  });
});

describe("injectMediaImagesIntoHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLstat.mockResolvedValue(fakeLstat(1024));
    mockReadFile.mockResolvedValue(fakeImageBuffer("test-image-data"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty array unchanged", async () => {
    const result = await injectMediaImagesIntoHistory([]);
    expect(result).toEqual([]);
  });

  it("injects base64 image from tool_result MEDIA path into next assistant message", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "show me a cat" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "image" }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "MEDIA:/workspace/cat.png\nA cute cat" }],
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here is the cat image!" }],
      },
    ];

    const result = await injectMediaImagesIntoHistory(messages);
    const lastMsg = result[3] as Record<string, unknown>;
    const content = lastMsg.content as Array<Record<string, unknown>>;

    // Should have the original text block + injected image block.
    expect(content.length).toBe(2);
    expect(content[1].type).toBe("image");
    expect(content[1].media_type).toBe("image/png");
    expect(typeof content[1].data).toBe("string");
  });

  it("respects the 2MB byte budget", async () => {
    // Return a ~1.5MB image for each read.
    const bigData = "x".repeat(1_500_000);
    mockReadFile.mockResolvedValue(Buffer.from(bigData));

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "MEDIA:/workspace/img1.png" }],
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "MEDIA:/workspace/img2.png" }],
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here are the images" }],
      },
    ];

    const result = await injectMediaImagesIntoHistory(messages);
    const lastMsg = result[2] as Record<string, unknown>;
    const content = lastMsg.content as Array<Record<string, unknown>>;

    // Only 1 image should fit within 2MB budget (1.5MB base64 ≈ 2MB).
    // The second image should be dropped.
    const imageBlocks = content.filter((b) => b.type === "image");
    expect(imageBlocks.length).toBeLessThanOrEqual(1);
  });

  it("does not inject into assistant messages with tool_use blocks", async () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "MEDIA:/workspace/cat.png" }],
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me also check..." },
          { type: "tool_use", name: "exec" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done!" }],
      },
    ];

    const result = await injectMediaImagesIntoHistory(messages);

    // First assistant (with tool_use) should NOT have injection.
    const first = result[1] as Record<string, unknown>;
    expect((first.content as unknown[]).length).toBe(2);

    // Second assistant should have the injection.
    const second = result[2] as Record<string, unknown>;
    expect((second.content as unknown[]).length).toBe(2); // text + image
  });

  it("flushes pending images into last assistant message when history ends without text-only assistant", async () => {
    // Scenario: tool result with MEDIA path, then assistant with tool_use, then no more messages.
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "MEDIA:/workspace/cat.png" }],
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Processing..." },
          { type: "tool_use", name: "exec" },
        ],
      },
    ];

    const result = await injectMediaImagesIntoHistory(messages);
    const lastMsg = result[1] as Record<string, unknown>;
    const content = lastMsg.content as Array<Record<string, unknown>>;

    // The end-of-history flush should inject into the last assistant message.
    const imageBlocks = content.filter((b) => b.type === "image");
    expect(imageBlocks.length).toBe(1);
  });

  it("deduplicates same path across tool_use boundary (multi-step agent command)", async () => {
    // Round 1: tool result references cat.png, assistant has tool_use (skipped).
    // Round 2: another tool result references the same cat.png.
    // seenPaths is preserved across tool_use boundaries so multi-step agent
    // commands (e.g. find → view-image) that produce the same MEDIA: path
    // don't inject the same image twice.
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "MEDIA:/workspace/cat.png" }],
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me also check..." },
          { type: "tool_use", name: "exec" },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "MEDIA:/workspace/cat.png" }],
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here it is!" }],
      },
    ];

    const result = await injectMediaImagesIntoHistory(messages);
    const lastMsg = result[3] as Record<string, unknown>;
    const content = lastMsg.content as Array<Record<string, unknown>>;

    // Same path across tool_use boundary → deduplicated to 1 image.
    const imageBlocks = content.filter((b) => b.type === "image");
    expect(imageBlocks.length).toBe(1);
  });

  it("skips messages with no content array", async () => {
    const messages = [
      { role: "system", content: "you are helpful" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const result = await injectMediaImagesIntoHistory(messages);
    expect(result).toHaveLength(2);
  });
});
