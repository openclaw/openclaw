import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const MEDIA_DIR = path.join(process.cwd(), "tmp-media-test");
const cleanOldMedia = vi.fn().mockResolvedValue(undefined);

vi.mock("./store.js", () => ({
  getMediaDir: () => MEDIA_DIR,
  cleanOldMedia,
}));

const { createMediaHandler } = await import("./server.js");

function createMockResponse() {
  let statusCode = 200;
  let body: string | Buffer | null = null;
  const headers = new Map<string, string>();
  const listeners = new Map<string, Array<() => void>>();

  const emit = (event: string) => {
    for (const handler of listeners.get(event) ?? []) handler();
  };

  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    type(value: string) {
      headers.set("content-type", value);
      return res;
    },
    send(payload: string | Buffer) {
      body = payload;
      queueMicrotask(() => emit("finish"));
    },
    on(event: string, handler: () => void) {
      const existing = listeners.get(event);
      if (existing) existing.push(handler);
      else listeners.set(event, [handler]);
    },
  };

  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    headers,
  };
}

async function requestMedia(id: string, ttlMs: number) {
  const handler = createMediaHandler({ ttlMs });
  const response = createMockResponse();
  await handler({ params: { id } }, response.res);
  return response;
}

const waitForFileRemoval = async (file: string, timeoutMs = 200) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.stat(file);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${file} removal`);
};

describe("media server", () => {
  beforeAll(async () => {
    await fs.rm(MEDIA_DIR, { recursive: true, force: true });
    await fs.mkdir(MEDIA_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(MEDIA_DIR, { recursive: true, force: true });
  });

  it("serves media and cleans up after send", async () => {
    const file = path.join(MEDIA_DIR, "file1");
    await fs.writeFile(file, "hello");
    const res = await requestMedia("file1", 5_000);
    expect(res.statusCode).toBe(200);
    expect(res.body?.toString()).toBe("hello");
    await waitForFileRemoval(file);
  });

  it("expires old media", async () => {
    const file = path.join(MEDIA_DIR, "old");
    await fs.writeFile(file, "stale");
    const past = Date.now() - 10_000;
    await fs.utimes(file, past / 1000, past / 1000);
    const res = await requestMedia("old", 1_000);
    expect(res.statusCode).toBe(410);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("blocks path traversal attempts", async () => {
    const res = await requestMedia("../package.json", 5_000);
    expect(res.statusCode).toBe(400);
    expect(res.body?.toString()).toBe("invalid path");
  });

  it("blocks symlink escaping outside media dir", async () => {
    const target = path.join(process.cwd(), "package.json"); // outside MEDIA_DIR
    const link = path.join(MEDIA_DIR, "link-out");
    await fs.symlink(target, link);

    const res = await requestMedia("link-out", 5_000);
    expect(res.statusCode).toBe(400);
    expect(res.body?.toString()).toBe("invalid path");
  });
});
