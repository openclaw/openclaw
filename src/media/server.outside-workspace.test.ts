import fs from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  readFileWithinRoot: vi.fn(),
  cleanOldMedia: vi.fn().mockResolvedValue(undefined),
  isSafeOpenError: vi.fn(
    (error: unknown) => typeof error === "object" && error !== null && "code" in error,
  ),
}));

let mediaDir = "";

vi.mock("./server.runtime.js", () => {
  return {
    MEDIA_MAX_BYTES: 5 * 1024 * 1024,
    readFileWithinRoot: mocks.readFileWithinRoot,
    isSafeOpenError: mocks.isSafeOpenError,
    getMediaDir: () => mediaDir,
    cleanOldMedia: mocks.cleanOldMedia,
  };
});

let startMediaServer: typeof import("./server.js").startMediaServer;
let realFetch: typeof import("undici").fetch;
const LOOPBACK_FETCH_ENV = {
  HTTP_PROXY: undefined,
  HTTPS_PROXY: undefined,
  ALL_PROXY: undefined,
  http_proxy: undefined,
  https_proxy: undefined,
  all_proxy: undefined,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
} as const;

async function expectOutsideWorkspaceServerResponse(url: string) {
  const response = await withEnvAsync(LOOPBACK_FETCH_ENV, () => realFetch(url));
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("file is outside workspace root");
}

describe("media server outside-workspace mapping", () => {
  let server: Awaited<ReturnType<typeof startMediaServer>> | undefined;
  let listenBlocked = false;
  let port = 0;

  beforeAll(async () => {
    vi.useRealTimers();
    vi.doUnmock("undici");
    const require = createRequire(import.meta.url);
    ({ startMediaServer } = await import("./server.js"));
    ({ fetch: realFetch } = require("undici") as typeof import("undici"));
    mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-outside-workspace-"));
    try {
      server = await startMediaServer(0, 1_000);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        listenBlocked = true;
        return;
      }
      throw error;
    }
    const boundServer = server;
    if (!boundServer) {
      return;
    }
    port = (boundServer.address() as AddressInfo).port;
  });

  beforeEach(() => {
    mocks.readFileWithinRoot.mockReset();
    mocks.cleanOldMedia.mockClear();
  });

  afterAll(async () => {
    const boundServer = server;
    if (boundServer) {
      await new Promise((resolve) => boundServer.close(resolve));
    }
    await fs.rm(mediaDir, { recursive: true, force: true });
    mediaDir = "";
  });

  it("returns 400 with a specific outside-workspace message", async () => {
    if (listenBlocked) {
      return;
    }
    mocks.readFileWithinRoot.mockRejectedValueOnce({
      code: "outside-workspace",
      message: "file is outside workspace root",
    });

    await expectOutsideWorkspaceServerResponse(`http://127.0.0.1:${port}/media/ok-id`);
  });
});
