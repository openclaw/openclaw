import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseManagedOutgoingRoute: vi.fn(),
  readLocalFileSafely: vi.fn(),
  readManagedImageRecord: vi.fn(),
  recordMatchesTranscriptMessage: vi.fn(),
  resolveManagedImageOriginalPath: vi.fn(),
}));

vi.mock("../infra/fs-safe.js", () => ({ readLocalFileSafely: mocks.readLocalFileSafely }));
vi.mock("./managed-image-attachments.js", () => ({
  parseManagedOutgoingRoute: mocks.parseManagedOutgoingRoute,
  recordMatchesTranscriptMessage: mocks.recordMatchesTranscriptMessage,
  resolveManagedImageOriginalPath: mocks.resolveManagedImageOriginalPath,
}));
vi.mock("./managed-image-record-store.js", () => ({
  readManagedImageRecord: mocks.readManagedImageRecord,
}));

const { readManagedOutgoingImageDownloadUrl } =
  await import("./managed-image-attachments-download.js");

const route = {
  attachmentId: "11111111-1111-4111-8111-111111111111",
  sessionKey: "agent:main:main",
};
const record = {
  ...route,
  messageId: "message-1",
  original: { contentType: "image/png" },
};

describe("readManagedOutgoingImageDownloadUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseManagedOutgoingRoute.mockReturnValue(route);
    mocks.readManagedImageRecord.mockReturnValue(record);
    mocks.recordMatchesTranscriptMessage.mockResolvedValue(true);
    mocks.resolveManagedImageOriginalPath.mockReturnValue("/state/media/image.png");
    mocks.readLocalFileSafely.mockResolvedValue({ buffer: Buffer.from("image-bytes") });
  });

  it("returns bytes only after route, record, and transcript bindings pass", async () => {
    await expect(
      readManagedOutgoingImageDownloadUrl({
        url: "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full",
        expectedSessionKey: route.sessionKey,
        stateDir: "/state",
      }),
    ).resolves.toEqual({
      data: Buffer.from("image-bytes"),
      contentType: "image/png",
      sizeBytes: 11,
    });
  });

  it("rejects a route outside the requested session before reading state", async () => {
    await expect(
      readManagedOutgoingImageDownloadUrl({
        url: "/api/chat/media/outgoing/agent%3Amain%3Amain/id/full",
        expectedSessionKey: "agent:other:main",
      }),
    ).resolves.toBeNull();
    expect(mocks.readManagedImageRecord).not.toHaveBeenCalled();
  });

  it("rejects records no longer bound to the transcript", async () => {
    mocks.recordMatchesTranscriptMessage.mockResolvedValue(false);
    await expect(
      readManagedOutgoingImageDownloadUrl({
        url: "/api/chat/media/outgoing/agent%3Amain%3Amain/id/full",
        expectedSessionKey: route.sessionKey,
      }),
    ).resolves.toBeNull();
    expect(mocks.readLocalFileSafely).not.toHaveBeenCalled();
  });
});
