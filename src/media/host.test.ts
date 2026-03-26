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

type CleanupCase = {
  name: string;
  filePath: string;
  savedMedia: { id: string; size: number };
  tailnetHostname?: string;
  tailnetError?: Error;
  port?: number;
  startServer: boolean;
  ensurePortError?: Error;
  startServerError?: Error;
  expectedError: RegExp | Error;
  expectedCleanupPath: string;
};

type SuccessCase = {
  name: string;
  filePath: string;
  savedMedia: { id: string; size: number };
  tailnetHostname: string;
  port: number;
  startServer: boolean;
  ensurePortError?: Error;
  expectedUrl: string;
  expectServerStart: boolean;
};

type HostedMediaCase = CleanupCase | SuccessCase;

describe("ensureMediaHosted", () => {
  function mockSavedMedia(id: string, size: number, path = `/tmp/${id}`) {
    saveMediaSource.mockResolvedValue({
      id,
      path,
      size,
    });
  }

  async function expectHostedMediaCase(params: HostedMediaCase) {
    mockSavedMedia(params.savedMedia.id, params.savedMedia.size, params.filePath);
    if ("tailnetError" in params && params.tailnetError) {
      getTailnetHostname.mockRejectedValue(params.tailnetError);
    } else {
      getTailnetHostname.mockResolvedValue(params.tailnetHostname);
    }

    if (params.ensurePortError) {
      ensurePortAvailable.mockRejectedValue(params.ensurePortError);
    } else {
      ensurePortAvailable.mockResolvedValue(undefined);
    }

    if ("expectedError" in params) {
      if (params.startServerError) {
        startMediaServer.mockRejectedValue(params.startServerError);
      } else {
        startMediaServer.mockResolvedValue({ unref: vi.fn() } as unknown as Server);
      }
      const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);

      await expect(
        ensureMediaHosted(params.filePath, { startServer: params.startServer, port: params.port }),
      ).rejects.toThrow(params.expectedError);
      expect(rmSpy).toHaveBeenCalledWith(params.expectedCleanupPath);
      rmSpy.mockRestore();
      return;
    }

    startMediaServer.mockResolvedValue({ unref: vi.fn() } as unknown as Server);

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
      name: "cleans up when hostname lookup fails after save",
      filePath: "/tmp/file-hostname",
      savedMedia: { id: "id-hostname", size: 5 },
      tailnetError: new Error("hostname lookup failed"),
      startServer: false,
      expectedError: /hostname lookup failed/,
      expectedCleanupPath: "/tmp/file-hostname",
    },
    {
      name: "cleans up when port check fails unexpectedly",
      filePath: "/tmp/file-port",
      savedMedia: { id: "id-port", size: 5 },
      tailnetHostname: "tail.net",
      startServer: false,
      ensurePortError: new Error("port check failed"),
      expectedError: /port check failed/,
      expectedCleanupPath: "/tmp/file-port",
    },
    {
      name: "cleans up when media server startup fails",
      filePath: "/tmp/file-start",
      savedMedia: { id: "id-start", size: 9 },
      tailnetHostname: "tail.net",
      port: 1234,
      startServer: true,
      startServerError: new Error("startup failed"),
      expectedError: /startup failed/,
      expectedCleanupPath: "/tmp/file-start",
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
  ] satisfies HostedMediaCase[])("$name", async (testCase) => {
    await expectHostedMediaCase(testCase);
  });
});
