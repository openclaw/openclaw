import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let MEDIA_DIR = "";
const cleanOldMedia = vi.fn().mockResolvedValue(undefined);

vi.mock("./store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.js")>();
  return {
    ...actual,
    getMediaDir: () => MEDIA_DIR,
    cleanOldMedia,
  };
});

const { startMediaServer } = await import("./server.js");
const { MEDIA_MAX_BYTES } = await import("./store.js");

async function waitForFileRemoval(filePath: string, maxTicks = 1000) {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    try {
      await fs.stat(filePath);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${filePath} removal`);
}

describe("media server", () => {
  let server: Awaited<ReturnType<typeof startMediaServer>>;
  let port = 0;

  beforeAll(async () => {
    MEDIA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-test-"));
    server = await startMediaServer(0, 1_000);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(MEDIA_DIR, { recursive: true, force: true });
    MEDIA_DIR = "";
  });

  it("serves media and cleans up after send", async () => {
    const file = path.join(MEDIA_DIR, "file1");
    await fs.writeFile(file, "hello");
    const res = await fetch(`http://127.0.0.1:${port}/media/file1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    await waitForFileRemoval(file);
  });

  it("expires old media", async () => {
    const file = path.join(MEDIA_DIR, "old");
    await fs.writeFile(file, "stale");
    const past = Date.now() - 10_000;
    await fs.utimes(file, past / 1000, past / 1000);
    const res = await fetch(`http://127.0.0.1:${port}/media/old`);
    expect(res.status).toBe(410);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("blocks path traversal attempts", async () => {
    // URL-encoded "../" to bypass client-side path normalization
    const res = await fetch(`http://127.0.0.1:${port}/media/%2e%2e%2fpackage.json`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid path");
  });

  it("blocks symlink escaping outside media dir", async () => {
    const target = path.join(process.cwd(), "package.json"); // outside MEDIA_DIR
    const link = path.join(MEDIA_DIR, "link-out");
    await fs.symlink(target, link);

    const res = await fetch(`http://127.0.0.1:${port}/media/link-out`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid path");
  });

  it("rejects invalid media ids", async () => {
    const file = path.join(MEDIA_DIR, "file2");
    await fs.writeFile(file, "hello");
    const res = await fetch(`http://127.0.0.1:${port}/media/invalid%20id`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid path");
  });

  it("rejects oversized media files", async () => {
    const file = path.join(MEDIA_DIR, "big");
    await fs.writeFile(file, "");
    await fs.truncate(file, MEDIA_MAX_BYTES + 1);
    const res = await fetch(`http://127.0.0.1:${port}/media/big`);
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("too large");
  });
});
