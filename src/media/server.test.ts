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

  async function ageMediaFile(filePath: string) {
    const past = Date.now() - 10_000;
    await fs.utimes(filePath, past / 1000, past / 1000);
  }

  async function expectMissingMediaFile(filePath: string) {
    await expect(fs.stat(filePath)).rejects.toThrow();
  }

  function expectFetchedResponse(
    response: Awaited<ReturnType<typeof realFetch>>,
    expected: { status: number; noSniff?: boolean },
  ) {
    expect(response.status).toBe(expected.status);
    if (expected.noSniff) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  }

  async function expectMediaFileLifecycleCase(params: {
    id: string;
    contents: string;
    expectedStatus: number;
    expectedBody?: string;
    mutateFile?: (filePath: string) => Promise<void>;
    assertAfterFetch?: (filePath: string) => Promise<void>;
  }) {
    const file = await writeMediaFile(params.id, params.contents);
    await params.mutateFile?.(file);
    const res = await realFetch(mediaUrl(params.id));
    expectFetchedResponse(res, { status: params.expectedStatus });
    if (params.expectedBody !== undefined) {
      expect(await res.text()).toBe(params.expectedBody);
    }
    await params.assertAfterFetch?.(file);
  }

  async function expectFetchedMediaCase(params: {
    mediaPath: string;
    expectedStatus: number;
    expectedBody?: string;
    expectedNoSniff?: boolean;
    setup?: () => Promise<void>;
  }) {
    await params.setup?.();
    const res = await realFetch(mediaUrl(params.mediaPath));
    expectFetchedResponse(res, {
      status: params.expectedStatus,
      ...(params.expectedNoSniff ? { noSniff: true } : {}),
    });
    if (params.expectedBody !== undefined) {
      expect(await res.text()).toBe(params.expectedBody);
    }
  }

  beforeAll(async () => {
    vi.useRealTimers();
    vi.doUnmock("undici");
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

  it.each([
    {
      name: "serves media and cleans up after send",
      id: "file1",
      contents: "hello",
      expectedStatus: 200,
      expectedBody: "hello",
      assertAfterFetch: async (filePath: string) => {
        await waitForFileRemoval(filePath);
      },
    },
    {
      name: "expires old media",
      id: "old",
      contents: "stale",
      expectedStatus: 410,
      mutateFile: ageMediaFile,
      assertAfterFetch: expectMissingMediaFile,
    },
  ] as const)("$name", async (testCase) => {
    await expectMediaFileLifecycleCase(testCase);
  });

  it.each([
    {
      testName: "blocks path traversal attempts",
      mediaPath: "%2e%2e%2fpackage.json",
      expectedStatus: 400,
      expectedBody: "invalid path",
    },
    {
      testName: "rejects invalid media ids",
      mediaPath: "invalid%20id",
      expectedStatus: 400,
      expectedBody: "invalid path",
      setup: async () => {
        await writeMediaFile("file2", "hello");
      },
    },
    {
      testName: "blocks symlink escaping outside media dir",
      mediaPath: "link-out",
      setup: async () => {
        const target = path.join(process.cwd(), "package.json"); // outside MEDIA_DIR
        const link = path.join(MEDIA_DIR, "link-out");
        await fs.symlink(target, link);
      },
      expectedStatus: 400,
      expectedBody: "invalid path",
    },
    {
      name: "rejects oversized media files",
      mediaPath: "big",
      expectedStatus: 413,
      expectedBody: "too large",
      setup: async () => {
        const file = await writeMediaFile("big", "");
        await fs.truncate(file, MEDIA_MAX_BYTES + 1);
      },
    },
    {
      name: "returns not found for missing media IDs",
      mediaPath: "missing-file",
      expectedStatus: 404,
      expectedBody: "not found",
      expectedNoSniff: true,
    },
    {
      name: "returns 404 when route param is missing (dot path)",
      mediaPath: ".",
      expectedStatus: 404,
    },
    {
      name: "rejects overlong media id",
      mediaPath: `${"a".repeat(201)}.txt`,
      expectedStatus: 400,
      expectedBody: "invalid path",
    },
  ] as const)("%#", async (testCase) => {
    await expectFetchedMediaCase(testCase);
  });
});
