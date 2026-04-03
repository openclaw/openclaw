import fs from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFileWithinRoot: vi.fn(),
  cleanOldMedia: vi.fn().mockResolvedValue(undefined),
}));

let mediaDir = "";

vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  return {
    ...actual,
    readFileWithinRoot: mocks.readFileWithinRoot,
  };
});

vi.mock("./store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.js")>();
  return {
    ...actual,
    getMediaDir: () => mediaDir,
    cleanOldMedia: mocks.cleanOldMedia,
  };
});

let SafeOpenError: typeof import("../infra/fs-safe.js").SafeOpenError;
let startMediaServer: typeof import("./server.js").startMediaServer;
let realFetch: typeof import("undici").fetch;

async function expectOutsideWorkspaceServerResponse(url: string) {
  const response = await realFetch(url);
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
    ({ SafeOpenError } = await import("../infra/fs-safe.js"));
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
    mocks.readFileWithinRoot.mockRejectedValueOnce(
      new SafeOpenError("outside-workspace", "file is outside workspace root"),
    );

    await expectOutsideWorkspaceServerResponse(`http://127.0.0.1:${port}/media/ok-id`);
  });
});
