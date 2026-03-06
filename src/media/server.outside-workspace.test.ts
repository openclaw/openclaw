import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const { SafeOpenError } = await import("../infra/fs-safe.js");
const { startMediaServer } = await import("./server.js");

describe("media server outside-workspace mapping", () => {
  let server: Awaited<ReturnType<typeof startMediaServer>>;
  let port = 0;

  beforeAll(async () => {
    mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-outside-workspace-"));
    server = await startMediaServer(0, 1_000);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(mediaDir, { recursive: true, force: true });
    mediaDir = "";
  });

  it("returns 400 with a specific outside-workspace message", async () => {
    mocks.readFileWithinRoot.mockRejectedValueOnce(
      new SafeOpenError("outside-workspace", "file is outside workspace root"),
    );

    const response = await fetch(`http://127.0.0.1:${port}/media/ok-id`);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("file is outside workspace root");
  });
});
