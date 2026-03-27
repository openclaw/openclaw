import fs from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
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

let startMediaServer: typeof import("./server.js").startMediaServer;
let MEDIA_MAX_BYTES: typeof import("./store.js").MEDIA_MAX_BYTES;
let realFetch: typeof import("undici").fetch;

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

  function mediaUrl(id: string) {
    return `http://127.0.0.1:${port}/media/${id}`;
  }

  async function writeMediaFile(id: string, contents: string) {
    const filePath = path.join(MEDIA_DIR, id);
    await fs.writeFile(filePath, contents);
    return filePath;
  }

  beforeAll(async () => {
    vi.useRealTimers();
    vi.doUnmock("undici");
    vi.resetModules();
    const require = createRequire(import.meta.url);
    ({ startMediaServer } = await import("./server.js"));
    ({ MEDIA_MAX_BYTES } = await import("./store.js"));
    ({ fetch: realFetch } = require("undici") as typeof import("undici"));
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
    const file = await writeMediaFile("file1", "hello");
    const res = await realFetch(mediaUrl("file1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("hello");
    await waitForFileRemoval(file);
  });

  it("expires old media", async () => {
    const file = await writeMediaFile("old", "stale");
    const past = Date.now() - 10_000;
    await fs.utimes(file, past / 1000, past / 1000);
    const res = await realFetch(mediaUrl("old"));
    expect(res.status).toBe(410);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("blocks path traversal attempts", async () => {
    const res = await realFetch(mediaUrl("%2e%2e%2fpackage.json"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid path");
  });

  it("rejects invalid media ids", async () => {
    await writeMediaFile("file2", "hello");
    const res = await realFetch(mediaUrl("invalid%20id"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid path");
  });

  it.runIf(process.platform !== "win32")("blocks symlink escaping outside media dir", async () => {
    const target = path.join(process.cwd(), "package.json"); // outside MEDIA_DIR
    const link = path.join(MEDIA_DIR, "link-out");
    await fs.symlink(target, link, "file");

    const res = await realFetch(mediaUrl("link-out"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid path");
  });

  it("rejects oversized media files", async () => {
    const file = await writeMediaFile("big", "");
    await fs.truncate(file, MEDIA_MAX_BYTES + 1);
    const res = await realFetch(mediaUrl("big"));
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("too large");
  });

  it("returns not found for missing media IDs", async () => {
    const res = await realFetch(mediaUrl("missing-file"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("not found");
  });

  it("returns 404 when route param is missing (dot path)", async () => {
    const res = await realFetch(mediaUrl("."));
    expect(res.status).toBe(404);
  });

  it("rejects overlong media id", async () => {
    const res = await realFetch(mediaUrl(`${"a".repeat(201)}.txt`));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid path");
  });
});
