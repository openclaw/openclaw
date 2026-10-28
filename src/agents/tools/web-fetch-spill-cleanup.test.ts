import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privateTempFile from "../sessions/tools/private-temp-file.js";

const { fetchWithWebToolsNetworkGuardMock } = vi.hoisted(() => ({
  fetchWithWebToolsNetworkGuardMock: vi.fn(),
}));
// mock-isolation: exercise the real payload and private-file lifecycle with a controlled transport.
vi.mock("./web-guarded-fetch.js", () => ({
  fetchWithWebToolsNetworkGuard: fetchWithWebToolsNetworkGuardMock,
}));
import { createWebFetchTool } from "./web-fetch.js";

const spillPaths = new Set<string>();
function createContractTool(options: { maxChars: number }) {
  return createWebFetchTool({
    config: { tools: { web: { fetch: { cacheTtlMinutes: 0, ...options } } } },
    sandboxed: false,
  });
}

describe("web_fetch unpublished spill cleanup", () => {
  beforeEach(() => {
    fetchWithWebToolsNetworkGuardMock.mockReset();
  });
  afterEach(async () => {
    await Promise.all([...spillPaths].map(async (path) => await rm(path, { force: true })));
    spillPaths.clear();
    vi.restoreAllMocks();
  });

  it.each(["cancelled during spill write", "guard release failed"])(
    "removes an unpublished spill when %s",
    async (failure) => {
      const controller = new AbortController();
      const reason = new Error(failure);
      const writePrivateTempFile = privateTempFile.writePrivateTempFile;
      vi.spyOn(privateTempFile, "writePrivateTempFile").mockImplementation(async (...args) => {
        const filePath = await writePrivateTempFile(...args);
        spillPaths.add(filePath);
        if (failure === "cancelled during spill write") {
          controller.abort(reason);
        }
        return filePath;
      });
      fetchWithWebToolsNetworkGuardMock.mockResolvedValueOnce({
        response: new Response("web fetch content ".repeat(400), {
          headers: { "content-type": "text/plain" },
        }),
        finalUrl: "https://example.com/unpublished-spill",
        release: async () => {
          if (failure === "guard release failed") {
            throw reason;
          }
        },
      });
      const tool = createContractTool({ maxChars: 500 });
      await expect(
        tool?.execute("call", { url: "https://example.com/unpublished-spill" }, controller.signal),
      ).rejects.toBe(reason);
      expect(spillPaths.size).toBe(1);
      for (const filePath of spillPaths) {
        await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("removes private output when authority is refused after the physical write", async () => {
    const prefix = `web-fetch-post-write-${randomUUID()}`;
    const content = "unpublished private output";
    const reason = new Error("output authority revoked");
    let created: string | undefined;
    await expect(
      privateTempFile.writePrivateTempFile(prefix, content, {
        onCreated: () => {
          const name = readdirSync(tmpdir()).find((entry) => entry.startsWith(`${prefix}-`));
          expect(name).toBeDefined();
          created = join(tmpdir(), name!);
          spillPaths.add(created);
        },
        assertCurrent: () => {
          if (created && readFileSync(created, "utf8") === content) {
            throw reason;
          }
        },
      }),
    ).rejects.toBe(reason);
    expect(created).toBeDefined();
    await expect(readFile(created!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
