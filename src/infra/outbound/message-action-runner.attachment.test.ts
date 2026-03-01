import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMessageAction } from "./message-action-runner.js";
import * as SendService from "./outbound-send-service.js";

// Mock dependencies
vi.mock("./outbound-send-service.js");
vi.mock("node:fs/promises");

// Use factory to avoid initialization issues with src/browser/paths.ts
vi.mock("../tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp/openclaw-test"),
}));
vi.mock("./channel-selection.js", () => ({
  resolveMessageChannelSelection: vi.fn().mockResolvedValue({ channel: "discord" }),
  listConfiguredMessageChannels: vi.fn().mockReturnValue(["discord"]),
}));
vi.mock("./target-resolver.js", () => ({
  resolveChannelTarget: vi
    .fn()
    .mockResolvedValue({ ok: true, target: { kind: "user", to: "discord:123" } }),
}));
vi.mock("./message-action-params.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./message-action-params.js")>();
  return {
    ...actual,
    normalizeSandboxMediaList: vi.fn().mockImplementation(async ({ values }) => values),
    readBooleanParam: actual.readBooleanParam,
  };
});

describe("runMessageAction attachment handling", () => {
  const mockExecuteSendAction = vi.mocked(SendService.executeSendAction);
  const mockWriteFile = vi.mocked(fs.writeFile);
  const mockUnlink = vi.mocked(fs.unlink);

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteSendAction.mockResolvedValue({
      handledBy: "core",
      payload: { id: "msg-123" },
      sendResult: {
        channel: "discord",
        to: "discord:123",
        via: "gateway",
        mediaUrl: null,
        result: {
          messageId: "msg-123",
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("materializes buffer to temp file and passes to executeSendAction", async () => {
    const buffer = Buffer.from("hello world").toString("base64");

    await runMessageAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cfg: {} as any,
      action: "send",
      params: {
        to: "discord:123",
        buffer,
        filename: "test.txt",
        contentType: "text/plain",
      },
      dryRun: false,
    });

    // Verify executeSendAction was called with a mediaUrl pointing to a temp file
    expect(mockExecuteSendAction).toHaveBeenCalledTimes(1);
    const callArgs = mockExecuteSendAction.mock.calls[0][0];

    // Check that mediaUrls contains a file path in the temp dir
    const mediaUrls = callArgs.mediaUrls;
    expect(mediaUrls).toBeDefined();
    expect(mediaUrls).toHaveLength(1);
    const filePath = mediaUrls![0];
    expect(filePath).toContain("openclaw-test");
    expect(filePath).toMatch(/test\.txt$/); // Should preserve filename if possible or at least extension

    // Verify file was written
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledWith(filePath, expect.anything());

    // Verify cleanup happened (unlink)
    expect(mockUnlink).toHaveBeenCalledWith(filePath);
  });

  it("ignores buffer if dryRun is true", async () => {
    const buffer = Buffer.from("hello world").toString("base64");

    await runMessageAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cfg: {} as any,
      action: "send",
      params: {
        to: "discord:123",
        buffer,
        filename: "test.txt",
        message: "dry run test",
      },
      dryRun: true,
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
