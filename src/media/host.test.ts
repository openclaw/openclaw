import fs from "node:fs/promises";
import type { Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveMediaSource: vi.fn(),
  getTailnetHostname: vi.fn(),
  ensurePortAvailable: vi.fn(),
  startMediaServer: vi.fn(),
  logInfo: vi.fn(),
}));
const { saveMediaSource, getTailnetHostname, ensurePortAvailable, startMediaServer, logInfo } =
  mocks;

vi.mock("./store.js", () => ({ saveMediaSource }));
vi.mock("../infra/tailscale.js", () => ({ getTailnetHostname }));
vi.mock("../infra/ports.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/ports.js")>("../infra/ports.js");
  return { ensurePortAvailable, PortInUseError: actual.PortInUseError };
});
vi.mock("./server.js", () => ({ startMediaServer }));
vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return { ...actual, logInfo };
});

const { ensureMediaHosted } = await import("./host.js");
const { PortInUseError } = await import("../infra/ports.js");

describe("ensureMediaHosted", () => {
  function mockSavedMedia(id: string, size: number) {
    saveMediaSource.mockResolvedValue({
      id,
      path: `/tmp/${id}`,
      size,
    });
  }

  async function expectHostedMediaCase(
    params:
      | {
          filePath: string;
          savedMedia: { id: string; size: number };
          tailnetHostname: string;
          startServer: boolean;
          expectedError: RegExp;
          expectedCleanupPath: string;
        }
      | {
          filePath: string;
          savedMedia: { id: string; size: number };
          tailnetHostname: string;
          port: number;
          startServer: boolean;
          ensurePortError?: Error;
          expectedUrl: string;
          expectServerStart: boolean;
        },
  ) {
    getTailnetHostname.mockResolvedValue(params.tailnetHostname);
    if ("expectedError" in params) {
      saveMediaSource.mockResolvedValue({
        id: params.savedMedia.id,
        path: params.filePath,
        size: params.savedMedia.size,
      });
      ensurePortAvailable.mockResolvedValue(undefined);
      const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);

      await expect(
        ensureMediaHosted(params.filePath, { startServer: params.startServer }),
      ).rejects.toThrow(params.expectedError);
      expect(rmSpy).toHaveBeenCalledWith(params.expectedCleanupPath);
      rmSpy.mockRestore();
      return;
    }

    mockSavedMedia(params.savedMedia.id, params.savedMedia.size);
    if (params.ensurePortError) {
      ensurePortAvailable.mockRejectedValue(params.ensurePortError);
    } else {
      ensurePortAvailable.mockResolvedValue(undefined);
      startMediaServer.mockResolvedValue({ unref: vi.fn() } as unknown as Server);
    }

    const result = await ensureMediaHosted(params.filePath, {
      startServer: params.startServer,
      port: params.port,
    });

    if (params.expectServerStart) {
      expect(startMediaServer).toHaveBeenCalledWith(
        params.port,
        expect.any(Number),
        expect.anything(),
      );
      expect(logInfo).toHaveBeenCalled();
    } else {
      expect(startMediaServer).not.toHaveBeenCalled();
    }
    expect(result).toEqual({
      url: params.expectedUrl,
      id: params.savedMedia.id,
      size: params.savedMedia.size,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "throws and cleans up when server not allowed to start",
      filePath: "/tmp/file1",
      savedMedia: { id: "id1", size: 5 },
      tailnetHostname: "tailnet-host",
      startServer: false,
      expectedError: /requires the webhook\/Funnel server/i,
      expectedCleanupPath: "/tmp/file1",
    },
    {
      name: "starts media server when allowed",
      filePath: "/tmp/id2",
      savedMedia: { id: "id2", size: 9 },
      tailnetHostname: "tail.net",
      port: 1234,
      startServer: true,
      expectedUrl: "https://tail.net/media/id2",
      expectServerStart: true,
    },
    {
      name: "skips server start when port already in use",
      filePath: "/tmp/id3",
      savedMedia: { id: "id3", size: 7 },
      tailnetHostname: "tail.net",
      port: 3000,
      startServer: false,
      ensurePortError: new PortInUseError(3000, "proc"),
      expectedUrl: "https://tail.net/media/id3",
      expectServerStart: false,
    },
  ] as const)("$name", async (testCase) => {
    await expectHostedMediaCase(testCase);
  });
});
